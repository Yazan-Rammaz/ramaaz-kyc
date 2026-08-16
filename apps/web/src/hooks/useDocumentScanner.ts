'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ScannerPoint {
    x: number;
    y: number;
}
export interface ScannerCorners {
    topLeft: ScannerPoint;
    topRight: ScannerPoint;
    bottomRight: ScannerPoint;
    bottomLeft: ScannerPoint;
}
export interface ScannerOverlay {
    width: number;
    height: number;
    pathD: string;
}

interface UseDocumentScannerOptions {
    enabled?: boolean;
    processEveryNFrames?: number;
    minAreaRatio?: number;
    maxProcessingWidth?: number;
    opencvUrl?: string;
    maxOutputWidth?: number | null;
    jpegQuality?: number;
    maxMissesBeforeReset?: number;
    smoothingAlpha?: number;
    /**
     * Minimum interior content density [0..1] for a quad to count as a real
     * ID/passport (rejects blank paper). Pass a lower value for the back side,
     * which can be sparse. Default 0.06.
     */
    minInteriorDensity?: number;
}
interface CaptureOptions {
    jpegQuality?: number;
    maxOutputWidth?: number | null;
}

interface UseDocumentScannerResult {
    isReady: boolean;
    isDetecting: boolean;
    corners: ScannerCorners | null;
    rawCorners: ScannerCorners | null;
    overlay: ScannerOverlay | null;
    capture: (options?: CaptureOptions) => Promise<string | null>;
    isStable: boolean; // NEW: Indicates the card has stopped moving
}

type WorkerMessage =
    | { type: 'ready' }
    | { type: 'processResult'; frameId: number; detected: false }
    | {
          type: 'processResult';
          frameId: number;
          detected: true;
          corners: [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint];
      }
    | { type: 'captureResult'; requestId: number; imageDataUrl: string | null; error?: string }
    | { type: 'error'; error: string };

// Self-hosted, NOT https://docs.opencv.org/4.x/opencv.js.
//
// The document-scanner worker pulls this in with importScripts(), which CSP
// governs under script-src. Ours is `script-src 'self' 'unsafe-inline'
// 'unsafe-eval' blob:` (added in 54921af, the security-hardening commit) — no
// `https:`, so a cross-origin fetch is blocked. When OpenCV fails to load the
// scanner never emits corners, isCardDetected stays false, and ID capture sits
// on "Card detected — scanning…" forever: the Sobel detector behind that status
// text is a different detector and keeps working, which makes it look like the
// card was seen when the capture path is actually dead.
//
// Serving it from our own origin satisfies 'self' and also drops a runtime
// dependency on opencv.org's docs site, which is documentation hosting rather
// than a CDN with an SLA.
const DEFAULT_OPENCV_URL = '/vendor/opencv.js';

function mapRawPointToDisplayedVideo(
    point: ScannerPoint,
    videoWidth: number,
    videoHeight: number,
    displayWidth: number,
    displayHeight: number,
): ScannerPoint {
    const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight);
    const offsetX = (displayWidth - videoWidth * scale) / 2;
    const offsetY = (displayHeight - videoHeight * scale) / 2;
    return { x: point.x * scale + offsetX, y: point.y * scale + offsetY };
}

function pointsToCorners(
    points: [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint],
): ScannerCorners {
    return {
        topLeft: points[0],
        topRight: points[1],
        bottomRight: points[2],
        bottomLeft: points[3],
    };
}

function smoothCornersWithEma(
    nextPoints: [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint],
    previousPoints: [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint] | null,
    alpha: number,
): [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint] {
    if (!previousPoints) return nextPoints;
    const blend = (n: ScannerPoint, p: ScannerPoint) => ({
        x: n.x * alpha + p.x * (1 - alpha),
        y: n.y * alpha + p.y * (1 - alpha),
    });
    return [
        blend(nextPoints[0], previousPoints[0]),
        blend(nextPoints[1], previousPoints[1]),
        blend(nextPoints[2], previousPoints[2]),
        blend(nextPoints[3], previousPoints[3]),
    ];
}

function distanceBetweenPoints(a: ScannerPoint, b: ScannerPoint): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}
function moveTowardsPoint(from: ScannerPoint, to: ScannerPoint, distance: number): ScannerPoint {
    const len = distanceBetweenPoints(from, to);
    if (!len) return from;
    return {
        x: from.x + (to.x - from.x) * (distance / len),
        y: from.y + (to.y - from.y) * (distance / len),
    };
}

function getRoundedQuadPath(
    points: [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint],
    radius: number,
): string {
    const segments = points.map((point, index) => {
        const previous = points[(index + points.length - 1) % points.length];
        const next = points[(index + 1) % points.length];
        const r = Math.min(
            radius,
            distanceBetweenPoints(point, previous) / 2,
            distanceBetweenPoints(point, next) / 2,
        );
        return {
            entry: moveTowardsPoint(point, previous, r),
            corner: point,
            exit: moveTowardsPoint(point, next, r),
        };
    });
    const commands = [`M ${segments[0].exit.x} ${segments[0].exit.y}`];
    for (let i = 1; i < segments.length; i++) {
        commands.push(
            `L ${segments[i].entry.x} ${segments[i].entry.y}`,
            `Q ${segments[i].corner.x} ${segments[i].corner.y} ${segments[i].exit.x} ${segments[i].exit.y}`,
        );
    }
    commands.push(
        `L ${segments[0].entry.x} ${segments[0].entry.y}`,
        `Q ${segments[0].corner.x} ${segments[0].corner.y} ${segments[0].exit.x} ${segments[0].exit.y}`,
        'Z',
    );
    return commands.join(' ');
}

function buildOverlayPath(corners: ScannerCorners, width: number, height: number): string {
    return [
        `M 0 0`,
        `H ${width}`,
        `V ${height}`,
        `H 0`,
        `Z`,
        getRoundedQuadPath(
            [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft],
            15,
        ),
    ].join(' ');
}

// NEW: Helper to safely expand crop boundaries
function expandCornersPadding(
    corners: [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint],
    paddingRatio: number,
): [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint] {
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    const exp = (p: ScannerPoint) => ({
        x: p.x + (p.x - cx) * paddingRatio,
        y: p.y + (p.y - cy) * paddingRatio,
    });
    return [exp(corners[0]), exp(corners[1]), exp(corners[2]), exp(corners[3])];
}

export function useDocumentScanner(
    videoRef: React.RefObject<HTMLVideoElement | null>,
    options: UseDocumentScannerOptions = {},
): UseDocumentScannerResult {
    const {
        enabled = true,
        processEveryNFrames = 4,
        minAreaRatio = 0.12,
        maxProcessingWidth = 960,
        opencvUrl = DEFAULT_OPENCV_URL,
        maxOutputWidth = 1400,
        jpegQuality = 0.94,
        maxMissesBeforeReset = 8,
        smoothingAlpha = 0.2,
        minInteriorDensity = 0.06,
    } = options;

    const workerRef = useRef<Worker | null>(null);
    const captureResolversRef = useRef<
        Map<number, { resolve: (value: string | null) => void; reject: (reason?: unknown) => void }>
    >(new Map());
    const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const frameIdRef = useRef(0);
    const captureRequestIdRef = useRef(0);
    const rafRef = useRef<number | null>(null);
    const isProcessingRef = useRef(false);
    const missesRef = useRef(0);

    const [isReady, setIsReady] = useState(false);
    const [isDetecting, setIsDetecting] = useState(false);
    const [isStable, setIsStable] = useState(false);
    const [corners, setCorners] = useState<ScannerCorners | null>(null);
    const [rawCorners, setRawCorners] = useState<ScannerCorners | null>(null);
    const [overlay, setOverlay] = useState<ScannerOverlay | null>(null);

    const rawCornersRef = useRef<[ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint] | null>(
        null,
    );
    useEffect(() => {
        if (!enabled) {
            rawCornersRef.current = null;
            setCorners(null);
            setRawCorners(null);
            setOverlay(null);
            setIsStable(false);
            setIsDetecting(false);
            missesRef.current = 0;
        }
    }, [enabled]);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const worker = new Worker(new URL('../workers/documentScanner.worker.ts', import.meta.url));
        workerRef.current = worker;

        const onMessage = (event: MessageEvent<WorkerMessage>) => {
            const data = event.data;
            if (data.type === 'ready') {
                setIsReady(true);
                return;
            }
            if (data.type === 'error') {
                setIsDetecting(false);
                isProcessingRef.current = false;
                return;
            }
            if (data.type === 'processResult') {
                isProcessingRef.current = false;
                setIsDetecting(false);
                if (!data.detected) {
                    missesRef.current += 1;
                    if (missesRef.current >= maxMissesBeforeReset) {
                        rawCornersRef.current = null;
                        setCorners(null);
                        setRawCorners(null);
                        setOverlay(null);
                        setIsStable(false);
                        missesRef.current = 0; // تصفير عداد الأخطاء
                    }
                    return;
                }
                missesRef.current = 0;
                const points = data.corners;

                // Stability check: if corners moved less than 6 pixels from last frame, we are stable and focusing is done
                let stable = false;
                if (rawCornersRef.current) {
                    const maxMove = Math.max(
                        distanceBetweenPoints(points[0], rawCornersRef.current[0]),
                        distanceBetweenPoints(points[1], rawCornersRef.current[1]),
                        distanceBetweenPoints(points[2], rawCornersRef.current[2]),
                        distanceBetweenPoints(points[3], rawCornersRef.current[3]),
                    );
                    stable = maxMove < 18.0;
                }
                setIsStable(stable);

                const alpha = Math.max(0, Math.min(1, smoothingAlpha));
                const smoothedPoints = smoothCornersWithEma(points, rawCornersRef.current, alpha);
                rawCornersRef.current = smoothedPoints;
                setRawCorners(pointsToCorners(smoothedPoints));

                const video = videoRef.current;
                if (!video || !video.clientWidth || !video.videoWidth) return;
                const dc = smoothedPoints.map((p) =>
                    mapRawPointToDisplayedVideo(
                        p,
                        video.videoWidth,
                        video.videoHeight,
                        video.clientWidth,
                        video.clientHeight,
                    ),
                ) as [ScannerPoint, ScannerPoint, ScannerPoint, ScannerPoint];
                const displayCornersObject = pointsToCorners(dc);
                setCorners(displayCornersObject);
                setOverlay({
                    width: video.clientWidth,
                    height: video.clientHeight,
                    pathD: buildOverlayPath(
                        displayCornersObject,
                        video.clientWidth,
                        video.clientHeight,
                    ),
                });
            }
            if (data.type === 'captureResult') {
                const handlers = captureResolversRef.current.get(data.requestId);
                if (!handlers) return;
                captureResolversRef.current.delete(data.requestId);
                if (data.error) handlers.reject(new Error(data.error));
                else handlers.resolve(data.imageDataUrl);
            }
        };

        worker.addEventListener('message', onMessage);
        worker.postMessage({ type: 'init', opencvUrl });

        return () => {
            worker.removeEventListener('message', onMessage);
            worker.terminate();
            workerRef.current = null;
            captureResolversRef.current.forEach(({ resolve }) => resolve(null));
            captureResolversRef.current.clear();
            missesRef.current = 0; // تصفير عداد الأخطاء
            setIsReady(false);
        };
    }, [opencvUrl, videoRef, maxMissesBeforeReset, smoothingAlpha]);

    useEffect(() => {
        if (!enabled || !isReady) return;
        if (!drawCanvasRef.current) drawCanvasRef.current = document.createElement('canvas');
        let localFrameCounter = 0;
        const processLoop = () => {
            rafRef.current = window.requestAnimationFrame(processLoop);
            const video = videoRef.current;
            const worker = workerRef.current;
            if (!video || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
            if (++localFrameCounter % processEveryNFrames !== 0 || isProcessingRef.current) return;

            const scale = Math.min(1, maxProcessingWidth / video.videoWidth);
            const processWidth = Math.max(1, Math.round(video.videoWidth * scale));
            const processHeight = Math.max(1, Math.round(video.videoHeight * scale));

            const canvas = drawCanvasRef.current;
            if (!canvas) return;
            if (canvas.width !== processWidth || canvas.height !== processHeight) {
                canvas.width = processWidth;
                canvas.height = processHeight;
            }
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, processWidth, processHeight);
            const imageData = ctx.getImageData(0, 0, processWidth, processHeight);

            isProcessingRef.current = true;
            setIsDetecting(true);
            worker.postMessage(
                {
                    type: 'process',
                    frameId: ++frameIdRef.current,
                    width: processWidth,
                    height: processHeight,
                    rgbaBuffer: imageData.data.buffer,
                    minAreaRatio,
                    minInteriorDensity,
                },
                [imageData.data.buffer],
            );
        };
        rafRef.current = window.requestAnimationFrame(processLoop);
        return () => {
            if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
            isProcessingRef.current = false;
            setIsDetecting(false);
        };
    }, [
        enabled,
        isReady,
        maxProcessingWidth,
        minAreaRatio,
        minInteriorDensity,
        processEveryNFrames,
        videoRef,
    ]);

    const capture = useCallback(
        async (captureOptions?: CaptureOptions): Promise<string | null> => {
            const worker = workerRef.current;
            const video = videoRef.current;
            const points = rawCornersRef.current;
            if (
                !worker ||
                !video ||
                !points ||
                video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
            )
                return null;

            const canvas = drawCanvasRef.current ?? document.createElement('canvas');
            drawCanvasRef.current = canvas;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            // --- 1. Expand corners for safety margin (4%) ---
            let finalCorners = expandCornersPadding(points, 0.04);

            // --- 2. Auto-Landscape Rotation Fix ---
            const wTop = distanceBetweenPoints(finalCorners[0], finalCorners[1]);
            const hLeft = distanceBetweenPoints(finalCorners[0], finalCorners[3]);
            if (hLeft > wTop) {
                // If card is detected vertically, shift corners by 1 to output landscape!
                finalCorners = [finalCorners[3], finalCorners[0], finalCorners[1], finalCorners[2]];
            }

            const requestId = ++captureRequestIdRef.current;
            const responsePromise = new Promise<string | null>((resolve, reject) => {
                captureResolversRef.current.set(requestId, { resolve, reject });
            });

            worker.postMessage(
                {
                    type: 'capture',
                    requestId,
                    width: canvas.width,
                    height: canvas.height,
                    rgbaBuffer: imageData.data.buffer,
                    corners: finalCorners,
                    jpegQuality: captureOptions?.jpegQuality ?? jpegQuality,
                    maxOutputWidth:
                        captureOptions?.maxOutputWidth === undefined
                            ? maxOutputWidth
                            : captureOptions.maxOutputWidth,
                },
                [imageData.data.buffer],
            );
            try {
                return await responsePromise;
            } catch {
                return null;
            }
        },
        [jpegQuality, maxOutputWidth, videoRef],
    );

    return useMemo(
        () => ({ isReady, isDetecting, isStable, corners, rawCorners, overlay, capture }),
        [capture, corners, isDetecting, isReady, isStable, overlay, rawCorners],
    );
}
