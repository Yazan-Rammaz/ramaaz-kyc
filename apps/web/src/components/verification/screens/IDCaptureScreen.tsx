'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { useEnrollFlow } from '@/context/EnrollFlowContext';
import { useCamera } from '@/hooks/useCamera';
import { analyzeId } from '@/lib/kycApi';
import { verifyBackMatchesFront } from '@/services/kyc/backSideVerifier';
import { useFrameValidation } from '@/hooks/useFrameValidation';
import { useFaceLandmarker } from '@/hooks/useFaceLandmarker';
import { useDocumentScanner } from '@/hooks/useDocumentScanner';
import type { IDDocument } from '@ramaaz/kyc-shared/types';
import type { AnalyzeIdResult } from '@ramaaz/kyc-shared/types/analyze-id';
import liveDetectIdSvg from '@/assets/icons/live-detect-id.svg';
import idFrontSvg from '@/assets/icons/id-front.svg';
import idBackSvg from '@/assets/icons/id-back.svg';
import shieldSvg from '@/assets/icons/shield.svg';
import ExitConfirmDialog from '../ExitConfirmDialog';
import FlexibleSpace from '@/components/layout/FlexibleSpace';
import { idConfig, kycConfig } from '@ramaaz/kyc-shared/config';
import { FaceProgressBar } from '../FaceProgressBar';

type PollState = 'idle' | 'aligning' | 'capturing' | 'processing' | 'success' | 'done';

/** Shoelace formula — signed area of an arbitrary quad from ScannerCorners. */
function getQuadArea(c: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
}): number {
    const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
    let area = 0;
    for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        area += pts[i].x * pts[j].y;
        area -= pts[j].x * pts[i].y;
    }
    return Math.abs(area) / 2;
}

// Compares two base64 images by shrinking them to 32x32 and calculating Mean Absolute Pixel Difference.
const areImagesTooSimilar = async (base1: string, base2: string): Promise<boolean> => {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            resolve(false);
            return;
        }

        const i1 = new window.Image();
        const i2 = new window.Image();
        let loaded = 0;

        const finish = () => {
            loaded++;
            if (loaded !== 2) return;

            const c1 = document.createElement('canvas');
            const c2 = document.createElement('canvas');
            c1.width = 32;
            c1.height = 32;
            c2.width = 32;
            c2.height = 32;

            const ctx1 = c1.getContext('2d');
            const ctx2 = c2.getContext('2d');
            if (!ctx1 || !ctx2) {
                resolve(false);
                return;
            }

            ctx1.drawImage(i1, 0, 0, 32, 32);
            ctx2.drawImage(i2, 0, 0, 32, 32);

            const d1 = ctx1.getImageData(0, 0, 32, 32).data;
            const d2 = ctx2.getImageData(0, 0, 32, 32).data;

            let diff = 0;
            // Compare RGB channels
            for (let i = 0; i < d1.length; i += 4) {
                diff +=
                    Math.abs(d1[i] - d2[i]) +
                    Math.abs(d1[i + 1] - d2[i + 1]) +
                    Math.abs(d1[i + 2] - d2[i + 2]);
            }

            const avgDiff = diff / (32 * 32 * 3); // Range: 0 to 255
            // If average pixel difference is less than 20, they are practically the same image
            resolve(avgDiff < 20);
        };

        i1.onload = finish;
        i2.onload = finish;
        i1.onerror = () => resolve(false);
        i2.onerror = () => resolve(false);
        i1.src = base1;
        i2.src = base2;
    });
};

// On back side, a tiny printed portrait can exist on some IDs (e.g. Syrian ID).
// We only block capture when the detected face is large enough to indicate that
// the user is likely still showing the FRONT side.
const BACK_SIDE_FACE_BLOCK_MIN_AREA_RATIO = 0.08;

/**
 * `onExit` is supplied by the route rather than taken from a router: this screen
 * runs on the hosted KYC origin and "leaving" means handing the user back to the
 * consumer app, which only the route knows how to do safely (the returnTo
 * allowlist). In rdb this was a local `router.push('/home')`.
 */
export default function IDCaptureScreen({ onExit }: { onExit: () => void }) {
    // Note: no goTo(). rdb's screens named their own successor
    // (`goTo('id-summary')`), which hardcoded the journey into every screen.
    // Here the screen only reports that its stage finished and the flow — driven
    // by the token's `steps` — decides what comes next.
    const { setIdDocument } = useEnrollFlow();
    const {
        videoRef,
        canvasRef,
        isActive,
        error: cameraError,
        startCamera,
        stopCamera,
        shouldMirror,
        captureFrame,
    } = useCamera({ facingMode: 'environment' });

    const [pollState, setPollState] = useState<PollState>('idle');
    const [activeSide, setActiveSide] = useState<'front' | 'back'>('front');
    const [frontImageData, setFrontImageData] = useState<string | null>(null);
    const [backImageData, setBackImageData] = useState<string | null>(null);
    const [frontPartial, setFrontPartial] = useState<Partial<IDDocument> | null>(null);
    const [statusText, setStatusText] = useState('Press the button below to start camera');
    const [captureHint, setCaptureHint] = useState<string | null>(null);
    const [showExitDialog, setShowExitDialog] = useState(false);
    const [isPassport, setIsPassport] = useState(false);
    const [isVerifying, setIsVerifying] = useState(false);
    const [showFlash, setShowFlash] = useState(false);
    const [debugPreview, setDebugPreview] = useState<string | null>(null);

    const {
        isReady,
        isDetecting,
        isStable,
        corners: docCorners,
        overlay: scannerOverlay,
        capture: captureDocument,
    } = useDocumentScanner(videoRef, {
        enabled: !isVerifying,
        processEveryNFrames: kycConfig.id.openCV.processEveryNFrames,
        maxProcessingWidth: kycConfig.id.openCV.maxProcessingWidth,
        minAreaRatio: kycConfig.id.openCV.minAreaRatio,
        maxOutputWidth: kycConfig.id.openCV.maxOutputWidth,
        smoothingAlpha: kycConfig.id.openCV.smoothingAlpha,
        // The back side can be sparse (a little text / a barcode), so it uses a
        // lower content bar than the photo-rich front to avoid false rejects.
        minInteriorDensity:
            activeSide === 'back'
                ? kycConfig.id.openCV.minInteriorDensityBack
                : kycConfig.id.openCV.minInteriorDensityFront,
    });

    /** Maps backend rejection codes/reasons to user-facing guidance. */
    function codeToHint(
        code: string | null | undefined,
        reason: string | null | undefined,
        message?: string | null,
    ): string | null {
        // Prefer the structured message from the API when available — it's
        // already a short, user-friendly global message.
        if (message) return message;
        // Legacy reason-based fallback (older API responses without `message`).
        switch (reason ?? code) {
            case 'INVALID_ID_TYPE':
            case 'invalid_id_type':
                return 'This is not a supported ID. Use a passport or national ID.';
            case 'MISSING_CRITICAL_DATA':
            case 'insufficient_fields':
            case 'NO_TEXT_DETECTED':
            case 'no_text_detected':
                return 'ID not clearly readable. Hold the card flat, well-lit, and try again.';
            case 'WRONG_SIDE':
            case 'wrong_side':
                return activeSide === 'back'
                    ? 'This is the front of your ID. Flip it over and show the back.'
                    : 'This is the back of your ID. Show the side with your photo.';
            case 'SPOOFING_DETECTED':
            case 'spoofing_detected':
                return (
                    message ?? 'Real ID required — please present your original identity document.'
                );
            default:
                return null;
        }
    }

    // analyzeId is a plain function here, not a service instance: the hosted app
    // calls its own same-origin /api/kyc/* proxy, which attaches identity from the
    // session cookie. rdb needed a service object to carry its auth-aware fetch.
    const sessionHintRef = useRef(`session_${Date.now()}`);
    const viewfinderRef = React.useRef<HTMLDivElement>(null);
    const frontImageRef = useRef<string | null>(null);
    const frontPartialRef = useRef<Partial<IDDocument> | null>(null);
    const idFaceImageRef = useRef<string | undefined>(undefined);
    // 3.5 seconds lock when switching to back side
    const flipLockoutRef = useRef(false);
    const [flipLockout, setFlipLockout] = useState(false);
    const isArmedRef = useRef(true);

    // ── Local frame validation ────────────────────────────────────────────────
    // Runs 5 Canvas-API checks on every frame (brightness, glare, sharpness,
    // stability, card detection) before we spend an AWS call.
    // Active only while the camera is on and we're in the 'aligning' state.
    const validationActive = isActive && pollState === 'aligning';
    const { checkResult, stableDuration, readyToCapture } = useFrameValidation(
        videoRef,
        validationActive,
        { stabilityMs: 1000 },
    );

    // ── Face-on-front passive hint ────────────────────────────────────────────
    // Front of any ID has the user's photo. Use the existing MediaPipe
    // landmarker on the rear camera; if no face is seen for ≥3 s while the
    // user is on the FRONT side, suggest they flip the card.
    // This is a *hint only* — it does NOT gate the AWS call. Passports show
    // their photo on the front so this is safe.
    const { detect: detectFace, isReady: faceLandmarkerReady } = useFaceLandmarker();
    const noFaceSinceRef = useRef<number | null>(null);
    const [showFlipHint, setShowFlipHint] = useState(false);
    // Back-side face guard: when the user shows the front during back polling,
    // block AWS calls to prevent overwriting frontImageRef/frontPartialRef.
    const blockBackCaptureRef = useRef(false);

    useEffect(() => {
        if (pollState !== 'aligning' || !faceLandmarkerReady || !isActive) {
            noFaceSinceRef.current = null;
            setShowFlipHint(false);
            blockBackCaptureRef.current = false;
            return;
        }
        const interval = setInterval(() => {
            const video = videoRef.current;
            if (!video) return;
            const result = detectFace(video);
            const hasFace = (result?.faceLandmarks?.length ?? 0) > 0;
            const firstFaceMesh = result?.faceLandmarks?.[0] ?? null;

            let isLargeFaceOnFrame = false;
            if (firstFaceMesh && firstFaceMesh.length > 0) {
                let minX = 1;
                let maxX = 0;
                let minY = 1;
                let maxY = 0;

                for (const p of firstFaceMesh) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                }

                const faceBoxAreaRatio = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
                isLargeFaceOnFrame = faceBoxAreaRatio >= BACK_SIDE_FACE_BLOCK_MIN_AREA_RATIO;
            }

            if (activeSide === 'front') {
                // On front side: hint the user to flip if no face seen for 3 s.
                if (hasFace) {
                    noFaceSinceRef.current = null;
                    setShowFlipHint(false);
                } else if (noFaceSinceRef.current === null) {
                    noFaceSinceRef.current = performance.now();
                } else if (performance.now() - noFaceSinceRef.current >= 3000) {
                    setShowFlipHint(true);
                }
                blockBackCaptureRef.current = false;
            } else {
                // On back side: only block when the detected face is large.
                // Small printed portraits on the back should not be rejected.
                noFaceSinceRef.current = null;
                setShowFlipHint(false);
                if (hasFace && isLargeFaceOnFrame) {
                    blockBackCaptureRef.current = true;
                    setCaptureHint('This is the front of your ID. Flip it over and show the back.');
                } else {
                    blockBackCaptureRef.current = false;
                    setCaptureHint((prev) =>
                        prev === 'This is the front of your ID. Flip it over and show the back.'
                            ? null
                            : prev,
                    );
                }
            }
        }, 300);
        return () => clearInterval(interval);
    }, [activeSide, pollState, faceLandmarkerReady, isActive, detectFace, videoRef]);

    // Two debounce tiers:
    //   FAST  — failure reasons: show quickly so user knows what to fix
    //   SLOW  — pass/transition states: avoid flicker while stabilising
    const DEBOUNCE_FAIL_MS = idConfig.timing.statusDebounceFastMs;
    const DEBOUNCE_TRANSITION_MS = idConfig.timing.statusDebounceMs;
    const statusDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastStatusKeyRef = useRef<string>('');

    useEffect(() => {
        if (pollState !== 'aligning' || !checkResult) return;
        if (flipLockoutRef.current) return;

        let newText: string;
        let key: string;
        let debounceMs: number;

        if (!checkResult.pass) {
            // Each unique failure reason gets its own key so the message always
            // fires when the reason changes (even back to a previous one).
            key = `fail:${checkResult.reason ?? 'unknown'}`;
            debounceMs = DEBOUNCE_FAIL_MS;
            switch (checkResult.reason) {
                case 'too_dark':
                    newText = 'Too dark — move to a brighter area';
                    break;
                case 'too_bright':
                    newText = 'Too bright — find less direct light';
                    break;
                case 'glare':
                    newText = 'Glare — tilt the card to reduce reflections';
                    break;
                case 'too_blurry':
                    newText = 'Blurry — hold the camera steady';
                    break;
                case 'moving':
                    newText = 'Camera moving — hold still';
                    break;
                case 'card_not_detected':
                    newText = 'No card detected — centre your ID in the frame';
                    break;
                case 'wrong_shape':
                    newText = 'Move closer and align the card inside the frame';
                    break;
                case 'screen_detected':
                    newText = 'Use the original card, not a screen';
                    break;
                default:
                    newText = 'Align ID within frame';
                    break;
            }
        } else if (!readyToCapture) {
            key = 'pass:steadying';
            debounceMs = DEBOUNCE_TRANSITION_MS;
            newText = 'Hold steady…';
        } else {
            key = 'pass:ready';
            debounceMs = DEBOUNCE_TRANSITION_MS;
            newText = 'Card detected — scanning…';
        }

        // Allow the same failure key to re-fire if the pass→fail→pass cycle
        // brings the user back to the same reason.
        const isFailure = !checkResult.pass;
        if (!isFailure && key === lastStatusKeyRef.current) return;

        if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
        lastStatusKeyRef.current = key;
        statusDebounceRef.current = setTimeout(() => {
            setStatusText(newText);
            statusDebounceRef.current = null;
        }, debounceMs);
    }, [checkResult, readyToCapture, pollState]);

    useEffect(() => {
        return () => {
            if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
        };
    }, []);

    useEffect(() => {
        return () => {
            stopCamera();
        };
    }, [stopCamera]);

    useEffect(() => {
        if (activeSide === 'back') {
            flipLockoutRef.current = true;
            setFlipLockout(true);
            setStatusText('Please flip to the BACK side...');
            // Only ungate auto-capture after minimum wait; UI lockout stays until card detected
            const timer = setTimeout(() => {
                flipLockoutRef.current = false;
            }, 5000);
            return () => clearTimeout(timer);
        }

        flipLockoutRef.current = false;
        setFlipLockout(false);
    }, [activeSide]);

    const getDetectedDocumentLabel = useCallback(
        (result: AnalyzeIdResult) => {
            const srcDoc = result.extracted ?? result.extractedData ?? {};
            const t = (srcDoc.idType ?? '').toLowerCase();
            const c = srcDoc.country ?? '';
            if (t.includes('passport')) return `${c} Passport detected`;
            if (t.includes('driver')) return `${c} Driver's Licence detected`;
            if (t.includes('turkish') || (t.includes('national_id') && c === 'Turkey')) {
                return 'Turkish National ID detected';
            }
            if (t.includes('syrian') || (t.includes('national_id') && c === 'Syria')) {
                return 'Syrian National ID detected';
            }
            if (c) return `${c} ID detected`;
            return 'ID Detected!';
        },
        [],
    );

    const applyAnalyzeIdSuccess = useCallback(
        async (
            result: AnalyzeIdResult,
            side: 'front' | 'back',
            submittedImage: string,
        ) => {
            setCaptureHint(null);
            setPollState('success');
            setStatusText(getDetectedDocumentLabel(result));

            if (result.nextStep === 'REQUIRE_BACK') {
                if (!result.idFaceImageData) {
                    setPollState('aligning');
                    setStatusText('Align ID within frame...');
                    setCaptureHint(
                        'No face photo found on your ID. Make sure the front side with your photo is facing the camera.',
                    );
                    return;
                }

                const frontImg = result.croppedImageData || submittedImage;
                frontImageRef.current = frontImg;
                idFaceImageRef.current = result.idFaceImageData;
                const srcData = result.extracted ?? result.extractedData;
                const partial = srcData
                    ? {
                          ...srcData,
                          frontImageData: frontImg,
                          idFaceImageData: result.idFaceImageData,
                      }
                    : ({
                          frontImageData: frontImg,
                          idFaceImageData: result.idFaceImageData,
                      } as Partial<IDDocument>);
                frontPartialRef.current = partial;
                setFrontImageData(frontImg);
                setFrontPartial(partial);
                setActiveSide('back');
                setPollState('aligning');
                setStatusText('Now flip to the back side');
                sessionHintRef.current = `session_${Date.now()}`;
                return;
            }

            if (side === 'front') {
                if (!result.idFaceImageData) {
                    setPollState('aligning');
                    setStatusText('Align ID within frame...');
                    setCaptureHint(
                        'No face photo found on your passport. Open to the photo page and try again.',
                    );
                    return;
                }

                const passportImg = result.croppedImageData || submittedImage;
                setFrontImageData(passportImg);
                setIsPassport(true);
                const srcData = result.extractedData ?? result.extracted ?? {};
                const fullDoc: IDDocument = {
                    frontImageData: passportImg,
                    backImageData: '',
                    idFaceImageData: result.idFaceImageData,
                    idType: srcData.idType ?? '',
                    idName: srcData.idName ?? '',
                    country: srcData.country ?? '',
                    name: srcData.name ?? '',
                    firstName: srcData.firstName,
                    lastName: srcData.lastName,
                    nationalNumber: srcData.nationalNumber ?? '',
                    documentNumber: srcData.documentNumber,
                    birthday: srcData.birthday ?? '',
                    expiryDate: srcData.expiryDate,
                    rawText: srcData.rawText,
                };
                setPollState('done');
                setStatusText('Passport Captured!');
                stopCamera();
                // Hand the document to the flow only after the confirmation
                // message has been seen. Setting it immediately would swap in the
                // summary screen mid-message. The summary owns advancing the stage —
                // capture does not call completeStep(), or the review would be skipped.
                setTimeout(() => setIdDocument(fullDoc), 800);
                return;
            }

            const backExtracted = result.extracted ?? result.extractedData ?? {};
            const { verified, reason } = verifyBackMatchesFront(
                frontPartialRef.current ?? {},
                backExtracted,
                backExtracted.rawText ?? '',
            );
            if (!verified) {
                setPollState('aligning');
                setStatusText('Align ID within frame...');
                setCaptureHint(
                    reason ??
                        'This is not the back of your ID. Please use the back of the same document.',
                );
                return;
            }

            const backImg = result.croppedImageData || submittedImage;
            setBackImageData(backImg);
            const front = frontPartialRef.current;
            const fullDoc: IDDocument = {
                frontImageData: frontImageRef.current ?? front?.frontImageData ?? '',
                backImageData: backImg,
                idFaceImageData: idFaceImageRef.current ?? front?.idFaceImageData,
                idType: front?.idType ?? '',
                idName: front?.idName ?? '',
                country: front?.country ?? '',
                name: front?.name ?? '',
                firstName: front?.firstName,
                lastName: front?.lastName,
                nationalNumber: front?.nationalNumber ?? '',
                documentNumber: front?.documentNumber,
                birthday: front?.birthday ?? '',
                expiryDate: front?.expiryDate,
                rawText: front?.rawText,
            };
            setPollState('done');
            setStatusText('ID Capture Complete!');
            stopCamera();
            // Hand the document to the flow only after the confirmation
            // message has been seen. Setting it immediately would swap in the
            // summary screen mid-message. The summary owns advancing the stage —
            // capture does not call completeStep(), or the review would be skipped.
            setTimeout(() => setIdDocument(fullDoc), 800);
        },
        [getDetectedDocumentLabel, setIdDocument, stopCamera],
    );

    const handleCaptureClick = useCallback(async () => {
        if (!isActive) {
            await startCamera();
            setPollState('aligning');
            setStatusText('Align ID within frame...');
            setCaptureHint(null);
            return;
        }

        if (!isReady || isVerifying) return;
        if (!videoRef.current) return;
        if (activeSide === 'back' && blockBackCaptureRef.current) return;

        setIsVerifying(true);
        setPollState('capturing');
        setStatusText('Document detected');

        try {
            // Primary path: OpenCV detected a clean 4-corner card → dewarp it.
            let croppedBase64Card = await captureDocument({
                jpegQuality: kycConfig.id.cropping.clientJpegQuality,
                maxOutputWidth: kycConfig.id.openCV.maxOutputWidth,
            });
            // Fallback: no clean quad available — a corner is off-frame or a finger
            // is covering part of the edge, so the contour isn't a 4-corner convex
            // quad. Send the FULL frame instead and let AWS Textract locate and crop
            // the ID itself (it returns its own croppedImageData). This is what makes
            // capture succeed when the corners aren't all visible.
            if (!croppedBase64Card) {
                console.warn('[IDCapture] no quad — falling back to full-frame capture for Textract');
                croppedBase64Card = captureFrame();
            }
            if (!croppedBase64Card) {
                throw new Error('Could not capture the document. Please try again.');
            }

            if (activeSide === 'front') {
                frontImageRef.current = croppedBase64Card;
            } else if (activeSide === 'back' && frontImageRef.current) {
                const isSame = await areImagesTooSimilar(frontImageRef.current, croppedBase64Card);
                if (isSame) {
                    console.warn(
                        '🛑 Captured image is too similar to the front side. Rejecting silently.',
                    );
                    setCaptureHint('This looks like the front side again. Please flip the card.');
                    setPollState('aligning');
                    setFlipLockout(true);
                    setIsVerifying(false);
                    // Force user to remove the card to re-arm
                    isArmedRef.current = false;
                    return; // SILENT ABORT: Do not send to AWS
                }
            }

            setDebugPreview(croppedBase64Card);
            setShowFlash(true);
            setTimeout(() => setShowFlash(false), 150);

            setPollState('processing');
            setStatusText('Processing…');

            console.log('🚀 Sending to AWS...', {
                payloadLength: croppedBase64Card.length,
                side: activeSide,
            });
            const result = await analyzeId(
                croppedBase64Card,
                activeSide,
                sessionHintRef.current,
            );
            console.log('✅ AWS Response Received:', result);

            if (result.status !== 'success') {
                // rdb also passed a legacy `result.reason`. analyze-id does not
                // return one — the Worker maps its internal reason to `code` via
                // mapReasonToCode before responding — so the field is dropped
                // rather than carried across as a permanently-undefined argument.
                const hint = codeToHint(result.code, undefined, result.message);
                setCaptureHint(hint);
                setPollState('aligning');
                setStatusText(hint ?? 'Could not read ID — try again');
                return;
            }

            await applyAnalyzeIdSuccess(result, activeSide, croppedBase64Card);
        } catch (error) {
            console.error('❌ AWS Submission Failed:', error);
            alert(
                'AWS Error: ' + (error instanceof Error ? error.message : 'Unknown error occurred'),
            );
            setPollState('aligning');
            setStatusText('Align ID within frame...');
        } finally {
            setIsVerifying(false);
        }
    }, [
        activeSide,
        applyAnalyzeIdSuccess,
        docCorners,
        isActive,
        isReady,
        isVerifying,
        startCamera,
        captureDocument,
        captureFrame,
    ]);

    // Corner bracket colour encodes the real-time local pre-check state:
    //  gold (#FFD700)   → idle, camera not started yet
    //  red  (#EF4444)   → any check failing:
    //                      too_dark | too_bright | glare | too_blurry |
    //                      moving   | card_not_detected
    //  amber (#F59E0B)  → all checks pass, building 1-second stability window
    //                      OR capturing (frame being cropped, pre-AWS)
    //  blue  (#388CFF)  → AWS Textract call in progress
    //  green (#22C55E)  → ready, capture succeeded, or done

    // Derived booleans — declared here so cornerColor and effects can use them.
    const isCardDetected = !!docCorners;
    const cardFillRatio =
        docCorners && scannerOverlay
            ? getQuadArea(docCorners) / (scannerOverlay.width * scannerOverlay.height)
            : 0;
    const isCardCloseEnough = cardFillRatio >= kycConfig.id.cardGeometry.minFillRatio;

    const cornerColor =
        pollState === 'success' || pollState === 'done'
            ? '#22C55E'
            : pollState === 'processing'
              ? '#388CFF'
              : pollState === 'capturing'
                ? '#F59E0B'
                : pollState === 'aligning' && (captureHint || showFlipHint)
                  ? '#EF4444' // server rejection or flip hint
                  : pollState === 'aligning' && checkResult && !checkResult.pass
                    ? '#EF4444' // local frame check failure
                    : pollState === 'aligning' && readyToCapture && isCardCloseEnough
                      ? '#22C55E' // ready AND card close enough
                      : pollState === 'aligning' && isCardDetected && !isCardCloseEnough
                        ? '#F59E0B' // detected but too far — prompt to move closer
                        : pollState === 'aligning' && checkResult?.pass
                          ? '#F59E0B'
                          : '#FFD700';

    const cornerBracketSize = 18;
    const cornerInset = 20;
    const topLeftStyle = docCorners
        ? {
              top: `${Math.max(0, docCorners.topLeft.y - cornerInset)}px`,
              left: `${Math.max(0, docCorners.topLeft.x - cornerInset)}px`,
          }
        : {};
    const topRightStyle = docCorners
        ? {
              top: `${Math.max(0, docCorners.topRight.y - cornerInset)}px`,
              left: `${Math.max(0, docCorners.topRight.x - cornerInset - cornerBracketSize)}px`,
              right: 'auto',
          }
        : {};
    const bottomLeftStyle = docCorners
        ? {
              top: `${Math.max(0, docCorners.bottomLeft.y - cornerInset - cornerBracketSize)}px`,
              left: `${Math.max(0, docCorners.bottomLeft.x - cornerInset)}px`,
              bottom: 'auto',
          }
        : {};
    const bottomRightStyle = docCorners
        ? {
              top: `${Math.max(0, docCorners.bottomRight.y - cornerInset - cornerBracketSize)}px`,
              left: `${Math.max(0, docCorners.bottomRight.x - cornerInset - cornerBracketSize)}px`,
              right: 'auto',
              bottom: 'auto',
          }
        : {};

    const verifyingBounds = docCorners
        ? {
              left: Math.min(
                  docCorners.topLeft.x,
                  docCorners.topRight.x,
                  docCorners.bottomLeft.x,
                  docCorners.bottomRight.x,
              ),
              top: Math.min(
                  docCorners.topLeft.y,
                  docCorners.topRight.y,
                  docCorners.bottomLeft.y,
                  docCorners.bottomRight.y,
              ),
              right: Math.max(
                  docCorners.topLeft.x,
                  docCorners.topRight.x,
                  docCorners.bottomLeft.x,
                  docCorners.bottomRight.x,
              ),
              bottom: Math.max(
                  docCorners.topLeft.y,
                  docCorners.topRight.y,
                  docCorners.bottomLeft.y,
                  docCorners.bottomRight.y,
              ),
          }
        : null;

    // 1. Derived booleans are declared above (before cornerColor) so they are available
    //    throughout the render. The aliases below preserve existing reference names.

    // Lift flip lockout UI only when the scanner actually detects a card on the back side
    useEffect(() => {
        if (activeSide === 'back' && isCardDetected && flipLockout) {
            setFlipLockout(false);
        }
    }, [activeSide, isCardDetected, flipLockout]);

    // Proximity hint — overrides debounce status when card is detected but too far
    useEffect(() => {
        if (pollState !== 'aligning' || flipLockoutRef.current) return;
        if (isCardDetected && !isCardCloseEnough) {
            if (statusDebounceRef.current) {
                clearTimeout(statusDebounceRef.current);
                statusDebounceRef.current = null;
            }
            setStatusText('Move closer...');
        }
    }, [isCardDetected, isCardCloseEnough, pollState]);

    // Stable ref to always hold the latest handleCaptureClick without causing effect re-runs
    const captureActionRef = useRef(handleCaptureClick);
    useEffect(() => {
        captureActionRef.current = handleCaptureClick;
    }, [handleCaptureClick]);

    useEffect(() => {
        if (!isCardDetected) {
            isArmedRef.current = true;
        }
    }, [isCardDetected]);

    // 3. Smart Auto-Capture Effect
    useEffect(() => {
        // Guard: Only trigger if the camera is active, we are in the aligning phase, and not already verifying
        if (
            !isActive ||
            isVerifying ||
            pollState !== 'aligning' ||
            !isArmedRef.current ||
            flipLockoutRef.current ||
            !isCardCloseEnough
        ) {
            return;
        }

        if (isCardDetected && isStable) {
            setStatusText('Hold steady...');

            const autoCaptureTimer = setTimeout(() => {
                captureActionRef.current();
            }, 1000);

            return () => clearTimeout(autoCaptureTimer);
        } else if (isCardDetected && !isStable) {
            setStatusText('Move closer to the document');
        } else if (isCardDetected && !isStable) {
            // Optional: Tell the user to stop moving
            setStatusText('Hold still, focusing...');
        }
        // CRITICAL: handleCaptureClick is NOT in this array — the ref handles it
    }, [isCardDetected, isCardCloseEnough, isActive, isVerifying, pollState, isStable]);

    return (
        <div className="flex flex-col items-center justify-start h-full bg-white">
            {showFlash && (
                <div className="absolute inset-0 z-100 bg-white opacity-80 transition-opacity duration-150 pointer-events-none" />
            )}
            {/* {debugPreview && (
                <img
                    src={debugPreview}
                    alt="Crop Preview"
                    className="absolute bottom-4 right-4 w-32 h-20 object-contain border-2 border-red-500 z-90 bg-black"
                    onClick={() => {
                        const win = window.open();
                        if (win)
                            win.document.write(
                                `<img src="${debugPreview}" style="max-width: 100%;"/>`,
                            );
                    }}
                />
            )} */}
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => {
                    stopCamera();
                    onExit();
                }}
            />

            {/* Close button */}
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
            {/* Header */}
            <h1 className="text-xd-30 font-bold text-center text-[#1D1D1D] mb-xd-5">
                Identity Verification !
            </h1>
            <div className="flex items-center justify-center gap-2 mb-xd-11">
                <Image
                    src={liveDetectIdSvg}
                    alt="live detect ID"
                    className="object-contain w-xd-20 h-xd-20"
                />
                <span className="text-xd-16 font-medium text-[#1D1D1D]">
                    Live Detection Your ID
                </span>
            </div>

            {/* Camera viewfinder */}
            <div
                ref={viewfinderRef}
                className="relative w-xd-350 h-xd-400 mx-auto  rounded-xd-30 overflow-hidden bg-[#000000] mb-xd-10"
            >
                <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    playsInline
                    muted
                    autoPlay
                    style={{ transform: shouldMirror ? 'scaleX(-1)' : 'none' }}
                />
                <canvas ref={canvasRef} className="hidden" />
                {scannerOverlay && (
                    <svg
                        className="absolute inset-0 pointer-events-none"
                        viewBox={`0 0 ${scannerOverlay.width} ${scannerOverlay.height}`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                        // The scanner analyses the RAW camera frame, but the video is
                        // CSS-mirrored for the user (always on desktop — useCamera forces
                        // shouldMirror there). Without the same flip the overlay lands on
                        // the opposite side of the frame: hold the card left of centre and
                        // the box appears on the right, over the user's face, which reads
                        // as "it's detecting my face" when detection is actually fine.
                        style={{ transform: shouldMirror ? 'scaleX(-1)' : undefined }}
                    >
                        <path
                            d={scannerOverlay.pathD}
                            fill="rgba(0, 0, 0, 0.85)"
                            fillRule="evenodd"
                        />
                    </svg>
                )}

                {/* Corner brackets — animate from frame edges onto the detected card */}
                {!flipLockout && (
                    // Same mirror as the overlay above — these brackets are positioned
                    // from docCorners, which are raw-frame coordinates.
                    <div
                        className="absolute inset-5 pointer-events-none"
                        style={{ transform: shouldMirror ? 'scaleX(-1)' : undefined }}
                    >
                        {/* Top-left */}
                        <div
                            className="absolute top-0 left-0 w-xd-18 h-xd-18"
                            style={{
                                borderTop: `3px solid ${cornerColor}`,
                                borderLeft: `3px solid ${cornerColor}`,
                                borderRadius: '10px 0 0 0',
                                transition:
                                    'top 0.25s ease, left 0.25s ease, border-color 0.5s ease',
                                ...topLeftStyle,
                            }}
                        />
                        {/* Top-right */}
                        <div
                            className="absolute top-0 right-0 w-xd-18 h-xd-18"
                            style={{
                                borderTop: `3px solid ${cornerColor}`,
                                borderRight: `3px solid ${cornerColor}`,
                                borderRadius: '0 10px 0 0',
                                transition:
                                    'top 0.25s ease, right 0.25s ease, border-color 0.5s ease',
                                ...topRightStyle,
                            }}
                        />
                        {/* Bottom-left */}
                        <div
                            className="absolute bottom-0 left-0 w-xd-18 h-xd-18"
                            style={{
                                borderBottom: `3px solid ${cornerColor}`,
                                borderLeft: `3px solid ${cornerColor}`,
                                borderRadius: '0 0 0 10px',
                                transition:
                                    'bottom 0.25s ease, left 0.25s ease, border-color 0.5s ease',
                                ...bottomLeftStyle,
                            }}
                        />
                        {/* Bottom-right */}
                        <div
                            className="absolute bottom-0 right-0 w-xd-18 h-xd-18"
                            style={{
                                borderBottom: `3px solid ${cornerColor}`,
                                borderRight: `3px solid ${cornerColor}`,
                                borderRadius: '0 0 10px 0',
                                transition:
                                    'bottom 0.25s ease, right 0.25s ease, border-color 0.5s ease',
                                ...bottomRightStyle,
                            }}
                        />
                    </div>
                )}
                {(pollState === 'processing' || isVerifying) && debugPreview && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
                        {/* Relative wrapper is CRITICAL for the 100% height animation to work */}
                        <div className="relative w-11/12 max-w-md overflow-hidden rounded-xl border border-white/20 shadow-2xl">
                            {/* The frozen captured card */}
                            <img
                                src={debugPreview}
                                alt="Processing ID"
                                className="w-full h-auto object-contain"
                            />

                            {/* Framer Motion laser scanner */}
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
                        </div>
                    </div>
                )}

                {/* Stability progress bar — fills as the frame holds steady */}
                {pollState === 'aligning' && checkResult?.pass && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.75 bg-black/20 overflow-hidden">
                        <div
                            className="h-full transition-all duration-150"
                            style={{
                                width: `${Math.min(100, (stableDuration / 1000) * 100)}%`,
                                backgroundColor: readyToCapture ? '#22C55E' : '#F59E0B',
                            }}
                        />
                    </div>
                )}

                {/* Status overlay inside the frame */}
                {pollState !== 'idle' && pollState !== 'done' && (
                    <div className="absolute bottom-4 left-4 right-4 text-center">
                        <p className="text-xs text-white bg-black/50 rounded-lg px-3 py-2">
                            {statusText}
                        </p>
                    </div>
                )}

                {/* Rejection hint — below the viewfinder, old style */}
                {(captureHint || showFlipHint) && pollState === 'aligning' && (
                    <div className="absolute -bottom-xd-1 left-0 right-0 px-xd-10">
                        <p className="text-xs text-[#E53E3E] bg-red-50 border border-red-200 rounded-xd-12 px-3 py-2 text-center leading-snug">
                            {captureHint ?? 'Show the side of your ID with your photo'}
                        </p>
                    </div>
                )}
            </div>

            {/* Tabs */}
            {isPassport ? (
                <div className="flex items-center justify-center mb-3">
                    <div className="text-center">
                        <div className="inline-flex items-center justify-center gap-1 pb-2">
                            <Image
                                src={idFrontSvg}
                                alt="passport"
                                width={16}
                                height={16}
                                className="object-contain"
                            />
                            <span className="text-xs font-medium text-[#388CFF]">Passport</span>
                        </div>
                        <div className="mx-auto w-xd-306">
                            <FaceProgressBar pct={pollState === 'done' ? 100 : 0} tone="idle" />
                        </div>
                    </div>
                </div>
            ) : (
                <div className="flex items-center justify-center gap-xd-4 mb-3">
                    <div className=" w-xd-153 text-center">
                        <div className={`inline-flex items-center justify-center gap-1 pb-2`}>
                            <Image
                                src={idFrontSvg}
                                alt="front"
                                width={16}
                                height={16}
                                className="object-contain"
                                style={{
                                    filter:
                                        activeSide === 'front'
                                            ? 'none'
                                            : 'grayscale(1) opacity(0.4)',
                                }}
                            />
                            <span
                                className={`text-xs font-medium ${activeSide === 'front' ? 'text-[#388CFF]' : 'text-gray-400'}`}
                            >
                                Front Side
                            </span>
                        </div>
                        <div className="mx-auto w-xd-153">
                            <FaceProgressBar
                                pct={activeSide === 'front' ? 0 : 100}
                                tone={activeSide === 'front' ? 'locked' : 'idle'}
                            />
                        </div>
                    </div>
                    <div className=" w-xd-153 text-center">
                        <div className={`inline-flex items-center justify-center gap-1 pb-2`}>
                            <Image
                                src={idBackSvg}
                                alt="back"
                                width={16}
                                height={16}
                                className="object-contain"
                                style={{
                                    filter:
                                        activeSide === 'back'
                                            ? 'none'
                                            : 'grayscale(1) opacity(0.4)',
                                }}
                            />
                            <span
                                className={`text-xs font-medium ${activeSide === 'back' ? 'text-[#388CFF]' : 'text-gray-400'}`}
                            >
                                Back Side
                            </span>
                        </div>
                        <div className="mx-auto w-xd-153">
                            <FaceProgressBar
                                pct={pollState === 'done' ? 100 : 0}
                                tone={activeSide === 'back' ? 'idle' : 'locked'}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Captured thumbnails */}
            {(frontImageData || backImageData) &&
                (isPassport ? (
                    <div className="flex justify-center mb-3">
                        <div className="w-xd-306 h-xd-180 rounded-xd-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {frontImageData ? (
                                <img
                                    src={frontImageData}
                                    alt="Passport"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full" />
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex gap-2 mb-3">
                        <div className="flex-1 w-xd-153 h-xd-96 rounded-xd-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {frontImageData ? (
                                <img
                                    src={frontImageData}
                                    alt="Front"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full" />
                            )}
                        </div>
                        <div className="flex-1 w-xd-153 h-xd-96 rounded-xd-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {backImageData ? (
                                <img
                                    src={backImageData}
                                    alt="Back"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full" />
                            )}
                        </div>
                    </div>
                ))}

            <FlexibleSpace size={160} share={0.6} />
            {/* Camera error */}
            {cameraError && (
                <div className="text-center mb-2">
                    <p className="text-xs text-red-500 mb-1">{cameraError}</p>
                    <button
                        onClick={startCamera}
                        className="text-xs text-[#388CFF] hover:underline"
                    >
                        Try Again
                    </button>
                </div>
            )}
            <div className="mt-auto flex items-center flex-col justify-end">
                {/* Privacy badge */}
                <div className="flex items-center flex-col justify-center gap-2 mb-xd-12">
                    <Image
                        src={shieldSvg}
                        alt="shield"
                        className="w-xd-15 h-xd-15 object-contain"
                    />
                    <span className="text-xd-12 text-[#388CFF]">
                        Your Privacy Is Completely Safe
                    </span>
                </div>

                {/* Start button — only shown on idle */}
                {pollState === 'idle' && (
                    <button
                        onClick={handleCaptureClick}
                        className="w-xd-390 h-xd-60 py-4 rounded-xd-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] text-xd-16 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Start Live Detection Your ID
                    </button>
                )}
            </div>

            <FlexibleSpace size={35} share={0.1} />
        </div>
    );
}
