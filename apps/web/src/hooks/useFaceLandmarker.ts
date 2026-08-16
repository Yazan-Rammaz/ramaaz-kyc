'use client';

/**
 * useFaceLandmarker
 *
 * Loads the MediaPipe FaceLandmarker model once per page-load (singleton
 * pattern — the heavy WASM + model file is cached after the first call).
 *
 * Returns a `detect(video)` function that synchronously runs inference on
 * the current video frame and returns the raw `FaceLandmarkerResult` (which
 * includes the 478-landmark mesh we use for yaw estimation).
 *
 * The hook never throws — if the model fails to load `isReady` stays false
 * and `detect` returns null.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision';

// ─── Singleton model cache ────────────────────────────────────────────────────
// Shared across all hook instances so we only pay the load cost once.
type FaceLandmarkerModule = typeof import('@mediapipe/tasks-vision');

let cachedLandmarker: import('@mediapipe/tasks-vision').FaceLandmarker | null = null;
let loadPromise: Promise<import('@mediapipe/tasks-vision').FaceLandmarker> | null = null;

/**
 * Self-hosted MediaPipe WASM, NOT cdn.jsdelivr.net.
 *
 * FilesetResolver loads vision_wasm_internal.js as a script, which CSP governs
 * under script-src — ours is `'self' 'unsafe-inline' 'unsafe-eval' blob:`, so a
 * jsdelivr fetch is blocked and the face landmarker never initialises.
 *
 * The files under public/vendor/mediapipe are committed to this repo — this is
 * the KYC service's permanent home, and a compliance flow should not depend on
 * third-party hosting staying up. Refresh them from
 * node_modules/@mediapipe/tasks-vision/wasm after bumping that dependency:
 *   npm run sync:vendor
 */
const MEDIAPIPE_BASE_URL = '/vendor/mediapipe';

const MODEL_ASSET_PATH =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Fire-and-forget: starts the model download immediately.
 * Safe to call multiple times — the promise is cached after the first call.
 * Call this as early as possible (e.g. when the user enters the ID stage)
 * so the model is warm by the time FaceCaptureScreen mounts.
 */
export function kickstartLandmarker(): void {
    if (!loadPromise) loadPromise = loadLandmarker();
}

async function loadLandmarker(): Promise<import('@mediapipe/tasks-vision').FaceLandmarker> {
    if (cachedLandmarker) return cachedLandmarker;

    const vision: FaceLandmarkerModule = await import('@mediapipe/tasks-vision');
    const { FaceLandmarker, FilesetResolver } = vision;

    const filesetResolver = await FilesetResolver.forVisionTasks(MEDIAPIPE_BASE_URL);

    const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: 'GPU',
        },
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true, // needed for yaw from rotation matrix
        runningMode: 'VIDEO',
        numFaces: 1,
    });

    cachedLandmarker = landmarker;
    return landmarker;
}

// ─── Yaw estimation from nose–eye geometry ─────────────────────────────────
/**
 * Derives head yaw (degrees) from the Face Mesh landmark positions.
 *
 * Strategy: use the horizontal displacement of the nose tip (landmark 1)
 * relative to the midpoint of the two eye outer-corner landmarks (33, 263).
 * This is robust and works without needing the facial transformation matrix.
 *
 * Returns degrees:  +ve = turned LEFT (user's left), -ve = turned RIGHT.
 * Matches the Rekognition convention used in the existing liveness route.
 */
export function estimateYaw(result: FaceLandmarkerResult): number | null {
    const mesh = result.faceLandmarks?.[0];
    if (!mesh || mesh.length < 468) return null;

    // Left eye outer corner: 33, Right eye outer corner: 263
    // Nose tip: 1
    const leftEye = mesh[33];
    const rightEye = mesh[263];
    const noseTip = mesh[1];

    if (!leftEye || !rightEye || !noseTip) return null;

    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeWidth = Math.abs(rightEye.x - leftEye.x);

    if (eyeWidth < 0.001) return null; // face too small / off-screen

    // Normalise nose offset to [-1, +1] over the eye span
    const normalised = (noseTip.x - eyeMidX) / (eyeWidth / 2);

    // Scale to degrees: ±1 normalised ≈ ±40°
    return normalised * 40;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseFaceLandmarkerReturn {
    /** True once the model is loaded and ready. */
    isReady: boolean;
    /** Error string if load failed, null otherwise. */
    loadError: string | null;
    /**
     * Run inference on the current video frame.
     * @param videoEl The live <video> element (must be playing).
     * @returns FaceLandmarkerResult or null when not ready / no frame.
     */
    detect: (videoEl: HTMLVideoElement) => FaceLandmarkerResult | null;
}

export function useFaceLandmarker(): UseFaceLandmarkerReturn {
    const [isReady, setIsReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const landmarkerRef = useRef<import('@mediapipe/tasks-vision').FaceLandmarker | null>(null);
    const lastTimestampRef = useRef<number>(-1);

    useEffect(() => {
        let cancelled = false;

        const init = async () => {
            try {
                if (!loadPromise) loadPromise = loadLandmarker();
                const lm = await loadPromise;
                if (cancelled) return;
                landmarkerRef.current = lm;
                setIsReady(true);
            } catch (err) {
                if (cancelled) return;
                setLoadError(String(err));
            }
        };

        init();
        return () => {
            cancelled = true;
        };
    }, []);

    const detect = useCallback(
        (videoEl: HTMLVideoElement): FaceLandmarkerResult | null => {
            if (!landmarkerRef.current || !isReady) return null;
            if (videoEl.readyState < 2) return null;

            // MediaPipe VIDEO mode requires strictly monotonically increasing timestamps.
            const now = performance.now();
            if (now <= lastTimestampRef.current) return null;
            lastTimestampRef.current = now;

            try {
                return landmarkerRef.current.detectForVideo(videoEl, now);
            } catch {
                return null;
            }
        },
        [isReady],
    );

    return { isReady, loadError, detect };
}
