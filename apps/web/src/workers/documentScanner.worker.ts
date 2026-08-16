/// <reference lib="webworker" />

type Point = { x: number; y: number };

type WorkerRequest =
    | { type: 'init'; opencvUrl: string }
    | {
          type: 'process';
          frameId: number;
          width: number;
          height: number;
          rgbaBuffer: ArrayBuffer;
          minAreaRatio: number;
          /** Min interior content density to accept the quad as a real ID/passport.
           *  Lower for the back side (backs can be sparse). */
          minInteriorDensity: number;
      }
    | {
          type: 'capture';
          requestId: number;
          width: number;
          height: number;
          rgbaBuffer: ArrayBuffer;
          corners: [Point, Point, Point, Point];
          jpegQuality: number;
          maxOutputWidth: number | null;
      };

type ProcessResponse =
    | { type: 'ready' }
    | {
          type: 'processResult';
          frameId: number;
          detected: false;
      }
    | {
          type: 'processResult';
          frameId: number;
          detected: true;
          corners: [Point, Point, Point, Point];
      }
    | {
          type: 'captureResult';
          requestId: number;
          imageDataUrl: string | null;
          error?: string;
      }
    | {
          type: 'error';
          error: string;
      };

type OpenCvNamespace = {
    onRuntimeInitialized?: () => void;
    Mat: new (...args: unknown[]) => OpenCvMat;
    MatVector: new () => OpenCvMatVector;
    Size: new (width: number, height: number) => OpenCvSize;
    Scalar: new (v0?: number, v1?: number, v2?: number, v3?: number) => OpenCvScalar;
    Point: new (x: number, y: number) => OpenCvPoint;
    matFromArray: (rows: number, cols: number, type: number, arr: number[]) => OpenCvMat;
    cvtColor: (src: OpenCvMat, dst: OpenCvMat, code: number) => void;
    GaussianBlur: (
        src: OpenCvMat,
        dst: OpenCvMat,
        ksize: OpenCvSize,
        sigmaX: number,
        sigmaY: number,
        borderType: number,
    ) => void;
    Canny: (
        src: OpenCvMat,
        dst: OpenCvMat,
        threshold1: number,
        threshold2: number,
        apertureSize?: number,
        L2gradient?: boolean,
    ) => void;
    getStructuringElement: (shape: number, ksize: OpenCvSize) => OpenCvMat;
    dilate: (
        src: OpenCvMat,
        dst: OpenCvMat,
        kernel: OpenCvMat,
        anchor: OpenCvPoint,
        iterations: number,
    ) => void;
    findContours: (
        image: OpenCvMat,
        contours: OpenCvMatVector,
        hierarchy: OpenCvMat,
        mode: number,
        method: number,
    ) => void;
    contourArea: (contour: OpenCvMat, oriented?: boolean) => number;
    arcLength: (curve: OpenCvMat, closed: boolean) => number;
    approxPolyDP: (
        curve: OpenCvMat,
        approxCurve: OpenCvMat,
        epsilon: number,
        closed: boolean,
    ) => void;
    isContourConvex: (contour: OpenCvMat) => boolean;
    getPerspectiveTransform: (src: OpenCvMat, dst: OpenCvMat) => OpenCvMat;
    warpPerspective: (
        src: OpenCvMat,
        dst: OpenCvMat,
        m: OpenCvMat,
        dsize: OpenCvSize,
        flags?: number,
        borderMode?: number,
        borderValue?: OpenCvScalar,
    ) => void;
    COLOR_RGBA2GRAY: number;
    COLOR_RGBA2RGB: number;
    COLOR_RGB2RGBA: number;
    CV_8UC4: number;
    CV_32FC2: number;
    RETR_LIST: number;
    CHAIN_APPROX_SIMPLE: number;
    MORPH_RECT: number;
    INTER_LINEAR: number;
    BORDER_REPLICATE: number;
    BORDER_DEFAULT: number;
    bilateralFilter: (
        src: OpenCvMat,
        dst: OpenCvMat,
        d: number,
        sigmaColor: number,
        sigmaSpace: number,
        borderType?: number,
    ) => void;
    convertScaleAbs: (src: OpenCvMat, dst: OpenCvMat, alpha?: number, beta?: number) => void;
};

type OpenCvMat = {
    rows: number;
    cols: number;
    data: Uint8Array;
    data32S: Int32Array;
    delete: () => void;
};

type OpenCvMatVector = {
    size: () => number;
    get: (index: number) => OpenCvMat;
    delete: () => void;
};

type OpenCvSize = unknown;
type OpenCvPoint = unknown;
type OpenCvScalar = unknown;

let cv: OpenCvNamespace | null = null;
let cvReadyPromise: Promise<void> | null = null;

function postMessageSafe(message: ProcessResponse): void {
    postMessage(message);
}

function ensureCvReady(opencvUrl: string): Promise<void> {
    if (cvReadyPromise) return cvReadyPromise;

    cvReadyPromise = new Promise<void>((resolve, reject) => {
        try {
            importScripts(opencvUrl);
            const maybeCv = (self as unknown as { cv?: OpenCvNamespace }).cv;
            if (!maybeCv) {
                reject(new Error('OpenCV failed to load in worker.'));
                return;
            }

            cv = maybeCv;
            if (typeof cv.onRuntimeInitialized === 'function') {
                const prev = cv.onRuntimeInitialized;
                cv.onRuntimeInitialized = () => {
                    prev();
                    resolve();
                };
            } else {
                resolve();
            }
        } catch (error) {
            reject(error instanceof Error ? error : new Error('Failed to initialize OpenCV.'));
        }
    });

    return cvReadyPromise;
}

function orderCorners(points: Point[]): [Point, Point, Point, Point] {
    const sums = points.map((p) => p.x + p.y);
    const diffs = points.map((p) => p.x - p.y);

    const topLeft = points[sums.indexOf(Math.min(...sums))];
    const bottomRight = points[sums.indexOf(Math.max(...sums))];
    const topRight = points[diffs.indexOf(Math.max(...diffs))];
    const bottomLeft = points[diffs.indexOf(Math.min(...diffs))];

    return [topLeft, topRight, bottomRight, bottomLeft];
}

// ── Card-shape selection constants ───────────────────────────────────────────
// An ID-1 card is 85.6 × 54 mm → 1.586:1; a passport (open) ≈ 1.42:1. When the
// card is held at an angle the *apparent* aspect of the detected quad shrinks,
// so the accepted band is deliberately wider than the physical ratio.
//
// Why this matters: a laptop's fixed wide-FOV webcam frames the whole desk, so
// the LARGEST 4-corner quad is frequently a monitor / window / book / keyboard,
// not the ID — and those are perfectly still, so they auto-capture instantly.
// Scoring by card-likeness (aspect + centeredness, weighted by area) instead of
// raw area keeps the real ID winning on laptops while not regressing phones
// (where the ID already dominates the frame).
const CARD_ASPECT_MIN = 1.2;
const CARD_ASPECT_MAX = 2.05;
const CARD_ASPECT_IDEAL = 1.55;
const CARD_ASPECT_TOL = 0.5;

/**
 * Card-likeness score for an ordered quad, or null when its aspect ratio isn't
 * card-shaped. Higher = larger, closer to an ID aspect, nearer the frame centre.
 */
function scoreCardQuad(
    ordered: [Point, Point, Point, Point],
    width: number,
    height: number,
    area: number,
): number | null {
    const [tl, tr, br, bl] = ordered;
    const wAvg = (distance(tl, tr) + distance(bl, br)) / 2;
    const hAvg = (distance(tl, bl) + distance(tr, br)) / 2;
    const longSide = Math.max(wAvg, hAvg);
    const shortSide = Math.min(wAvg, hAvg);
    const aspect = shortSide > 0 ? longSide / shortSide : 0;

    // Reject anything that isn't card-shaped (keyboards, windows, portrait
    // paper, square frames, etc.).
    if (aspect < CARD_ASPECT_MIN || aspect > CARD_ASPECT_MAX) return null;

    const areaNorm = area / (width * height);
    const aspectErr = Math.min(1, Math.abs(aspect - CARD_ASPECT_IDEAL) / CARD_ASPECT_TOL);
    const cx = (tl.x + tr.x + br.x + bl.x) / 4;
    const cy = (tl.y + tr.y + br.y + bl.y) / 4;
    const centerErr = Math.min(1, Math.hypot(cx - width / 2, cy - height / 2) / (Math.hypot(width, height) / 2));
    return areaNorm * (1 - 0.7 * aspectErr) * (1 - 0.3 * centerErr);
}

/**
 * One detection pass: blur → Canny → dilate → contours → pick the best card-
 * shaped 4-corner convex quad. This is the original (working) algorithm; the
 * Canny thresholds are passed in so a low-contrast retry can use lower values.
 */
function detectCardQuadPass(
    gray: OpenCvMat,
    width: number,
    height: number,
    minArea: number,
    maxArea: number,
    cannyLow: number,
    cannyHigh: number,
): [Point, Point, Point, Point] | null {
    if (!cv) return null;
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const dilated = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    let bestScore = 0;
    let best: [Point, Point, Point, Point] | null = null;
    try {
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, 0);
        cv.Canny(blurred, edges, cannyLow, cannyHigh, 3, false);
        cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);
        cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i += 1) {
            const contour = contours.get(i);
            const approx = new cv.Mat();
            try {
                const area = cv.contourArea(contour, false);
                if (area < minArea || area > maxArea) continue;
                const perimeter = cv.arcLength(contour, true);
                cv.approxPolyDP(contour, approx, 0.035 * perimeter, true);
                if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;

                const points: Point[] = [];
                const raw = approx.data32S;
                for (let p = 0; p < 4; p += 1) {
                    points.push({ x: raw[p * 2], y: raw[p * 2 + 1] });
                }
                const ordered = orderCorners(points);
                const score = scoreCardQuad(ordered, width, height, area);
                if (score !== null && score > bestScore) {
                    bestScore = score;
                    best = ordered;
                }
            } finally {
                contour.delete();
                approx.delete();
            }
        }
        return best;
    } finally {
        blurred.delete();
        edges.delete();
        dilated.delete();
        contours.delete();
        hierarchy.delete();
        kernel.delete();
    }
}

// Below this interior luminance spread (std-dev) the region is effectively
// uniform — a blank sheet — and is rejected outright regardless of lighting.
const INTERIOR_MIN_CONTRAST = 6;
// The "busy pixel" gradient floor scales with the interior's own contrast so the
// measure is lighting-invariant (a dim ID and a bright ID score alike). Clamped.
const INTERIOR_FLOOR_K = 0.5;
const INTERIOR_FLOOR_MIN = 14;
const INTERIOR_FLOOR_MAX = 40;

/**
 * Lighting-normalized interior "busyness" of the quad, [0..1]. Text/photo create
 * strong local gradients; a blank page is uniform. We sample the quad's interior
 * (inset so the card border doesn't count), derive a gradient floor from the
 * region's OWN contrast (so dim and bright IDs score the same), and return the
 * fraction of pixels above that floor. A near-uniform region returns 0.
 */
function interiorContentScore(
    grayData: Uint8Array,
    width: number,
    height: number,
    quad: [Point, Point, Point, Point],
): number {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    // Inset 18% so the printed border / card edge is excluded from the sample.
    const minX = Math.max(1, Math.floor(Math.min(...xs) + bw * 0.18));
    const maxX = Math.min(width - 2, Math.ceil(Math.max(...xs) - bw * 0.18));
    const minY = Math.max(1, Math.floor(Math.min(...ys) + bh * 0.18));
    const maxY = Math.min(height - 2, Math.ceil(Math.max(...ys) - bh * 0.18));
    if (maxX <= minX || maxY <= minY) return 0;

    // Pass 1 — interior luminance contrast (Welford std-dev) for lighting
    // normalization. Subsample every 2px to keep it cheap.
    let n = 0;
    let mean = 0;
    let m2 = 0;
    for (let y = minY; y <= maxY; y += 2) {
        const row = y * width;
        for (let x = minX; x <= maxX; x += 2) {
            const v = grayData[row + x];
            n += 1;
            const d = v - mean;
            mean += d / n;
            m2 += d * (v - mean);
        }
    }
    const stddev = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
    // Uniform region (blank paper) → reject regardless of brightness.
    if (stddev < INTERIOR_MIN_CONTRAST) return 0;

    // Adaptive, lighting-invariant gradient floor.
    const floor = Math.min(INTERIOR_FLOOR_MAX, Math.max(INTERIOR_FLOOR_MIN, INTERIOR_FLOOR_K * stddev));

    // Pass 2 — fraction of interior pixels whose gradient exceeds the floor.
    let total = 0;
    let busy = 0;
    for (let y = minY; y <= maxY; y += 2) {
        const row = y * width;
        for (let x = minX; x <= maxX; x += 2) {
            const i = row + x;
            const gx = Math.abs(grayData[i + 1] - grayData[i - 1]);
            const gy = Math.abs(grayData[i + width] - grayData[i - width]);
            if (gx + gy > floor) busy += 1;
            total += 1;
        }
    }
    return total > 0 ? busy / total : 0;
}

function largestQuadFromFrame(
    width: number,
    height: number,
    rgbaBuffer: ArrayBuffer,
    minAreaRatio: number,
    minInteriorDensity: number,
): [Point, Point, Point, Point] | null {
    if (!cv) return null;

    const rgba = new cv.Mat(height, width, cv.CV_8UC4);
    const gray = new cv.Mat();
    try {
        rgba.data.set(new Uint8Array(rgbaBuffer));
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);

        const minArea = width * height * minAreaRatio;
        const maxArea = width * height * 0.95;

        // Stable single-pass detection (the original, non-jumpy algorithm): pick
        // the best card-shaped 4-corner convex quad by aspect + centeredness.
        let best = detectCardQuadPass(gray, width, height, minArea, maxArea, 30, 120);

        // Reject the full-frame border (≥3 corners hug the edge) but allow a card
        // whose corner is slightly cut off (≤2 corners at the boundary).
        if (best) {
            const margin = 5;
            const nearEdge = best.filter(
                (p) =>
                    p.x < margin || p.y < margin || p.x > width - margin || p.y > height - margin,
            ).length;
            if (nearEdge >= 3) {
                best = null;
            }
        }

        // CONTENT GATE — lock onto a REAL ID/passport, ignore a blank sheet (or any
        // empty rectangle): the interior must be busy with text/photo. The
        // threshold is lighting-normalized and passed per side (lower for backs,
        // which can be sparse).
        if (best) {
            const density = interiorContentScore(gray.data, width, height, best);
            if (density < minInteriorDensity) {
                best = null;
            }
        }

        return best;
    } finally {
        rgba.delete();
        gray.delete();
    }
}

function distance(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
}
async function dewarpCapture(
    width: number,
    height: number,
    rgbaBuffer: ArrayBuffer,
    corners: [Point, Point, Point, Point],
    jpegQuality: number,
    maxOutputWidth: number | null,
): Promise<string | null> {
    if (!cv) return null;

    const src = new cv.Mat(height, width, cv.CV_8UC4);
    const [tl, tr, br, bl] = corners;

    const topWidth = distance(tl, tr);
    const bottomWidth = distance(bl, br);
    const leftHeight = distance(tl, bl);
    const rightHeight = distance(tr, br);

    let outputWidth = Math.max(1, Math.round(Math.max(topWidth, bottomWidth)));
    let outputHeight = Math.max(1, Math.round(Math.max(leftHeight, rightHeight)));

    if (maxOutputWidth && outputWidth > maxOutputWidth) {
        const scale = maxOutputWidth / outputWidth;
        outputWidth = Math.max(1, Math.round(outputWidth * scale));
        outputHeight = Math.max(1, Math.round(outputHeight * scale));
    }

    const srcQuad = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x,
        tl.y,
        tr.x,
        tr.y,
        br.x,
        br.y,
        bl.x,
        bl.y,
    ]);
    const dstQuad = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        outputWidth - 1,
        0,
        outputWidth - 1,
        outputHeight - 1,
        0,
        outputHeight - 1,
    ]);

    const matrix = cv.getPerspectiveTransform(srcQuad, dstQuad);
    const dst = new cv.Mat();

    try {
        src.data.set(new Uint8Array(rgbaBuffer));

        // قص الصورة وتسويتها (Dewarping)
        cv.warpPerspective(
            src,
            dst,
            matrix,
            new cv.Size(outputWidth, outputHeight),
            cv.INTER_LINEAR,
            cv.BORDER_REPLICATE,
            new cv.Scalar(0, 0, 0, 255),
        );

        // ── لا فلاتر ولا زيادة سطوع (نستخدم الصورة الطبيعية كما لقطتها الكاميرا) ──
        const canvas = new OffscreenCanvas(outputWidth, outputHeight);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        const imageData = new ImageData(
            new Uint8ClampedArray(dst.data), // أخذنا البيكسلات الخام مباشرة!
            outputWidth,
            outputHeight,
        );
        ctx.putImageData(imageData, 0, 0);

        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality });
        const reader = new FileReaderSync();
        return reader.readAsDataURL(blob);
    } finally {
        // تنظيف الذاكرة (حذفنا المتغيرات القديمة اللي بطلنا نستخدمها)
        src.delete();
        srcQuad.delete();
        dstQuad.delete();
        matrix.delete();
        dst.delete();
    }
}

addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
    const data = event.data;

    try {
        if (data.type === 'init') {
            await ensureCvReady(data.opencvUrl);
            postMessageSafe({ type: 'ready' });
            return;
        }

        if (!cv) {
            postMessageSafe({ type: 'error', error: 'OpenCV worker is not initialized.' });
            return;
        }

        if (data.type === 'process') {
            const corners = largestQuadFromFrame(
                data.width,
                data.height,
                data.rgbaBuffer,
                data.minAreaRatio,
                data.minInteriorDensity,
            );

            if (!corners) {
                postMessageSafe({
                    type: 'processResult',
                    frameId: data.frameId,
                    detected: false,
                });
                return;
            }

            postMessageSafe({
                type: 'processResult',
                frameId: data.frameId,
                detected: true,
                corners,
            });
            return;
        }

        if (data.type === 'capture') {
            const imageDataUrl = await dewarpCapture(
                data.width,
                data.height,
                data.rgbaBuffer,
                data.corners,
                data.jpegQuality,
                data.maxOutputWidth,
            );
            postMessageSafe({ type: 'captureResult', requestId: data.requestId, imageDataUrl });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown worker error';

        if (data.type === 'capture') {
            postMessageSafe({
                type: 'captureResult',
                requestId: data.requestId,
                imageDataUrl: null,
                error: message,
            });
            return;
        }

        postMessageSafe({ type: 'error', error: message });
    }
});

export {};
