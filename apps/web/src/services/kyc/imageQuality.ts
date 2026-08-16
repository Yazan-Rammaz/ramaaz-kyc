import { idConfig } from '@ramaaz/kyc-shared/config';

/**
 * Lightweight, no-dependency image quality utilities for the client side.
 * Used by the ID auto-capture flow (and reusable for any other camera
 * screen) to gate AWS calls behind cheap perceptual checks.
 *
 * Constitution-compliant: pure Canvas API + math, no ML, no WebAssembly.
 */

export interface QualityScore {
    /** Mean perceived luminance, 0..255. */
    brightness: number;
    /** Variance of a Sobel-style edge magnitude, ≥ 0. Higher = sharper. */
    sharpness: number;
    /** True only when both brightness and sharpness clear their thresholds. */
    pass: boolean;
    /** Why we rejected this frame, if we did. */
    reason?: 'too_dark' | 'too_bright' | 'too_blurry';
}

export interface QualityThresholds {
    minBrightness: number;
    maxBrightness: number;
    minSharpness: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
    minBrightness: idConfig.quality.minBrightness,
    maxBrightness: idConfig.quality.maxBrightness,
    minSharpness: idConfig.quality.minSharpness,
};

/**
 * Downsamples the source canvas into a small offscreen canvas (default
 * 96px wide, aspect-preserved) so all subsequent passes are cheap. Returns
 * the resulting `ImageData` plus its dimensions.
 */
export function getDownsampledImageData(
    source: HTMLCanvasElement | HTMLVideoElement,
    targetWidth = 96,
): ImageData | null {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sw || !sh) return null;

    const ratio = sh / sw;
    const w = Math.max(16, Math.min(targetWidth, sw));
    const h = Math.max(16, Math.round(w * ratio));

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
}

/** Standard luma weights (Rec. 601). */
function luma(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Mean luminance of the frame. */
export function computeBrightness(img: ImageData): number {
    const d = img.data;
    let sum = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
        sum += luma(d[i], d[i + 1], d[i + 2]);
    }
    return sum / n;
}

/**
 * Variance of a Sobel-style edge magnitude — a cheap, constitution-friendly
 * proxy for image sharpness. Sharper frames have higher edge contrast and
 * therefore higher variance. Operates on a luminance plane built from the
 * already-downsampled `ImageData`, so the cost is O(w*h) on a ≤96px grid.
 */
export function computeSharpness(img: ImageData): number {
    const w = img.width;
    const h = img.height;
    const d = img.data;

    // Build a luminance plane.
    const L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            L[y * w + x] = luma(d[i], d[i + 1], d[i + 2]);
        }
    }

    // Sobel 3×3 → magnitude, accumulate mean & M2 for variance (Welford).
    let n = 0;
    let mean = 0;
    let m2 = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const tl = L[(y - 1) * w + (x - 1)];
            const t = L[(y - 1) * w + x];
            const tr = L[(y - 1) * w + (x + 1)];
            const l = L[y * w + (x - 1)];
            const r = L[y * w + (x + 1)];
            const bl = L[(y + 1) * w + (x - 1)];
            const b = L[(y + 1) * w + x];
            const br = L[(y + 1) * w + (x + 1)];

            const gx = -tl - 2 * l - bl + tr + 2 * r + br;
            const gy = -tl - 2 * t - tr + bl + 2 * b + br;
            const mag = Math.sqrt(gx * gx + gy * gy);

            n++;
            const delta = mag - mean;
            mean += delta / n;
            m2 += delta * (mag - mean);
        }
    }

    return n > 1 ? m2 / (n - 1) : 0;
}

// ── Additional constants ──────────────────────────────────────────────────────

/** Luma value above which a pixel is considered a "blown-out" glare spot. */
const GLARE_PIXEL_THRESHOLD = idConfig.quality.glarePixelThreshold;
const GLARE_MAX_RATIO = idConfig.quality.glareMaxRatio;
const MOTION_MAX_DIFF = idConfig.quality.motionMaxDiff;

/**
 * Required ratio of center-ROI edge density to outer-ring edge density.
 * A government ID card fills the frame center with text / barcodes / artwork,
 * producing noticeably more Sobel energy there than in the background.
 *
 * Deliberately lenient (1.1) so real-world backgrounds (tables, fabric) don't
 * over-inflate outerMean and cause false-negatives.
 */

// ── Card-presence: directional edge analysis ──────────────────────────────────
//
// Why pure edge-density fails on faces
// ─────────────────────────────────────
// Human faces have many edges (eyes, brow, nose, lips, hair). Any absolute
// centerMean floor or centre/outer density ratio is easily tricked by a face.
//
// Why directional analysis works
// ───────────────────────────────
// ID cards are built from axis-aligned geometry:
//   • Printed text strokes → horizontal bars and vertical stems → |Gx| >> |Gy|
//     or |Gy| >> |Gx| (one axis dominates)
//   • Card border, table lines, barcodes → pure H or V edges
//   • Security holograms / photo → contributes some diagonal, but overall the
//     card is dominated by H/V structure
//
// Human faces are curved:
//   • Eye socket contours, nostril curves, lip arcs, hairline → the Sobel
//     gradient is spread across both axes (|Gx| ≈ |Gy|) — i.e., diagonal
//
// Metric: for every "significant" edge pixel (magnitude > EDGE_MAG_FLOOR), we
// classify it as axis-aligned if ONE gradient axis strongly dominates the
// other:
//     min(|Gx|, |Gy|) / max(|Gx|, |Gy|) < AXIS_DIAGONALITY_MAX
// This corresponds to the edge being within ~24° of horizontal or vertical.
//
// For random-angle edges the baseline axis-aligned fraction is ≈ 53 %.
// Cards should reach 62–75 %. Faces land at 42–52 %.
// The threshold is set at 0.57 — comfortably between the two populations.

/** Minimum Sobel magnitude to count a pixel as a "significant edge". */
const EDGE_MAG_FLOOR = idConfig.cardDetection.edgeMagFloor;

/**
 * Minimum number of significant edge pixels that must exist inside the centre
 * ROI before the HV-fraction test is meaningful.
 * 30 pixels on a 96px-wide downsampled image ≈ ~2 % of the ROI area —
 * a card fills the viewfinder, so this should always be met when one is present.
 * A near-empty frame (desk surface, sky) rarely exceeds this.
 */
const CARD_MIN_SIGNIFICANT_EDGES = idConfig.cardDetection.cardMinSignificantEdges;

/**
 * An edge pixel is axis-aligned when its *less dominant* gradient axis is less
 * than this fraction of its *more dominant* axis.
 *   0.38 ≈ within ±21° of either the horizontal or vertical axis.
 * (Tighter than the old 0.42 to reduce face false-positives.)
 */
const AXIS_DIAGONALITY_MAX = idConfig.cardDetection.axisDiagonalityMax;

/**
 * Fraction of significant centre-ROI edge pixels that must be axis-aligned.
 * Raised from 0.57 → 0.62 to provide stronger face rejection.
 * Baseline (random angles): ~0.53.  Cards: ~0.65+.  Faces: ~0.46–0.52.
 */
const CARD_HV_FRACTION_THRESHOLD = idConfig.cardDetection.hvFractionThreshold;

/**
 * Border stripe test: the outer 18 % of each ROI side is a "border band".
 * For an ID card:
 *   • Top / bottom bands → predominantly HORIZONTAL edges (|Gy| >> |Gx|)
 *   • Left / right bands → predominantly VERTICAL edges  (|Gx| >> |Gy|)
 * For a human face these bands match hair, chin, ears, neck — none of which
 * produce the clean directional edges of a printed rectangle.
 *
 * Each band score is the fraction of above-threshold pixels that point in the
 * expected direction. The overall border score is the mean of all four bands.
 */
const CARD_BORDER_SCORE_THRESHOLD = idConfig.cardDetection.borderScoreThreshold;
const CARD_BORDER_AXIS_RATIO = idConfig.cardDetection.borderAxisRatio;

// ── Aspect-ratio + fill thresholds ────────────────────────────────────────────
// CR80 ID-1 cards are 85.6 × 53.98 mm → 1.586:1 aspect.
// Passports (open) are ~125 × 88 mm → 1.42:1 (we accept the wider range so
// a single check covers both).
const ASPECT_RATIO_MIN = idConfig.cardGeometry.aspectRatioMin;
const ASPECT_RATIO_MAX = idConfig.cardGeometry.aspectRatioMax;
const MIN_FILL_RATIO = idConfig.cardGeometry.minFillRatio;

// ── Moiré / photo-of-screen thresholds ────────────────────────────────────────
// Phone screens produce a periodic pixel grid that survives camera resampling
// as a peak in the mid-frequency band of both row and column profiles.
const MOIRE_DFT_SIZE = idConfig.screenDetection.dftSize;
const MOIRE_MID_BAND_LOW = idConfig.screenDetection.midBandLow;
const MOIRE_MID_BAND_HIGH = idConfig.screenDetection.midBandHigh;
const MOIRE_DETECTION_THRESHOLD = idConfig.screenDetection.detectionThreshold;

// ── New result type ───────────────────────────────────────────────────────────

export interface LocalCheckResult {
    pass: boolean;
    reason?:
        | 'too_dark'
        | 'too_bright'
        | 'glare'
        | 'too_blurry'
        | 'moving'
        | 'card_not_detected'
        | 'wrong_shape'
        | 'screen_detected';
    brightness: number;
    sharpness: number;
    /** Fraction [0..1] of blown-out pixels (luma > GLARE_PIXEL_THRESHOLD). */
    glareRatio: number;
    /** Mean absolute luma diff vs previous frame, 0–255. 0 when no previous frame. */
    motion: number;
    /** True when a card-like rectangular object is centred in the frame. */
    cardDetected: boolean;
    /** Estimated aspect ratio of the detected card bounding box (width / height). */
    aspectRatio: number;
    /** Fraction [0..1] of the centre ROI filled by the detected card. */
    fillRatio: number;
    /** Moiré score [0..1] — higher = more screen-grid-like periodic energy. */
    moireScore: number;
    /**
     * Normalized [0,1] bounding box of the detected card's significant edges
     * in the full video frame coordinate space. Null when no card is detected.
     * Used by the UI to animate corner brackets onto the card's actual position.
     */
    cardBox: { x0: number; y0: number; x1: number; y1: number } | null;
}

// ── New check functions ───────────────────────────────────────────────────────

/**
 * Returns the fraction [0..1] of pixels whose luminance exceeds `threshold`.
 * This catches localized reflection hot-spots that pass a mean-brightness check
 * because they occupy only a small area of the frame.
 */
export function computeGlareSpots(img: ImageData, threshold = GLARE_PIXEL_THRESHOLD): number {
    const d = img.data;
    let blown = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
        if (luma(d[i], d[i + 1], d[i + 2]) > threshold) blown++;
    }
    return n > 0 ? blown / n : 0;
}

/**
 * Mean absolute luminance difference between two same-size ImageData buffers.
 * Returns 0–255: low = stable scene, high = subject or camera is moving.
 * Both buffers should come from `getDownsampledImageData` so the cost is O(96*h).
 */
export function computeMotion(imgA: ImageData, imgB: ImageData): number {
    const da = imgA.data;
    const db = imgB.data;
    const n = Math.min(da.length, db.length) / 4;
    let sum = 0;
    for (let i = 0; i < n * 4; i += 4) {
        sum += Math.abs(luma(da[i], da[i + 1], da[i + 2]) - luma(db[i], db[i + 1], db[i + 2]));
    }
    return n > 0 ? sum / n : 0;
}

/**
 * Card-presence heuristic using **directional edge analysis**.
 *
 * Analyses the centre ROI (inner 50 % × 60 % of the frame) of the
 * downsampled image and counts how many "significant" Sobel edge pixels
 * are **axis-aligned** (i.e., the gradient is mostly horizontal or mostly
 * vertical) vs **diagonal** (gradient spread across both axes).
 *
 * ID cards produce axis-aligned edges:
 *   → text strokes (horizontal bars, vertical stems)
 *   → card border (rectangle sides)
 *   → barcodes (vertical lines)
 *
 * Human faces produce diagonal / curved edges:
 *   → eye socket arcs, nose curves, lip contours, jawline, hairline
 *
 * A pixel with Sobel components (Gx, Gy) is axis-aligned when:
 *   min(|Gx|, |Gy|) / max(|Gx|, |Gy|) < AXIS_DIAGONALITY_MAX   (≈ ±23°)
 *
 * Pass condition (**all three** must hold):
 *   1. At least CARD_MIN_SIGNIFICANT_EDGES pixels with mag > EDGE_MAG_FLOOR
 *      exist in the centre ROI  (presence guard — rejects empty/distant frames)
 *   2. hvFraction ≥ CARD_HV_FRACTION_THRESHOLD                   (type guard)
 *   3. borderScore ≥ CARD_BORDER_SCORE_THRESHOLD                  (shape guard)
 *      — verifies horizontal edges at top+bottom AND vertical edges at
 *        left+right of the ROI, matching the rectangular card border.
 *        Human faces never produce this pattern reliably.
 *
 * Note on limitations: This heuristic is robust against plain faces but may
 * occasionally misclassify a face seen at a right angle with strong straight
 * features (e.g., wearing a hat with a horizontal brim). In practice the
 * remaining checks (motion, stability, sharpness) and the downstream AWS
 * Textract validation provide adequate correction for those edge cases.
 *
 * @returns detected         — true when all three guards pass
 * @returns hvFraction        — [0..1] fraction of axis-aligned edge pixels (debug)
 * @returns significantEdges  — raw count of significant edge pixels  (debug)
 * @returns borderScore       — [0..1] mean directional score across 4 border bands (debug)
 */
export function detectCard(img: ImageData): {
    detected: boolean;
    hvFraction: number;
    significantEdges: number;
    borderScore: number;
    /** Aspect ratio (w/h) of the smallest rectangle covering the in-ROI edges. */
    aspectRatio: number;
    /** Fraction [0..1] of the centre ROI filled by that bounding rectangle. */
    fillRatio: number;
    /** Normalized [0,1] bounding box in the full video frame. Null when no card. */
    cardBoxNorm: { x0: number; y0: number; x1: number; y1: number } | null;
} {
    const w = img.width;
    const h = img.height;
    const d = img.data;

    // Luminance plane
    const L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            L[y * w + x] = luma(d[i], d[i + 1], d[i + 2]);
        }
    }

    // Scan ROI: 80% × 84% of the frame so the user doesn't have to perfectly
    // fill the centre. The border-stripe test and HV-fraction test still
    // distinguish cards from faces/backgrounds at any size.
    const cx0 = Math.floor(w * 0.1);
    const cx1 = Math.floor(w * 0.9);
    const cy0 = Math.floor(h * 0.08);
    const cy1 = Math.floor(h * 0.92);
    const roiW = cx1 - cx0;
    const roiH = cy1 - cy0;

    // Border bands: outer 18 % (H) and 15 % (V) of the ROI
    const topBandEnd = cy0 + Math.floor(roiH * 0.18);
    const bottomBandStart = cy1 - Math.floor(roiH * 0.18);
    const leftBandEnd = cx0 + Math.floor(roiW * 0.15);
    const rightBandStart = cx1 - Math.floor(roiW * 0.15);

    let significantEdges = 0;
    let hvEdges = 0;

    // Bounding box of significant edges inside the ROI.
    let bboxMinX = roiW + cx0;
    let bboxMaxX = cx0 - 1;
    let bboxMinY = roiH + cy0;
    let bboxMaxY = cy0 - 1;

    // Border band accumulators: [count of directional edges, total above-thresh edges]
    let topH = 0,
        topN = 0;
    let botH = 0,
        botN = 0;
    let leftV = 0,
        leftN = 0;
    let rightV = 0,
        rightN = 0;

    const BORDER_MAG_FLOOR = EDGE_MAG_FLOOR * 0.7; // slightly relaxed for border zones

    for (let y = Math.max(1, cy0); y < Math.min(h - 1, cy1); y++) {
        for (let x = Math.max(1, cx0); x < Math.min(w - 1, cx1); x++) {
            // Sobel 3×3
            const tl = L[(y - 1) * w + (x - 1)];
            const t = L[(y - 1) * w + x];
            const tr = L[(y - 1) * w + (x + 1)];
            const l = L[y * w + (x - 1)];
            const r = L[y * w + (x + 1)];
            const bl = L[(y + 1) * w + (x - 1)];
            const b = L[(y + 1) * w + x];
            const br = L[(y + 1) * w + (x + 1)];

            const gx = -tl - 2 * l - bl + tr + 2 * r + br;
            const gy = -tl - 2 * t - tr + bl + 2 * b + br;
            const mag = Math.sqrt(gx * gx + gy * gy);
            const absGx = Math.abs(gx);
            const absGy = Math.abs(gy);

            // ── HV-fraction check (all ROI pixels) ────────────────────────
            if (mag >= EDGE_MAG_FLOOR) {
                significantEdges++;
                const maxG = Math.max(absGx, absGy);
                const minG = Math.min(absGx, absGy);
                if (minG / (maxG + 0.001) < AXIS_DIAGONALITY_MAX) {
                    hvEdges++;
                }
                // Track bbox of significant edges for aspect-ratio + fill.
                if (x < bboxMinX) bboxMinX = x;
                if (x > bboxMaxX) bboxMaxX = x;
                if (y < bboxMinY) bboxMinY = y;
                if (y > bboxMaxY) bboxMaxY = y;
            }

            // ── Border-stripe check ───────────────────────────────────────
            if (mag < BORDER_MAG_FLOOR) continue;

            // Top band — expect HORIZONTAL edges → |Gy| should dominate
            if (y < topBandEnd) {
                topN++;
                if (absGy > absGx * CARD_BORDER_AXIS_RATIO) topH++;
            }
            // Bottom band — expect HORIZONTAL edges
            if (y >= bottomBandStart) {
                botN++;
                if (absGy > absGx * CARD_BORDER_AXIS_RATIO) botH++;
            }
            // Left band — expect VERTICAL edges → |Gx| should dominate
            if (x < leftBandEnd) {
                leftN++;
                if (absGx > absGy * CARD_BORDER_AXIS_RATIO) leftV++;
            }
            // Right band — expect VERTICAL edges
            if (x >= rightBandStart) {
                rightN++;
                if (absGx > absGy * CARD_BORDER_AXIS_RATIO) rightV++;
            }
        }
    }

    const hvFraction =
        significantEdges >= CARD_MIN_SIGNIFICANT_EDGES ? hvEdges / significantEdges : 0;

    const MIN_BAND_PX = idConfig.cardDetection.minBandPx;
    const tScore = topN >= MIN_BAND_PX ? topH / topN : 0;
    const bScore = botN >= MIN_BAND_PX ? botH / botN : 0;
    const lScore = leftN >= MIN_BAND_PX ? leftV / leftN : 0;
    const rScore = rightN >= MIN_BAND_PX ? rightV / rightN : 0;
    const borderScore = (tScore + bScore + lScore + rScore) / 4;

    // Bounding-box aspect ratio + fill (debug values; used by the
    // 'wrong_shape' check in runLocalPreChecks).
    let aspectRatio = 0;
    let fillRatio = 0;
    let cardBoxNorm: { x0: number; y0: number; x1: number; y1: number } | null = null;
    if (bboxMaxX >= bboxMinX && bboxMaxY >= bboxMinY) {
        const bw = bboxMaxX - bboxMinX + 1;
        const bh = bboxMaxY - bboxMinY + 1;
        aspectRatio = bh > 0 ? bw / bh : 0;
        fillRatio = (bw * bh) / (roiW * roiH);
        cardBoxNorm = {
            x0: bboxMinX / w,
            y0: bboxMinY / h,
            x1: (bboxMaxX + 1) / w,
            y1: (bboxMaxY + 1) / h,
        };
    }

    // All three conditions must hold simultaneously.
    const detected =
        significantEdges >= CARD_MIN_SIGNIFICANT_EDGES &&
        hvFraction >= CARD_HV_FRACTION_THRESHOLD &&
        borderScore >= CARD_BORDER_SCORE_THRESHOLD;

    return {
        detected,
        hvFraction,
        significantEdges,
        borderScore,
        aspectRatio,
        fillRatio,
        cardBoxNorm,
    };
}

// ── Moiré / photo-of-screen detection ────────────────────────────────────────
//
// When a phone camera films another phone's screen, the regular pixel grid
// produces a periodic high-frequency pattern. After camera resampling this
// pattern survives as a peak in the *mid* frequency band of the row-mean and
// column-mean profiles of the image.
//
// Real ID cards have busy text + flat backgrounds; their row/col profiles are
// dominated by *low* frequencies (overall brightness shifts) with broadband
// noise at high frequency from text. They do *not* produce a clean mid-band
// peak in both axes simultaneously.
//
// This is a cheap heuristic: 2 × DFT of size 32 (~2048 multiplications). The
// detection is gated on *both* row and column mid-band energy being elevated,
// since a real card might briefly trigger one axis (e.g. through a barcode)
// but rarely both.
//
// Returns a `score` in [0..1]. Caller decides on a threshold.
export function detectMoire(img: ImageData): { detected: boolean; score: number } {
    const w = img.width;
    const h = img.height;
    const d = img.data;

    // Centre ROI: 50 % × 60 % (matches detectCard) — but downsample to
    // MOIRE_DFT_SIZE × MOIRE_DFT_SIZE for the DFT.
    const cx0 = Math.floor(w * 0.25);
    const cx1 = Math.floor(w * 0.75);
    const cy0 = Math.floor(h * 0.2);
    const cy1 = Math.floor(h * 0.8);
    const roiW = cx1 - cx0;
    const roiH = cy1 - cy0;
    if (roiW < MOIRE_DFT_SIZE || roiH < MOIRE_DFT_SIZE) {
        return { detected: false, score: 0 };
    }

    // Row-mean and column-mean profiles of the ROI, sampled at MOIRE_DFT_SIZE.
    const rowMeans = new Float32Array(MOIRE_DFT_SIZE);
    const colMeans = new Float32Array(MOIRE_DFT_SIZE);
    const rowCounts = new Int32Array(MOIRE_DFT_SIZE);
    const colCounts = new Int32Array(MOIRE_DFT_SIZE);

    for (let y = cy0; y < cy1; y++) {
        const ry = Math.min(MOIRE_DFT_SIZE - 1, Math.floor(((y - cy0) / roiH) * MOIRE_DFT_SIZE));
        for (let x = cx0; x < cx1; x++) {
            const rx = Math.min(
                MOIRE_DFT_SIZE - 1,
                Math.floor(((x - cx0) / roiW) * MOIRE_DFT_SIZE),
            );
            const i = (y * w + x) * 4;
            const lum = luma(d[i], d[i + 1], d[i + 2]);
            rowMeans[ry] += lum;
            rowCounts[ry]++;
            colMeans[rx] += lum;
            colCounts[rx]++;
        }
    }
    for (let i = 0; i < MOIRE_DFT_SIZE; i++) {
        if (rowCounts[i] > 0) rowMeans[i] /= rowCounts[i];
        if (colCounts[i] > 0) colMeans[i] /= colCounts[i];
    }

    // Subtract DC component so it doesn't dominate the spectrum.
    let rowDc = 0;
    let colDc = 0;
    for (let i = 0; i < MOIRE_DFT_SIZE; i++) {
        rowDc += rowMeans[i];
        colDc += colMeans[i];
    }
    rowDc /= MOIRE_DFT_SIZE;
    colDc /= MOIRE_DFT_SIZE;
    for (let i = 0; i < MOIRE_DFT_SIZE; i++) {
        rowMeans[i] -= rowDc;
        colMeans[i] -= colDc;
    }

    // Compute |X[k]|² for k = 1..N/2 of both profiles.
    function dftPowerBand(samples: Float32Array, lo: number, hi: number): number {
        let bandEnergy = 0;
        let totalEnergy = 0;
        const N = samples.length;
        for (let k = 1; k < N / 2; k++) {
            let re = 0;
            let im = 0;
            for (let n = 0; n < N; n++) {
                const a = (-2 * Math.PI * k * n) / N;
                re += samples[n] * Math.cos(a);
                im += samples[n] * Math.sin(a);
            }
            const power = re * re + im * im;
            totalEnergy += power;
            if (k >= lo && k <= hi) bandEnergy += power;
        }
        return totalEnergy > 0 ? bandEnergy / totalEnergy : 0;
    }

    const rowBand = dftPowerBand(rowMeans, MOIRE_MID_BAND_LOW, MOIRE_MID_BAND_HIGH);
    const colBand = dftPowerBand(colMeans, MOIRE_MID_BAND_LOW, MOIRE_MID_BAND_HIGH);

    // Use the geometric mean — both axes must have elevated mid-band energy
    // for it to be a screen, not a single-axis artefact like a barcode.
    const score = Math.sqrt(rowBand * colBand);
    return { detected: score > MOIRE_DETECTION_THRESHOLD, score };
}

/**
 * Full local pre-check gate — runs all 5 quality checks in priority order
 * (cheapest first) and short-circuits on the first failure.
 *
 * Checks:
 *  1. Brightness  — mean luma within [minBrightness, maxBrightness]
 *  2. Glare       — blown-out pixel fraction ≤ GLARE_MAX_RATIO
 *  3. Sharpness   — Sobel variance ≥ minSharpness
 *  4. Motion      — mean frame diff vs prevImg ≤ MOTION_MAX_DIFF
 *  5. Card        — centre/outer edge density ratio ≥ CARD_MIN_EDGE_RATIO
 *
 * @param source     Live <video> element.
 * @param prevImg    Downsampled ImageData from the previous call (for motion).
 *                   Pass null on the first call — motion check is skipped.
 * @param thresholds Override default brightness / sharpness thresholds.
 */
export function runLocalPreChecks(
    source: HTMLVideoElement,
    prevImg: ImageData | null,
    thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
): LocalCheckResult | null {
    const img = getDownsampledImageData(source);
    if (!img) return null;

    const brightness = computeBrightness(img);
    const glareRatio = computeGlareSpots(img);
    const sharpness = computeSharpness(img);
    const motion = prevImg ? computeMotion(img, prevImg) : 0;
    const { detected: cardDetected, aspectRatio, fillRatio, cardBoxNorm } = detectCard(img);
    // Moiré is only meaningful when a card-like object is present; otherwise
    // empty frames can produce noisy mid-band energy that doesn't matter.
    const { score: moireScore } = cardDetected ? detectMoire(img) : { score: 0 };

    let reason: LocalCheckResult['reason'];
    if (brightness < thresholds.minBrightness) reason = 'too_dark';
    else if (brightness > thresholds.maxBrightness) reason = 'too_bright';
    else if (glareRatio > GLARE_MAX_RATIO) reason = 'glare';
    else if (sharpness < thresholds.minSharpness) reason = 'too_blurry';
    else if (prevImg && motion > MOTION_MAX_DIFF) reason = 'moving';
    else if (!cardDetected) reason = 'card_not_detected';
    else if (moireScore > MOIRE_DETECTION_THRESHOLD) reason = 'screen_detected';
    // Note: aspect-ratio + fill check intentionally disabled — the bounding
    // box of significant edges takes the ROI shape rather than the card's
    // true rectangle. detectCard's border-stripe test already verifies the
    // card is rectangular, so the extra check produced false rejections.
    // aspectRatio and fillRatio are still surfaced for debugging.

    return {
        pass: !reason,
        reason,
        brightness,
        sharpness,
        glareRatio,
        motion,
        cardDetected,
        aspectRatio,
        fillRatio,
        moireScore,
        cardBox: cardDetected ? cardBoxNorm : null,
    };
}

// ── Legacy one-shot gate (kept for backward compatibility) ────────────────────

/**
 * One-shot quality gate. Returns the brightness/sharpness scores and a
 * pass/fail verdict against the supplied thresholds.
 */
export function scoreFrameQuality(
    source: HTMLCanvasElement | HTMLVideoElement,
    thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
): QualityScore | null {
    const img = getDownsampledImageData(source);
    if (!img) return null;

    const brightness = computeBrightness(img);
    const sharpness = computeSharpness(img);

    let reason: QualityScore['reason'];
    if (brightness < thresholds.minBrightness) reason = 'too_dark';
    else if (brightness > thresholds.maxBrightness) reason = 'too_bright';
    else if (sharpness < thresholds.minSharpness) reason = 'too_blurry';

    return {
        brightness,
        sharpness,
        pass: !reason,
        reason,
    };
}
