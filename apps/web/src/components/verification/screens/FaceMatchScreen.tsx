'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import { useEnrollFlow } from '@/context/EnrollFlowContext';
import { matchFaceToID, startSession, submitVerification } from '@/lib/kycApi';
import ExitConfirmDialog from '../ExitConfirmDialog';
import faceDetectSvg from '@/assets/icons/face-detect.svg';
import liveDetectIdSvg from '@/assets/icons/live-detect-id.svg';
import FlexibleSpace from '@/components/layout/FlexibleSpace';

type MatchState = 'matching' | 'success' | 'review' | 'failed';

// Animation timing — matches user's spec.
const TOTAL_ANIM_MS = 10_000; // 10 sec total comparison animation
const OPACITY_STEP_MS = 1_000; // each opacity transition lasts 1 sec
const FRAME_FLASHES_PER_CYCLE = 3; // flashes 3 times during each ID-visible cycle
const FRAME_FLASH_MS = 300; // each flash lasts 300 ms

export default function FaceMatchScreen({ onExit }: { onExit: () => void }) {
    const {
        livenessResult,
        idDocument,
        setMatchResult,
        recordAttempt,
        kycSessionId,
        setKycSessionId,
        completeStep,
        goBack,
    } = useEnrollFlow();

    const [matchState, setMatchState] = useState<MatchState>('matching');
    const [subtitle, setSubtitle] = useState('AI is comparing your face with your ID...');
    const [showExitDialog, setShowExitDialog] = useState(false);
    const [animDone, setAnimDone] = useState(false);
    const [frameFlashOn, setFrameFlashOn] = useState(false);

    const apiResultRef = useRef<{
        status: 'success' | 'error';
        matchScore?: number;
        message?: string;
    } | null>(null);

    // A KYC session is single-use: NestJS marks it "consumed" on the FIRST submit
    // (even a rejected one). This records the sessionId we've already submitted with,
    // so a retry (the "try again" → runMatch path) fetches a FRESH session instead of
    // re-submitting the consumed one — which fails with "KYC session has already been
    // consumed".
    const submittedSessionRef = useRef<string | null>(null);

    const handleFailure = useCallback(
        (msg?: string) => {
            // NOTE: do NOT increment the attempt count here. A failed face
            // detection / compare is not a "try" — the count is bumped once per
            // actual submit (see finaliseAfterAnimation). The final block/decision
            // is owned by the NestJS backend, never the client.
            setMatchState('failed');
            setSubtitle(msg || 'ID Matching With Your Photo Not Correct');
        },
        [],
    );

    const finaliseAfterAnimation = useCallback(async () => {
        const data = apiResultRef.current;
        if (!data) {
            handleFailure('Face match timed out — please try again');
            return;
        }
        if (data.status === 'success') {
            const score = data.matchScore ?? 90;
            setMatchResult({
                isMatch: true,
                confidence: score / 100,
                similarity: score,
                verdict: 'pass',
                errorMessage: null,
            });
            setMatchState('success');
            setSubtitle('ID Matching With Your Photo Done');

            if (idDocument && livenessResult?.faceImageData) {
                // Ensure we have a session. If the one fetched on page mount is
                // missing (e.g. its request 401'd on an expired token), fetch a fresh
                // one here so we ALWAYS submit to NestJS and let the backend decide —
                // never silently skip submit and "decide" in the client.
                // Fetch a fresh session when we have none (mount fetch 401'd) OR when the
                // current one was already submitted (consumed) — e.g. on a retry after a
                // rejected attempt. Otherwise NestJS rejects the resubmit as consumed.
                let sessionId = kycSessionId;
                if (!sessionId || sessionId === submittedSessionRef.current) {
                    try {
                        const s = await startSession();
                        sessionId = s.sessionId;
                        setKycSessionId(sessionId);
                    } catch (err) {
                        console.error('[FaceMatch] session fetch failed:', err);
                    }
                }
                if (!sessionId) {
                    handleFailure('Could not start a verification session. Please try again.');
                    return;
                }

                // The backend requires a non-empty ID number. Depending on the
                // document, the OCR result lands in either `nationalNumber` or its
                // `documentNumber` alias — send whichever is present in both fields
                // so the Worker → NestJS `nationalIdNumber` is never empty.
                const idNumber = idDocument.nationalNumber || idDocument.documentNumber || '';
                // Mark consumed BEFORE the call: once NestJS receives this submit the
                // session is spent, so any retry must start a fresh one.
                submittedSessionRef.current = sessionId;
                // Count an attempt only on a real submit to NestJS — not on
                // earlier detection/compare failures.
                recordAttempt('face-match');
                try {
                    const res = await submitVerification({
                        kycSessionId: sessionId,
                        frontImageData: idDocument.frontImageData,
                        backImageData: idDocument.backImageData || undefined,
                        selfieImageData: livenessResult.faceImageData,
                        selfieVsIdScore: score,
                        // Forwarded so the NestJS backend can factor liveness into
                        // its decision now that there is no video step. The
                        // approved/pending/rejected decision is made ONLY in NestJS.
                        livenessConfidence: livenessResult.metrics?.confidence,
                        extracted: {
                            idType: idDocument.idType,
                            country: idDocument.country,
                            // `name` is the person's full name (worker `extracted.name`).
                            // NOT `idName` — that field carries the document-type label
                            // ("PASSPORT", "Syrian National ID"), which would be submitted
                            // as the user's fullName.
                            name: idDocument.name ?? idDocument.idName,
                            nationalNumber: idNumber,
                            documentNumber: idNumber,
                            birthday: idDocument.birthday,
                            expiryDate: idDocument.expiryDate,
                        },
                    });
                    const status = res.kycRequest?.status;
                    console.log('[FaceMatch] KYC submitted:', status);
                    // The backend is the source of truth. Only show success when it
                    // approved (or left the request pending). A rejected decision
                    // (e.g. "selfie does not match ID photo") must show the failure
                    // with the backend's own reason — never an optimistic "verified".
                    if (status === 'rejected') {
                        handleFailure(
                            res.kycRequest?.rejectionReason || 'Verification was not approved.',
                        );
                    } else {
                        completeStep();
                    }
                } catch (err) {
                    console.error('[FaceMatch] KYC submit failed:', err);
                    handleFailure(
                        err instanceof Error && err.message
                            ? err.message
                            : 'We could not submit your verification. Please try again.',
                    );
                }
            } else {
                console.warn('[FaceMatch] Skipping submit — missing:', {
                    kycSessionId,
                    hasIdDocument: !!idDocument,
                    hasFace: !!livenessResult?.faceImageData,
                });
                handleFailure('Missing verification data — please start again.');
            }
        } else {
            setMatchResult({
                isMatch: false,
                confidence: 0,
                similarity: 0,
                verdict: 'fail',
                errorMessage: data.message ?? 'Face did not match',
            });
            handleFailure(data.message);
        }
    }, [handleFailure, setMatchResult, completeStep, recordAttempt, idDocument, livenessResult, kycSessionId, setKycSessionId]);

    const runMatch = useCallback(async () => {
        setMatchState('matching');
        setSubtitle('AI is comparing your face with your ID...');
        setAnimDone(false);
        hasFinalisedRef.current = false;
        apiResultRef.current = null;

        const liveFace = livenessResult?.faceImageData ?? '';
        const idFace = idDocument?.idFaceImageData || idDocument?.frontImageData || '';

        if (!liveFace || !idFace) {
            handleFailure('Missing face or ID image');
            return;
        }

        // Fire AWS CompareFaces in parallel with the 10s animation.
        try {
            const res = await fetch('/api/kyc/compare-face', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selfieImageData: liveFace, idFaceImageData: idFace }),
            });
            apiResultRef.current = (await res.json()) as {
                status: 'success' | 'error';
                matchScore?: number;
                message?: string;
            };
        } catch {
            apiResultRef.current = { status: 'error', message: 'Compare service unreachable' };
        }
    }, [livenessResult, idDocument, handleFailure]);

    useEffect(() => {
        runMatch();
    }, []);

    // Drive the comparison animation: every 2s a new cycle (1s ID visible, 1s
    // face visible). During the ID-visible second, fire 3 frame-flashes 300ms apart.
    useEffect(() => {
        if (matchState !== 'matching') return;
        const start = Date.now();
        const cycleMs = OPACITY_STEP_MS * 2; // 2000 ms per cycle
        const flashGap = OPACITY_STEP_MS / FRAME_FLASHES_PER_CYCLE; // ≈ 333 ms

        const flashTimers: number[] = [];
        const cycleInterval = window.setInterval(() => {
            // Schedule the 3 flashes at the start of every cycle (when ID is opaque).
            for (let i = 0; i < FRAME_FLASHES_PER_CYCLE; i++) {
                const t1 = window.setTimeout(() => setFrameFlashOn(true), i * flashGap);
                const t2 = window.setTimeout(
                    () => setFrameFlashOn(false),
                    i * flashGap + FRAME_FLASH_MS,
                );
                flashTimers.push(t1, t2);
            }
        }, cycleMs);
        // Fire the first flash burst immediately
        for (let i = 0; i < FRAME_FLASHES_PER_CYCLE; i++) {
            const t1 = window.setTimeout(() => setFrameFlashOn(true), i * flashGap);
            const t2 = window.setTimeout(
                () => setFrameFlashOn(false),
                i * flashGap + FRAME_FLASH_MS,
            );
            flashTimers.push(t1, t2);
        }

        const stopTimer = window.setTimeout(() => {
            window.clearInterval(cycleInterval);
            flashTimers.forEach(window.clearTimeout);
            setAnimDone(true);
        }, TOTAL_ANIM_MS);

        return () => {
            window.clearInterval(cycleInterval);
            window.clearTimeout(stopTimer);
            flashTimers.forEach(window.clearTimeout);
            const elapsed = Date.now() - start;
            void elapsed; // keep linter happy; useful when debugging timing
        };
    }, [matchState]);

    const hasFinalisedRef = useRef(false);
    // Once the animation completes, look at the API result and decide.
    // Guard with a ref so the effect never fires twice even if finaliseAfterAnimation
    // changes identity after the first state update (which would cause an infinite loop).
    useEffect(() => {
        if (!animDone || hasFinalisedRef.current) return;
        hasFinalisedRef.current = true;
        finaliseAfterAnimation();
    }, [animDone]); // eslint-disable-line react-hooks/exhaustive-deps

    const borderColor =
        matchState === 'success' ? '#34D317' : matchState === 'failed' ? '#FF5F61' : '#388CFF';

    const liveFace = livenessResult?.faceImageData;
    const idImage = idDocument?.frontImageData || idDocument?.idFaceImageData;

    return (
        <div className="flex flex-col h-full bg-white px-xd-40">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={onExit}
            />

            <div className="flex absolute top-xd-50 right-xd-30 justify-end mb-2">
                <button
                    onClick={() => setShowExitDialog(true)}
                    className="text-red-400 hover:text-red-600"
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

            <FlexibleSpace size={100} share={0.3} />

            <h1 className="text-xd-30 font-bold text-center text-[#1D1D1D] mb-xd-5">
                Identity Verification !
            </h1>
            <div className="flex items-center justify-center gap-2 mb-xd-11">
                <Image src={faceDetectSvg} alt="face" className="object-contain w-xd-20 h-xd-20" />
                <Image src={liveDetectIdSvg} alt="id" className="object-contain w-xd-20 h-xd-20" />
                <span className="text-xd-16 font-medium text-[#1D1D1D] whitespace-nowrap">
                    {subtitle}
                </span>
            </div>

            {/* Comparison stage: face (back) and ID (front, fading) on the same canvas */}
            <div
                className="relative mx-auto overflow-hidden rounded-xd-30 transition-colors duration-500 w-xd-350 h-xd-400 bg-[#E9EEEE]"
                style={{ border: `2px solid ${borderColor}` }}
            >
                {/* User face — always rendered */}
                {liveFace ? (
                    <img
                        src={liveFace}
                        alt="Face"
                        className="absolute inset-0 w-full h-full object-cover"
                        style={{ backgroundColor: '#E9EEEE' }}
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-gray-400 text-xs">Face Photo</span>
                    </div>
                )}

                {/* AI scanning line over the face — moves while matching */}
                {matchState === 'matching' && (
                    <motion.div
                        className="absolute left-0 right-0 pointer-events-none z-20"
                        style={{
                            height: '3px',
                            background:
                                'linear-gradient(90deg, transparent 0%, rgba(122,168,255,0.95) 50%, transparent 100%)',
                            boxShadow: '0 0 14px 3px rgba(122,168,255,0.7)',
                        }}
                        animate={{ top: ['0%', '100%', '0%'] }}
                        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}

                {/* ID image — crossfades over the face every cycle */}
                {idImage && matchState === 'matching' && (
                    <motion.div
                        className="absolute z-10 w-xd-280 h-xd-157 bottom-xd-11 left-xd-35"
                        animate={{ opacity: [0.5, 1, 1, 0.5, 0.5] }}
                        transition={{
                            duration: 2,
                            ease: 'easeInOut',
                            times: [0, 0.5, 0.5, 1, 1],
                            repeat: Infinity,
                        }}
                    >
                        <img
                            src={idImage}
                            alt="ID"
                            className="w-full h-full object-cover bg-[#E9EEEE]"
                        />

                        {/* Small face frame on the ID — flashes 3× during each cycle.
                            Position approximates a typical ID layout (left-third). */}
                        <AnimatePresence>
                            {frameFlashOn && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.94 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.94 }}
                                    transition={{ duration: 0.15 }}
                                    className="absolute pointer-events-none"
                                    style={{
                                        top: '22%',
                                        left: '8%',
                                        width: '28%',
                                        height: '46%',
                                        borderRadius: '6px',
                                    }}
                                >
                                    <div className="absolute inset-0 rounded-md" />
                                    {/* ID camera-style corner brackets */}
                                    <span
                                        className="absolute"
                                        style={{
                                            top: -2,
                                            left: -2,
                                            width: 14,
                                            height: 14,
                                            borderTop: '3px solid #FFD700',
                                            borderLeft: '3px solid #FFD700',
                                            borderRadius: '8px 0 0 0',
                                        }}
                                    />
                                    <span
                                        className="absolute"
                                        style={{
                                            top: -2,
                                            right: -2,
                                            width: 14,
                                            height: 14,
                                            borderTop: '3px solid #FFD700',
                                            borderRight: '3px solid #FFD700',
                                            borderRadius: '0 8px 0 0',
                                        }}
                                    />
                                    <span
                                        className="absolute"
                                        style={{
                                            bottom: -2,
                                            left: -2,
                                            width: 14,
                                            height: 14,
                                            borderBottom: '3px solid #FFD700',
                                            borderLeft: '3px solid #FFD700',
                                            borderRadius: '0 0 0 8px',
                                        }}
                                    />
                                    <span
                                        className="absolute"
                                        style={{
                                            right: -2,
                                            bottom: -2,
                                            width: 14,
                                            height: 14,
                                            borderRight: '3px solid #FFD700',
                                            borderBottom: '3px solid #FFD700',
                                            borderRadius: '0 0 8px 0',
                                        }}
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )}
            </div>

            {matchState === 'review' && (
                <div className="mt-5 mx-auto max-w-75 rounded-xl border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-4 py-3 text-center">
                    <p className="text-xs text-center font-medium text-[#92400E]">
                        Match accepted with low confidence — your verification will be reviewed by
                        our team. Continuing to the next step…
                    </p>
                </div>
            )}
            {matchState === 'failed' && (
                <p className="text-xd-14 text-center text-[#1D1D1D] mt-xd-12 mb-5">
                    We noticed a discrepancy in the image and there is an issue with your
                    verification.
                </p>
            )}

            <FlexibleSpace size={150} share={0.6} />

            {matchState === 'failed' && (
                <div className="mt-auto flex items-center flex-col justify-end">
                    <div className="flex-1" />
                    <button
                        // rdb reset the whole session and jumped to 'intro'. Here
                        // the flow steps back one stage: with a token-driven step
                        // list there is no fixed first screen to jump to, and
                        // re-running the previous capture is what the user needs.
                        onClick={goBack}
                        className="w-xd-390 h-xd-60 py-4 rounded-xd-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] text-xd-16 font-medium"
                    >
                        Try Again With The Correction
                    </button>
                    <button
                        onClick={() => runMatch()}
                        className="text-xd-14 mt-xd-30 text-[#4D84FF] hover:underline"
                    >
                        Rematch
                    </button>
                </div>
            )}
            <FlexibleSpace size={35} share={0.1} />
        </div>
    );
}
