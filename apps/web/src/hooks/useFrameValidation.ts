'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getDownsampledImageData,
    runLocalPreChecks,
    type LocalCheckResult,
    type QualityThresholds,
} from '@/services/kyc/imageQuality';

// ── Public types ──────────────────────────────────────────────────────────────

export interface FrameValidationOptions {
    /**
     * Milliseconds all 5 checks must pass *continuously* before
     * `readyToCapture` becomes true. Default: 1000 ms (1 second).
     */
    stabilityMs?: number;
    /**
     * How often to sample frames, in milliseconds.
     * Runs inside a requestAnimationFrame loop so the actual cadence is
     * max(intervalMs, 1 rAF ≈ 16 ms). Default: 500 ms.
     */
    intervalMs?: number;
    /** Override default brightness / sharpness thresholds. */
    thresholds?: QualityThresholds;
    /**
     * Mean-luma motion score below which the scene is considered static.
     * When the scene hasn't changed AND the last check result is the same
     * pass/fail category, `checkResult` is NOT updated — preventing the
     * status-text effect from re-firing and replacing messages the user
     * is still reading. Default: 3.0 (empirically: stationary hand ≈ 1–2).
     */
    staticMotionThreshold?: number;
}

export interface FrameValidationResult {
    /** Latest local check result — null until the first sample. */
    checkResult: LocalCheckResult | null;
    /**
     * How long (ms) the frame has *continuously* passed all 5 checks.
     * Resets to 0 on any single failure. Drives the stability progress bar.
     */
    stableDuration: number;
    /**
     * True once all 5 checks have passed continuously for ≥ `stabilityMs`.
     * Drives corner-bracket colour and the "Capturing…" status text.
     */
    readyToCapture: boolean;
    /**
     * Ref version of `readyToCapture` — always holds the latest value and is
     * safe to read inside `useCallback` closures without causing stale-closure
     * issues or needing to be listed in the dependency array.
     */
    readyRef: React.MutableRefObject<boolean>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Continuously validates every camera frame against 5 local quality checks
 * using only the Canvas API and native arithmetic — no ML, no WebAssembly,
 * no external libraries.
 *
 * **Why this matters**: Every frame sent to the Next.js /api/kyc/analyze-id
 * endpoint triggers an AWS Textract AnalyzeID call (≈ $0.015 each). Gating
 * that call behind a cheap local pre-check pass eliminates bad-frame charges
 * and gives users real-time feedback to fix their framing before we spend
 * anything on the cloud.
 *
 * **Checks (evaluation order, cheapest first)**:
 *  1. Brightness  — mean luma within [minBrightness, maxBrightness]
 *  2. Glare       — blown-out pixel fraction ≤ 5 % (luma > 245)
 *  3. Sharpness   — Sobel edge variance ≥ minSharpness
 *  4. Stability   — mean frame diff vs previous sample ≤ 12 luma units
 *  5. Card        — centre/outer Sobel density ratio ≥ 1.3
 *
 * **Usage**:
 * ```tsx
 * const { checkResult, stableDuration, readyToCapture, readyRef } =
 *   useFrameValidation(videoRef, isPollingActive, { stabilityMs: 1000 });
 *
 * // Drive status text:
 * useEffect(() => {
 *   if (!checkResult?.pass) setStatusText(reasonToText(checkResult?.reason));
 *   else if (!readyToCapture) setStatusText('Hold steady…');
 *   else setStatusText('Capturing…');
 * }, [checkResult, readyToCapture]);
 *
 * // Gate AWS call in polling loop:
 * if (!readyRef.current) continue;
 * const frame = await cropFrame();
 * // …send to API
 * ```
 *
 * @param videoRef   Ref to the live `<video>` element.
 * @param active     Set to `false` to pause validation (e.g., while processing
 *                   an AWS response). Automatically resets all state.
 * @param options    Tuning parameters — see {@link FrameValidationOptions}.
 */
export function useFrameValidation(
    videoRef: React.RefObject<HTMLVideoElement | null>,
    active: boolean,
    options: FrameValidationOptions = {},
): FrameValidationResult {
    const { stabilityMs = 1000, intervalMs = 500, thresholds, staticMotionThreshold = 3.0 } = options;

    const [checkResult, setCheckResult] = useState<LocalCheckResult | null>(null);
    const [stableDuration, setStableDuration] = useState(0);
    const [readyToCapture, setReadyToCapture] = useState(false);

    // Refs that the rAF loop reads/writes without causing re-renders.
    const prevImgRef      = useRef<ImageData | null>(null);
    const stableStartRef  = useRef<number | null>(null);
    const lastCheckRef    = useRef(0);
    // Tracks the last emitted result key so we can suppress duplicate updates
    // when the scene is static (motion ≈ 0) and the outcome hasn't changed.
    const lastResultKeyRef = useRef<string>('');

    // readyRef is the closure-safe version of readyToCapture.
    const readyRef = useRef(false);
    // Keep it in sync with the state value so external closures always read
    // the latest value without needing it in their dependency arrays.
    useEffect(() => {
        readyRef.current = readyToCapture;
    }, [readyToCapture]);

    const reset = useCallback(() => {
        prevImgRef.current      = null;
        stableStartRef.current  = null;
        lastCheckRef.current    = 0;
        lastResultKeyRef.current = '';
        setCheckResult(null);
        setStableDuration(0);
        setReadyToCapture(false);
        readyRef.current = false;
    }, []);

    useEffect(() => {
        if (!active) {
            reset();
            return;
        }

        let rafId: number;

        const loop = (now: number) => {
            // Throttle to at most one check per intervalMs.
            if (now - lastCheckRef.current >= intervalMs) {
                lastCheckRef.current = now;

                const video = videoRef.current;
                // video.readyState >= 2 (HAVE_CURRENT_DATA) means there is at
                // least one decoded frame available to read.
                if (video && video.readyState >= 2) {
                    const result = runLocalPreChecks(video, prevImgRef.current, thresholds);

                    // Capture the current downsampled frame so the next call
                    // can compute a pixel-diff motion score.
                    const img = getDownsampledImageData(video);
                    if (img) prevImgRef.current = img;

                    if (result) {
                        // Build a result key: "pass" or "fail:<reason>".
                        const resultKey = result.pass ? 'pass' : `fail:${result.reason ?? 'unknown'}`;

                        // Scene-change guard — skip the state update (and all
                        // downstream effects) when the scene is static AND the
                        // outcome category hasn't changed.  This prevents the
                        // status-text debounce from re-firing every intervalMs
                        // while the user is reading the current message.
                        const sceneIsStatic =
                            result.motion < staticMotionThreshold &&
                            prevImgRef.current !== null;

                        const shouldUpdate = !sceneIsStatic || resultKey !== lastResultKeyRef.current;

                        if (!shouldUpdate) {
                            // Scene is static and outcome is unchanged — silently
                            // advance the stability timer so readyToCapture can
                            // flip without triggering the status-text effect.
                            if (result.pass && stableStartRef.current !== null) {
                                const elapsed = now - stableStartRef.current;
                                const ready   = elapsed >= stabilityMs;
                                if (ready !== readyRef.current) {
                                    setReadyToCapture(ready);
                                    readyRef.current = ready;
                                    setStableDuration(elapsed);
                                }
                            }
                        } else {
                            lastResultKeyRef.current = resultKey;
                            setCheckResult(result);

                            if (result.pass) {
                                if (stableStartRef.current === null) {
                                    stableStartRef.current = now;
                                }
                                const elapsed = now - stableStartRef.current;
                                setStableDuration(elapsed);

                                const ready = elapsed >= stabilityMs;
                                setReadyToCapture(ready);
                                readyRef.current = ready;
                            } else {
                                stableStartRef.current = null;
                                setStableDuration(0);
                                setReadyToCapture(false);
                                readyRef.current = false;
                            }
                        }
                    }
                }
            }

            rafId = requestAnimationFrame(loop);
        };

        rafId = requestAnimationFrame(loop);
        return () => {
            cancelAnimationFrame(rafId);
            reset();
        };
    }, [active, intervalMs, stabilityMs, thresholds, videoRef, reset]);

    return { checkResult, stableDuration, readyToCapture, readyRef };
}
