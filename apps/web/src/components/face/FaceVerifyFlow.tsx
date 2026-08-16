'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useCamera } from '@/hooks/useCamera';
import { startReverify, submitReverify } from '@/lib/kycApi';
import type { FaceVerifyOutcome, FaceVerifyFailReason } from '@/types/reverify';
import FaceScanOverlay from './FaceScanOverlay';

type FlowState = 'intro' | 'matching' | 'success' | 'fail';
type FailReason = FaceVerifyFailReason;

interface FaceVerifyFlowProps {
    challengeId: string;
    reason?: string;
    /** Settled exactly once when the user passes, gives up, or cancels. */
    onResult: (outcome: FaceVerifyOutcome) => void;
}

/**
 * Self-contained "Face ID"-style re-verification flow.
 *
 * Opens the front camera in a framed preview, captures a single straight-face
 * frame, and submits it to the Worker which runs an AWS liveness/quality gate +
 * CompareFaces against the user's enrolled KYC selfie. The pass/fail decision is
 * made ONLY in NestJS; this screen just renders the returned result.
 *
 * Default path is the passive single-frame capture (no head turns, ~sub-2s) to
 * stay inside the ~5s budget.
 */
export default function FaceVerifyFlow({ challengeId, reason, onResult }: FaceVerifyFlowProps) {
    const {
        videoRef,
        canvasRef,
        isActive,
        error,
        shouldMirror,
        startCamera,
        stopCamera,
        captureFrame,
    } = useCamera({ facingMode: 'user' });

    const [state, setState] = useState<FlowState>('intro');
    const [faceDetected, setFaceDetected] = useState(false);
    const [message, setMessage] = useState(
        'Position your face in the frame and make sure the lighting is good.',
    );
    const failReasonRef = useRef<FailReason>('error');
    const settledRef = useRef(false);

    useEffect(() => {
        startCamera();
        return () => stopCamera();
    }, [startCamera, stopCamera]);

    // Detect a face once verification starts, so the scan animations only
    // appear over an actual face. Uses the native FaceDetector API where
    // available (Chrome/Android); elsewhere falls back to a short delay so
    // the experience degrades gracefully rather than never animating.
    useEffect(() => {
        if (state !== 'matching') {
            setFaceDetected(false);
            return;
        }
        let cancelled = false;
        let timer: number | undefined;
        const FaceDetectorCtor = (window as unknown as { FaceDetector?: new (opts?: object) => { detect(el: HTMLVideoElement): Promise<unknown[]> } }).FaceDetector;

        if (!FaceDetectorCtor) {
            timer = window.setTimeout(() => {
                if (!cancelled) setFaceDetected(true);
            }, 600);
            return () => {
                cancelled = true;
                window.clearTimeout(timer);
            };
        }

        const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 1 });
        const poll = async () => {
            const video = videoRef.current;
            if (video && video.readyState >= 2) {
                try {
                    const faces = await detector.detect(video);
                    if (cancelled) return;
                    if (faces.length > 0) {
                        setFaceDetected(true);
                        return; // found — stop polling
                    }
                } catch {
                    // Detector unsupported at runtime (e.g. flag off) — degrade
                    // to showing the animation rather than never showing it.
                    if (!cancelled) setFaceDetected(true);
                    return;
                }
            }
            if (!cancelled) timer = window.setTimeout(poll, 350);
        };
        poll();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [state, videoRef]);

    const settle = useCallback(
        (outcome: FaceVerifyOutcome) => {
            if (settledRef.current) return;
            settledRef.current = true;
            stopCamera();
            onResult(outcome);
        },
        [onResult, stopCamera],
    );

    const run = useCallback(async () => {
        setState('matching');
        setMessage("Verifying it's you…");
        try {
            // Validates the challenge (and, on the streaming path, opens the AWS session).
            await startReverify(challengeId);

            const frame = captureFrame();
            if (!frame) {
                failReasonRef.current = 'error';
                setState('fail');
                setMessage('Could not read the camera. Please try again.');
                return;
            }

            const res = await submitReverify({ challengeId, liveFaceImageData: frame });

            if (res.status === 'passed' && res.stepToken) {
                setState('success');
                setMessage("Verified — it's you.");
                window.setTimeout(() => settle({ ok: true, stepToken: res.stepToken! }), 900);
                return;
            }

            // Map the failure to an outcome reason for the caller.
            failReasonRef.current =
                res.code === 'LIVENESS_FAILED' || res.code === 'FACE_NOT_DETECTED'
                    ? 'liveness'
                    : res.status === 'failed'
                      ? 'mismatch'
                      : 'error';
            setState('fail');
            setMessage(
                res.message ?? res.reason ?? "We couldn't verify it's you. Please try again.",
            );
        } catch {
            failReasonRef.current = 'error';
            setState('fail');
            setMessage('Something went wrong. Please try again.');
        }
    }, [challengeId, captureFrame, settle]);

    const borderColor = state === 'success' ? '#34D317' : state === 'fail' ? '#FF5F61' : '#388CFF';

    return (
        <div className="flex flex-col h-full bg-white px-xd-40">
            {/* Close button */}
            <div className="flex absolute top-xd-50 right-xd-30 justify-end mb-2">
                <button
                    onClick={() => settle({ ok: false, reason: 'cancelled' })}
                    className="text-red-400 hover:text-red-600"
                    aria-label="Cancel verification"
                >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path
                            d="M5 5L15 15M15 5L5 15"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            </div>

            <div className="flex-1" />

            <h1 className="text-xd-30 font-bold text-center text-[#1D1D1D] mb-xd-5">
                Verify it&apos;s you
            </h1>
            <p className="text-center text-xd-16 font-medium text-[#1D1D1D] mb-xd-11 px-4">
                {message}
            </p>

            {/* Framed live camera preview */}
            <motion.div
                className="relative mx-auto overflow-hidden rounded-xd-30 transition-colors duration-500 w-xd-350 h-xd-400 bg-[#1C1C1E]"
                style={{
                    border: `1px solid ${borderColor}`,
                    boxShadow:
                        state === 'matching'
                            ? '0 0 28px rgba(56,140,255,0.35)'
                            : state === 'success'
                              ? '0 0 28px rgba(52,211,23,0.35)'
                              : 'none',
                }}
                animate={state === 'fail' ? { x: [0, -9, 9, -6, 6, -2, 0] } : { x: 0 }}
                transition={{ duration: 0.45, ease: 'easeInOut' }}
            >
                <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover"
                    style={shouldMirror ? { transform: 'scaleX(-1)' } : undefined}
                />
                <canvas ref={canvasRef} className="hidden" />

                {/* Face ID-style AI scanning overlay */}
                <FaceScanOverlay state={state} faceDetected={faceDetected} />

                {/* {error && (
                    <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                        <span className="text-xs text-white/80">{error}</span>
                    </div>
                )} */}
            </motion.div>

            {reason && state === 'intro' && (
                <p className="text-xd-12 text-center text-[#8D8D8D] mt-xd-12 px-4">{reason}</p>
            )}

            <div className="flex-1" />

            {/* Actions */}
            <div className="mt-auto flex items-center flex-col justify-end pb-xd-35">
                {state === 'intro' && (
                    <button
                        onClick={run}
                        disabled={!isActive}
                        className="w-xd-390 h-xd-60 py-4 rounded-xd-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] text-xd-16 font-medium disabled:opacity-40"
                    >
                        Start Verification
                    </button>
                )}

                {state === 'fail' && (
                    <>
                        <button
                            onClick={() => {
                                setState('intro');
                                setMessage(
                                    'Position your face in the frame and make sure the lighting is good.',
                                );
                            }}
                            className="w-xd-390 h-xd-60 py-4 rounded-xd-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] text-xd-16 font-medium"
                        >
                            Try Again
                        </button>
                        <button
                            onClick={() => settle({ ok: false, reason: failReasonRef.current })}
                            className="text-xd-14 mt-xd-30 text-[#4D84FF] hover:underline"
                        >
                            Cancel
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
