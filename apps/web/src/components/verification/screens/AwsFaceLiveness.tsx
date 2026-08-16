'use client';

/**
 * AwsFaceLiveness — AWS Rekognition liveness with our own custom UI.
 *
 * Flow:
 *   1. User taps "Begin" → camera starts → 3 challenges run sequentially
 *      (look_straight, turn_right, turn_left) via kycService.detectFace()
 *   2. Final capture → AWS verifies → flash + sparkle animation → goTo face-match
 *
 * Attempts: each Begin/Restart click counts as one attempt. Failures inside
 * a session return the user to a "Restart" UI (no support page) until they
 * have used all MAX_ATTEMPTS Begin clicks.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import { useEnrollFlow } from '@/context/EnrollFlowContext';
import { useCamera } from '@/hooks/useCamera';
import { detectFace } from '@/lib/kycApi';
import type { LivenessChallenge } from '@ramaaz/kyc-shared/types';
import faceDetectSvg from '@/assets/icons/face-detect.svg';
import shieldSvg from '@/assets/icons/shield.svg';
import ExitConfirmDialog from '../ExitConfirmDialog';
import FlexibleSpace from '@/components/layout/FlexibleSpace';
import { faceConfig } from '@ramaaz/kyc-shared/config';
// FaceProgressBar was defined here and imported by IDCaptureScreen — a
// cross-screen import for a shared widget. It now lives on its own, and `Tone`
// comes with it so the palette has a single definition.
import { FaceProgressBar, type Tone } from '../FaceProgressBar';

const CHALLENGE_STEPS: { key: LivenessChallenge; label: string }[] = [
    { key: 'look_straight', label: 'Face The Camera' },
    { key: 'turn_right', label: 'Turn Head Right' },
    { key: 'turn_left', label: 'Turn Head Left' },
];

const HOLD_LOCKED_MS = faceConfig.timing.holdLockedMs;
const STRICT_RETRY_LIMIT = faceConfig.attempts.finalCaptureRetries;
const MAX_ATTEMPTS = faceConfig.attempts.maxPerChallenge;

type Phase = 'init' | 'ready' | 'detecting' | 'failed' | 'done';

const NET_COLOR: Record<Tone, string> = {
    idle: '#9CA3AF',
    aligned: '#F59E0B',
    locked: '#22C55E',
    red: '#EF4444',
};

function reasonToHint(reason: string, step: LivenessChallenge): string {
    switch (reason) {
        case 'no_face_detected':
            return 'Position face within mask';
        case 'eyes_closed':
            return 'Keep your eyes open';
        case 'sunglasses_detected':
            return 'Please remove your sunglasses';
        case 'screen_detected':
            return 'Use your real face — a screen or phone was detected';
        case 'too_dark':
            return 'Move to a brighter area';
        case 'too_blurry':
            return 'Hold steady — frame too blurry';
        case 'not_facing_camera':
            return 'Face the camera straight on';
        case 'turn_more_right':
        case 'turn_more_left':
            return 'Keep going...';
        default:
            return step === 'look_straight'
                ? 'Please Keep Your Face Centered On The Screen And Facing Forward'
                : step === 'turn_right'
                  ? 'Slowly Turn Your Head To The Right'
                  : 'Slowly Turn Your Head To The Left';
    }
}

// ─── HUD AI Scanner — replaces the wireframe NetMask ─────────────────────────
// A futuristic radar/HUD ring that spins around the face: animated arcs,
// reticle ticks, a sweeping radar beam, and a triangulated face-mesh inside.
// Designed to feel "AI-powered" — interactive, alive, never static.

// Triangulated mesh nodes (face-landmark style) inside the inner oval.
const MESH_NODES: [number, number][] = [
    [200, 95],
    [165, 110],
    [235, 110], // forehead
    [140, 145],
    [200, 150],
    [260, 145], // brow line
    [125, 200],
    [175, 200],
    [225, 200],
    [275, 200], // eye line
    [155, 245],
    [200, 250],
    [245, 245], // mid-cheek
    [170, 295],
    [200, 300],
    [230, 295], // nose / upper lip
    [180, 345],
    [220, 345], // lip corners
    [200, 380], // chin
];
// Index pairs forming the face-mesh edges.
const MESH_EDGES: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 3],
    [2, 5],
    [3, 4],
    [4, 5],
    [3, 5],
    [3, 6],
    [5, 9],
    [6, 7],
    [7, 8],
    [8, 9],
    [4, 7],
    [4, 8],
    [6, 10],
    [9, 12],
    [10, 11],
    [11, 12],
    [10, 13],
    [12, 15],
    [13, 14],
    [14, 15],
    [13, 16],
    [15, 17],
    [16, 17],
    [16, 18],
    [17, 18],
];
// Reticle ticks around the outer ring (degrees).
const TICKS = Array.from({ length: 24 }, (_, i) => i * 15);

function HudScanner({
    tone,
    rotateY,
    flashing,
    challenge,
}: {
    tone: Tone;
    rotateY: number;
    flashing: boolean;
    challenge: LivenessChallenge | null;
}) {
    const accent = flashing ? 'url(#hud-ai-gradient)' : NET_COLOR[tone];
    const meshOpacity = tone === 'idle' ? 0.55 : 0.85;

    // For 2 s when a turn challenge begins, pulse the bracket arcs so the
    // direction is clearly visible even when the user's face is behind the HUD.
    // Only color + strokeWidth change — no shape or structure is altered.
    const [emphasize, setEmphasize] = useState(false);
    const emphTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevChallengeRef = useRef<LivenessChallenge | null>(null);

    useEffect(() => {
        if (
            (challenge === 'turn_right' || challenge === 'turn_left') &&
            challenge !== prevChallengeRef.current
        ) {
            prevChallengeRef.current = challenge;
            setEmphasize(true);
            if (emphTimerRef.current) clearTimeout(emphTimerRef.current);
            emphTimerRef.current = setTimeout(() => setEmphasize(false), 2000);
        } else if (challenge !== prevChallengeRef.current) {
            prevChallengeRef.current = challenge;
            setEmphasize(false);
            if (emphTimerRef.current) {
                clearTimeout(emphTimerRef.current);
                emphTimerRef.current = null;
            }
        }
        return () => {
            if (emphTimerRef.current) clearTimeout(emphTimerRef.current);
        };
    }, [challenge]);

    // During the 2-second window: brighter cyan accent so the arcs punch through
    // the face even on dark backgrounds. Outside that window: normal accent.
    const arcAccent = emphasize ? '#38D1FF' : accent;

    return (
        <motion.div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ perspective: 800 }}
        >
            <motion.div
                animate={{ rotateY }}
                transition={{ type: 'spring', stiffness: 80, damping: 18 }}
                style={{ transformStyle: 'preserve-3d' }}
            >
                <motion.svg
                    width="220"
                    height="260"
                    viewBox="0 0 400 480"
                    fill="none"
                    animate={
                        flashing
                            ? { filter: 'drop-shadow(0 0 128px rgba(122,168,255,0.95))' }
                            : tone === 'aligned'
                              ? {
                                    filter: [
                                        'drop-shadow(0 0 0px rgba(245,158,11,0))',
                                        'drop-shadow(0 0 10px rgba(245,158,11,0.55))',
                                        'drop-shadow(0 0 0px rgba(245,158,11,0))',
                                    ],
                                }
                              : tone === 'locked'
                                ? { filter: 'drop-shadow(0 0 12px rgba(34,197,94,0.75))' }
                                : { filter: 'drop-shadow(0 0 6px rgba(122,168,255,0.4))' }
                    }
                    transition={
                        flashing
                            ? { duration: 0.4 }
                            : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
                    }
                >
                    <defs>
                        <linearGradient id="hud-ai-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <motion.stop
                                offset="0%"
                                animate={{
                                    stopColor: [
                                        '#7AA8FF',
                                        '#E07AC6',
                                        '#22C55E',
                                        '#F4C26A',
                                        '#7AA8FF',
                                    ],
                                }}
                                transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
                            />
                            <motion.stop
                                offset="50%"
                                animate={{
                                    stopColor: [
                                        '#E07AC6',
                                        '#22C55E',
                                        '#F4C26A',
                                        '#7AA8FF',
                                        '#E07AC6',
                                    ],
                                }}
                                transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
                            />
                            <motion.stop
                                offset="100%"
                                animate={{
                                    stopColor: [
                                        '#22C55E',
                                        '#F4C26A',
                                        '#7AA8FF',
                                        '#E07AC6',
                                        '#22C55E',
                                    ],
                                }}
                                transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
                            />
                        </linearGradient>
                        <radialGradient id="hud-radar-fade" cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stopColor="#7AA8FF" stopOpacity="0.35" />
                            <stop offset="60%" stopColor="#7AA8FF" stopOpacity="0.06" />
                            <stop offset="100%" stopColor="#7AA8FF" stopOpacity="0" />
                        </radialGradient>
                    </defs>

                    {/* Outer rotating reticle ring */}
                    <motion.g
                        style={{ transformOrigin: '200px 240px' }}
                        animate={{ rotate: 360 }}
                        transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
                    >
                        <motion.ellipse
                            cx="200"
                            cy="240"
                            rx="170"
                            ry="200"
                            stroke={arcAccent}
                            strokeDasharray="2 6"
                            animate={{
                                strokeOpacity: emphasize ? 0.75 : 0.35,
                                strokeWidth: emphasize ? 2 : 1,
                            }}
                            transition={{ duration: 0.35 }}
                        />
                        {TICKS.map((deg) => {
                            const rad = (deg * Math.PI) / 180;
                            const x1 = 200 + Math.cos(rad) * 168;
                            const y1 = 240 + Math.sin(rad) * 198;
                            const x2 = 200 + Math.cos(rad) * (deg % 45 === 0 ? 152 : 160);
                            const y2 = 240 + Math.sin(rad) * (deg % 45 === 0 ? 180 : 190);
                            return (
                                <motion.line
                                    key={deg}
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                    stroke={arcAccent}
                                    animate={{
                                        strokeOpacity: emphasize
                                            ? deg % 45 === 0
                                                ? 1.0
                                                : 0.85
                                            : deg % 45 === 0
                                              ? 0.85
                                              : 0.5,
                                        strokeWidth: emphasize
                                            ? deg % 45 === 0
                                                ? 2.8
                                                : 1.8
                                            : deg % 45 === 0
                                              ? 1.6
                                              : 1,
                                    }}
                                    transition={{ duration: 0.35 }}
                                />
                            );
                        })}
                    </motion.g>

                    {/* Counter-rotating bracket arcs.
                         During the 2-second turn-challenge emphasis window the
                         primary arcs grow thicker and shift to a bright cyan so
                         the direction is unmistakable behind the user's face.
                         Only strokeWidth + strokeOpacity animate — no shape change. */}
                    <motion.g
                        style={{ transformOrigin: '200px 240px' }}
                        animate={{ rotate: -360 }}
                        transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
                    >
                        <motion.path
                            d="M60 240 A140 170 0 0 1 110 130"
                            stroke={arcAccent}
                            animate={{
                                strokeWidth: emphasize ? 5.0 : 2.2,
                                strokeOpacity: emphasize ? 1.0 : 0.85,
                            }}
                            transition={{ duration: 0.35 }}
                        />
                        <motion.path
                            d="M340 240 A140 170 0 0 1 290 350"
                            stroke={arcAccent}
                            animate={{
                                strokeWidth: emphasize ? 5.0 : 2.2,
                                strokeOpacity: emphasize ? 1.0 : 0.85,
                            }}
                            transition={{ duration: 0.35 }}
                        />
                        <motion.path
                            d="M75 290 A140 170 0 0 0 130 380"
                            stroke={arcAccent}
                            animate={{
                                strokeWidth: emphasize ? 3.2 : 1.4,
                                strokeOpacity: emphasize ? 0.9 : 0.55,
                            }}
                            transition={{ duration: 0.35 }}
                        />
                        <motion.path
                            d="M325 190 A140 170 0 0 0 270 100"
                            stroke={arcAccent}
                            animate={{
                                strokeWidth: emphasize ? 3.2 : 1.4,
                                strokeOpacity: emphasize ? 0.9 : 0.55,
                            }}
                            transition={{ duration: 0.35 }}
                        />
                    </motion.g>

                    {/* Sweeping radar beam — slow rotation, fading triangle */}
                    <motion.g
                        style={{ transformOrigin: '200px 240px' }}
                        animate={{ rotate: 360 }}
                        transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
                    >
                        <path
                            d="M200 240 L360 200 A165 165 0 0 1 360 280 Z"
                            fill="url(#hud-radar-fade)"
                        />
                    </motion.g>

                    {/* Static face-mesh oval guide */}
                    <motion.ellipse
                        cx="200"
                        cy="240"
                        rx="120"
                        ry="155"
                        stroke={arcAccent}
                        animate={{
                            strokeOpacity: emphasize ? 0.95 : 0.55,
                            strokeWidth: emphasize ? 2.5 : 1.2,
                        }}
                        transition={{ duration: 0.35 }}
                    />

                    {/* Triangulated face-mesh — pulses; brighter during emphasis */}
                    <motion.g
                        animate={{
                            opacity: emphasize
                                ? [0.9, 1.0, 0.9]
                                : [meshOpacity * 0.6, meshOpacity, meshOpacity * 0.6],
                        }}
                        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                    >
                        {MESH_EDGES.map(([a, b], i) => {
                            const [x1, y1] = MESH_NODES[a];
                            const [x2, y2] = MESH_NODES[b];
                            return (
                                <motion.line
                                    key={i}
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                    stroke={arcAccent}
                                    animate={{
                                        strokeOpacity: emphasize ? 0.9 : 0.5,
                                        strokeWidth: emphasize ? 1.6 : 0.8,
                                    }}
                                    transition={{ duration: 0.35 }}
                                />
                            );
                        })}
                        {MESH_NODES.map(([cx, cy], i) => (
                            <motion.circle
                                key={i}
                                cx={cx}
                                cy={cy}
                                fill={arcAccent}
                                animate={{ r: emphasize ? 3.2 : 2 }}
                                transition={{ duration: 0.35 }}
                            />
                        ))}
                    </motion.g>

                    {/* Centre crosshair */}
                    <motion.line
                        x1="190"
                        y1="240"
                        x2="210"
                        y2="240"
                        stroke={arcAccent}
                        animate={{
                            strokeWidth: emphasize ? 2.2 : 1.2,
                            strokeOpacity: emphasize ? 1.0 : 0.85,
                        }}
                        transition={{ duration: 0.35 }}
                    />
                    <motion.line
                        x1="200"
                        y1="230"
                        x2="200"
                        y2="250"
                        stroke={arcAccent}
                        animate={{
                            strokeWidth: emphasize ? 2.2 : 1.2,
                            strokeOpacity: emphasize ? 1.0 : 0.85,
                        }}
                        transition={{ duration: 0.35 }}
                    />
                </motion.svg>
            </motion.div>
        </motion.div>
    );
}

// ─── Sparkle field — small "brush" of AI stars over the face ─────────────────
// Default field: small twinkles around the face — never blocks the photo.
const SPARKLE_POSITIONS: { x: number; y: number; size: number; delay: number }[] = [
    { x: 32, y: 30, size: 8, delay: 0 },
    { x: 68, y: 28, size: 9, delay: 0.15 },
    { x: 50, y: 22, size: 7, delay: 0.3 },
    { x: 28, y: 50, size: 10, delay: 0.05 },
    { x: 72, y: 52, size: 10, delay: 0.2 },
    { x: 38, y: 68, size: 8, delay: 0.25 },
    { x: 62, y: 70, size: 8, delay: 0.1 },
    { x: 22, y: 38, size: 6, delay: 0.5 },
    { x: 78, y: 40, size: 6, delay: 0.45 },
    { x: 44, y: 38, size: 5, delay: 0.6 },
    { x: 56, y: 60, size: 5, delay: 0.55 },
    { x: 36, y: 55, size: 6, delay: 0.18 },
    { x: 64, y: 36, size: 7, delay: 0.32 },
];

// ─── Person-silhouette background mask ───────────────────────────────────────
// Replaces the photo's background with a solid color while keeping the head,
// neck and shoulders/t-shirt visible. Uses canvas blur on a head-circle +
// shoulder-curve silhouette to feather the edges (no extra ML dependency).
async function maskFaceOnBackground(dataUrl: string, bgColor = '#E9EEEE'): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const W = img.naturalWidth;
            const H = img.naturalHeight;
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('canvas 2d context unavailable'));
                return;
            }
            // Solid backdrop
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, W, H);

            // Photo onto an offscreen canvas so we can mask it via destination-in.
            const off = document.createElement('canvas');
            off.width = W;
            off.height = H;
            const offCtx = off.getContext('2d');
            if (!offCtx) {
                reject(new Error('offscreen canvas 2d context unavailable'));
                return;
            }
            offCtx.drawImage(img, 0, 0);

            // Silhouette mask: head circle + neck band + shoulder/chest curve.
            const mask = document.createElement('canvas');
            mask.width = W;
            mask.height = H;
            const mctx = mask.getContext('2d');
            if (!mctx) {
                reject(new Error('mask canvas 2d context unavailable'));
                return;
            }

            const cx = W / 2;
            const headCy = H * 0.34;
            const headR = Math.min(W, H) * 0.3;

            // Heavy blur feathers all silhouette edges into the bg color.
            mctx.filter = `blur(${Math.round(Math.min(W, H) * 0.04)}px)`;
            mctx.fillStyle = '#000';

            // Head + hair ellipse (slightly taller than wide for hair on top).
            mctx.beginPath();
            mctx.ellipse(cx, headCy, headR * 1.05, headR * 1.18, 0, 0, Math.PI * 2);
            mctx.fill();

            // Neck connector
            mctx.beginPath();
            mctx.moveTo(cx - headR * 0.45, headCy + headR * 0.85);
            mctx.lineTo(cx + headR * 0.45, headCy + headR * 0.85);
            mctx.lineTo(cx + headR * 0.7, H * 0.55);
            mctx.lineTo(cx - headR * 0.7, H * 0.55);
            mctx.closePath();
            mctx.fill();

            // Shoulders / chest / t-shirt — extends to bottom edges.
            mctx.beginPath();
            mctx.moveTo(0, H);
            mctx.lineTo(0, H * 0.92);
            mctx.quadraticCurveTo(W * 0.18, H * 0.62, W * 0.34, H * 0.55);
            mctx.quadraticCurveTo(cx, H * 0.52, W * 0.66, H * 0.55);
            mctx.quadraticCurveTo(W * 0.82, H * 0.62, W, H * 0.92);
            mctx.lineTo(W, H);
            mctx.closePath();
            mctx.fill();

            mctx.filter = 'none';

            offCtx.globalCompositeOperation = 'destination-in';
            offCtx.drawImage(mask, 0, 0);

            ctx.drawImage(off, 0, 0);

            resolve(canvas.toDataURL('image/jpeg', 0.92));
        };
        img.onerror = () => reject(new Error('face image failed to load'));
        img.src = dataUrl;
    });
}

function Sparkle({ size, color }: { size: number; color: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
            <path d="M12 0 L13.5 9 L24 12 L13.5 15 L12 24 L10.5 15 L0 12 L10.5 9 Z" />
        </svg>
    );
}

// Edge-only positions (avoid the face area in the middle) — for the post-flash
// "brush of stars" so the user's face stays clearly visible.
const SPARKLE_EDGE_POSITIONS: { x: number; y: number; size: number; delay: number }[] = [
    { x: 12, y: 18, size: 8, delay: 0 },
    { x: 88, y: 16, size: 9, delay: 0.2 },
    { x: 18, y: 78, size: 8, delay: 0.4 },
    { x: 82, y: 80, size: 9, delay: 0.1 },
    { x: 8, y: 45, size: 6, delay: 0.3 },
    { x: 92, y: 50, size: 6, delay: 0.5 },
    { x: 25, y: 8, size: 5, delay: 0.6 },
    { x: 75, y: 8, size: 5, delay: 0.15 },
    { x: 30, y: 92, size: 6, delay: 0.45 },
    { x: 70, y: 92, size: 6, delay: 0.25 },
    { x: 14, y: 60, size: 5, delay: 0.55 },
    { x: 86, y: 65, size: 5, delay: 0.35 },
];

function SparkleField({
    duration,
    color = '#FFD700',
    edgeOnly = false,
}: {
    duration: number;
    color?: string;
    edgeOnly?: boolean;
}) {
    const positions = edgeOnly ? SPARKLE_EDGE_POSITIONS : SPARKLE_POSITIONS;
    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {positions.map((s, i) => (
                <motion.div
                    key={i}
                    className="absolute"
                    style={{ left: `${s.x}%`, top: `${s.y}%`, transform: 'translate(-50%, -50%)' }}
                    initial={{ scale: 0, opacity: 0, rotate: 0 }}
                    animate={{
                        scale: [0, 1.2, 0.9, 1.3, 0],
                        opacity: [0, 1, 0.85, 1, 0],
                        rotate: [0, 90, 180, 270, 360],
                    }}
                    transition={{
                        duration,
                        delay: s.delay,
                        repeat: Infinity,
                        repeatDelay: 0.1,
                        ease: 'easeInOut',
                    }}
                >
                    <div style={{ filter: `drop-shadow(0 0 6px ${color})` }}>
                        <Sparkle size={s.size} color={color} />
                    </div>
                </motion.div>
            ))}
        </div>
    );
}

/**
 *  is supplied by the route: this runs on the hosted KYC origin, so
 * leaving means handing the user back to the consumer app via the validated
 * returnTo. rdb used a local router.push('/home').
 */
export default function AwsFaceLivenessScreen({ onExit }: { onExit: () => void }) {
    // No goTo(): the screen reports that its stage finished and the flow, driven
    // by the token's , decides what runs next.
    const { setLivenessResult, completeStep } = useEnrollFlow();
    const {
        videoRef,
        canvasRef,
        isActive,
        error: cameraError,
        shouldMirror,
        startCamera,
        stopCamera,
        captureFrame,
    } = useCamera({ facingMode: 'user' });

    const [phase, setPhase] = useState<Phase>('init');
    const [currentChallengeIdx, setCurrentChallengeIdx] = useState(-1);
    const [stageProgress, setStageProgress] = useState(0);
    const [instruction, setInstruction] = useState('Tap Begin to start the AI face liveness check');
    const [tone, setTone] = useState<Tone>('idle');
    const [flashing, setFlashing] = useState(false);
    const [postFlashSparkles, setPostFlashSparkles] = useState(false);
    const [firstDetectionBurst, setFirstDetectionBurst] = useState(false);
    const [processedFaceImage, setProcessedFaceImage] = useState<string | null>(null);
    const hasDetectedOnceRef = useRef(false);
    const [showExitDialog, setShowExitDialog] = useState(false);
    const lastLivenessRef = useRef<{
        faceImageData: string;
        metrics?: import('@ramaaz/kyc-shared/types').LivenessMetrics;
    } | null>(null);
    // In-session retries per challenge step. Resets every Begin click.
    const stepRetriesRef = useRef<Record<number, number>>({});
    const MAX_IN_SESSION_RETRIES = 6;

    // Component is ready as soon as it mounts — liveness is driven by DetectFaces.
    useEffect(() => {
        setPhase('ready');
    }, []);

    useEffect(() => {
        if (phase !== 'detecting') return;
        startCamera();
        return () => stopCamera();
    }, [phase, startCamera, stopCamera]);

    // Stops the current session (Begin run) and returns the user to the "ready"
    // state so they can tap Begin again. Does NOT increment attempt counts —
    // attempts are counted per Begin click in handleBegin.
    const endSession = useCallback(
        (msg: string) => {
            stopCamera();
            setStageProgress(0);
            setCurrentChallengeIdx(-1);
            setTone('red');
            setInstruction(msg);
            setPhase('failed');
        },
        [stopCamera],
    );

    const runFinalCapture = useCallback(async () => {
        setTone('idle');
        setInstruction('Hold Still — AI is verifying...');

        for (let attempt = 0; attempt < STRICT_RETRY_LIMIT; attempt++) {
            await new Promise((r) =>
                setTimeout(
                    r,
                    attempt === 0
                        ? faceConfig.timing.firstCaptureDelayMs
                        : faceConfig.timing.captureRetryDelayMs,
                ),
            );

            const frame = captureFrame();
            if (!frame) continue;

            try {
                const result = await detectFace(frame, 'look_straight', {
                    crop: true,
                });
                if (result.isLive) {
                    const rawFace = result.faceImageData || frame;
                    // Mask onto the #E9EEEE background — keeps the centred face,
                    // replaces the surrounding pixels.  Falls back to raw on error.
                    let maskedFace = rawFace;
                    // try {
                    //     maskedFace = await maskFaceOnBackground(rawFace, '#E9EEEE');
                    // } catch (err) {
                    //     console.warn('[AwsFaceLiveness] face mask failed, using raw crop', err);
                    // }

                    lastLivenessRef.current = {
                        faceImageData: maskedFace,
                        metrics: result.metrics ?? lastLivenessRef.current?.metrics,
                    };
                    setProcessedFaceImage(maskedFace);
                    setInstruction('Live Face Detection Done');
                    setTone('locked');
                    setFlashing(true);

                    setLivenessResult({
                        faceImageData: maskedFace,
                        isLive: true,
                        timestamp: Date.now(),
                        metrics: lastLivenessRef.current.metrics,
                    });
                    setPhase('done');
                    // Short translucent flash, then a small "brush" of stars
                    // around the still photo — face stays visible the whole time.
                    setTimeout(() => {
                        setFlashing(false);
                        setPostFlashSparkles(true);
                    }, 600);
                    setTimeout(() => {
                        setPostFlashSparkles(false);
                        stopCamera();
                        completeStep();
                    }, 3500);
                    return;
                }
                setTone('red');
                setInstruction(
                    phase === 'failed'
                        ? 'Try Again'
                        : reasonToHint(result.reason ?? '', 'look_straight'),
                );
            } catch {
                setInstruction('Hold Still — AI is verifying...');
            }
        }

        endSession('Face check failed — please try again');
    }, [captureFrame, setLivenessResult, stopCamera, completeStep, endSession]);

    const runChallengeStep = useCallback(
        async (idx: number) => {
            if (idx >= CHALLENGE_STEPS.length) {
                setCurrentChallengeIdx(-1);
                runFinalCapture();
                return;
            }

            const step = CHALLENGE_STEPS[idx];
            setCurrentChallengeIdx(idx);
            setTone('idle');
            setInstruction(reasonToHint('', step.key));

            await new Promise((r) => setTimeout(r, faceConfig.timing.stepDelayMs));

            const frame = captureFrame();
            if (!frame) {
                // Camera not ready yet — give it a moment and retry the same step.
                const tries = (stepRetriesRef.current[idx] ?? 0) + 1;
                stepRetriesRef.current[idx] = tries;
                if (tries > MAX_IN_SESSION_RETRIES) {
                    endSession('Camera frame unavailable — please try again');
                    return;
                }
                await new Promise((r) => setTimeout(r, 600));
                runChallengeStep(idx);
                return;
            }

            try {
                const result = await detectFace(frame, step.key, {
                    crop: false,
                });
                if (result.isLive) {
                    // First successful detection — fire the sparkle burst on the user's face.
                    if (!hasDetectedOnceRef.current) {
                        hasDetectedOnceRef.current = true;
                        setFirstDetectionBurst(true);
                        setTimeout(() => setFirstDetectionBurst(false), 1400);
                    }
                    if (step.key === 'look_straight' && result.metrics?.boundingBox) {
                        const bb = result.metrics.boundingBox;
                        const faceCenterX = bb.left + bb.width / 2;
                        if (
                            Math.abs(faceCenterX - 0.5) > faceConfig.centering.maxHorizontalOffset
                        ) {
                            setTone('red');
                            setInstruction('Center your face in the frame');
                            await new Promise((r) =>
                                setTimeout(r, faceConfig.timing.centeringRetryMs),
                            );
                            runChallengeStep(0);
                            return;
                        }
                    }

                    if (step.key === 'look_straight' || !lastLivenessRef.current) {
                        lastLivenessRef.current = {
                            faceImageData: result.faceImageData || frame,
                            metrics: result.metrics ?? lastLivenessRef.current?.metrics,
                        };
                    } else {
                        lastLivenessRef.current = {
                            faceImageData: lastLivenessRef.current.faceImageData,
                            metrics: result.metrics ?? lastLivenessRef.current.metrics,
                        };
                    }
                    setTone('aligned');
                    setInstruction('Hold Still...');
                    await new Promise((r) => setTimeout(r, HOLD_LOCKED_MS));
                    setTone('locked');
                    setInstruction('Perfect!');
                    setStageProgress(idx + 1);
                    await new Promise((r) => setTimeout(r, faceConfig.timing.postStepMs));
                    runChallengeStep(idx + 1);
                } else {
                    // Soft rejection — show the hint, then retry the SAME step.
                    // Only end the whole session after MAX_IN_SESSION_RETRIES.
                    setTone('red');
                    if (result.reason) setInstruction(reasonToHint(result.reason, step.key));
                    await new Promise((r) => setTimeout(r, faceConfig.timing.rejectionPauseMs));
                    const tries = (stepRetriesRef.current[idx] ?? 0) + 1;
                    stepRetriesRef.current[idx] = tries;
                    if (tries > MAX_IN_SESSION_RETRIES) {
                        endSession(
                            result.reason
                                ? reasonToHint(result.reason, step.key)
                                : 'Face check failed — please try again',
                        );
                        return;
                    }
                    runChallengeStep(idx);
                }
            } catch {
                // Network / SDK error — retry the step a few times before giving up.
                const tries = (stepRetriesRef.current[idx] ?? 0) + 1;
                stepRetriesRef.current[idx] = tries;
                if (tries > MAX_IN_SESSION_RETRIES) {
                    endSession('Face check failed — please try again');
                    return;
                }
                await new Promise((r) => setTimeout(r, 800));
                runChallengeStep(idx);
            }
        },
        [captureFrame, endSession, runFinalCapture],
    );

    // Once camera is active and we're in detecting phase, kick off challenge 0.
    useEffect(() => {
        if (phase !== 'detecting' || !isActive || currentChallengeIdx !== -1) return;
        if (lastLivenessRef.current) return;
        const timer = setTimeout(
            () => runChallengeStep(0),
            faceConfig.timing.challengeStartDelayMs,
        );
        return () => clearTimeout(timer);
    }, [phase, isActive, currentChallengeIdx, runChallengeStep]);

    const handleBegin = () => {
        // Each Begin/Restart click = one attempt. Once the user has used all
        // attempts, route to contact-support instead of starting another run.
        // const count = incrementAttempt('face-detection');
        // if (count > MAX_ATTEMPTS) {
        //     stopCamera();
        //     goTo('contact-support', 1);
        //     return;
        // }
        // Reset transient session state for the new run.
        hasDetectedOnceRef.current = false;
        lastLivenessRef.current = null;
        stepRetriesRef.current = {};
        setStageProgress(0);
        setCurrentChallengeIdx(-1);
        setTone('idle');
        setProcessedFaceImage(null);
        setPhase('detecting');
        setInstruction('Starting AI face check…');
    };

    const currentChallenge =
        currentChallengeIdx >= 0 ? (CHALLENGE_STEPS[currentChallengeIdx]?.key ?? null) : null;
    const rotateYTarget =
        tone === 'locked'
            ? 0
            : currentChallenge === 'turn_right'
              ? faceConfig.pose.netMaskRotateYDeg
              : currentChallenge === 'turn_left'
                ? -faceConfig.pose.netMaskRotateYDeg
                : 0;
    const bracketColor =
        tone === 'red'
            ? '#EF4444'
            : tone === 'locked'
              ? '#22C55E'
              : tone === 'aligned'
                ? '#F59E0B'
                : '#FFD700';
    const baseProgress = stageProgress / CHALLENGE_STEPS.length;
    const inFlightBump =
        currentChallengeIdx >= 0 && tone === 'aligned' ? 1 / (CHALLENGE_STEPS.length * 2.5) : 0;
    const progressPct = Math.min(1, baseProgress + inFlightBump) * 100;
    const allDone = phase === 'done';

    return (
        <div
            className="flex flex-col h-full px-xd-40"
            style={{
                backgroundColor: allDone ? '#E9EEEE' : '#FFFFFF',
                transition: 'background-color 600ms ease',
            }}
        >
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

            <FlexibleSpace size={100} share={0.1} />

            {/* Header */}
            <h1 className="text-xd-30 font-bold text-center text-[#1D1D1D] mb-xd-5">
                Identity Verification !
            </h1>
            <div className="flex items-center justify-center gap-2 mb-xd-11">
                <Image
                    src={faceDetectSvg}
                    alt="live detect ID"
                    className="object-contain w-xd-20 h-xd-20"
                />
                <span className="text-xd-16 font-medium text-[#1D1D1D]">
                    {allDone ? 'Identity Verification !' : 'Live Face Detection'}
                </span>
            </div>

            {/* Camera viewport — same dimensions as FaceDetectionScreen */}
            <div
                className="relative mx-auto w-xd-350 h-xd-400 rounded-xd-30 overflow-hidden bg-[#000000] mb-xd-10"
                style={{
                    borderColor: allDone ? '#A3FF38' : '#388CFF',
                    borderWidth: allDone ? 2 : 1,
                    boxShadow:
                        tone === 'locked'
                            ? '0 0 0 3px rgba(34,197,94,0.6)'
                            : tone === 'red'
                              ? '0 0 0 3px rgba(239,68,68,0.5)'
                              : tone === 'aligned'
                                ? '0 0 0 3px rgba(245,158,11,0.55)'
                                : '0 0 0 1px rgba(0,0,0,0.06)',
                    transition: 'box-shadow 400ms ease',
                }}
            >
                {/* Live camera (hidden once we have the processed still). */}
                <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    playsInline
                    muted
                    autoPlay
                    style={{
                        transform: shouldMirror ? 'scaleX(-1)' : 'none',
                        visibility: allDone && processedFaceImage ? 'hidden' : 'visible',
                    }}
                />
                <canvas ref={canvasRef} className="hidden" />

                {/* Processed face still — replaces the live feed after capture. */}
                {allDone && processedFaceImage && (
                    <img
                        src={processedFaceImage}
                        alt="captured face"
                        className="absolute inset-0 w-full h-full object-cover"
                        style={{
                            backgroundColor: '#E9EEEE',
                            transform: shouldMirror ? 'scaleX(-1)' : 'none',
                        }}
                    />
                )}

                {/* Corner brackets */}
                <div className="absolute inset-5 pointer-events-none">
                    <div
                        className="absolute top-0 left-0 w-xd-18 h-xd-18 transition-colors duration-500"
                        style={{
                            borderTop: `3px solid ${bracketColor}`,
                            borderLeft: `3px solid ${bracketColor}`,
                            borderRadius: '10px 0 0 0',
                        }}
                    />
                    <div
                        className="absolute top-0 right-0 w-xd-18 h-xd-18 transition-colors duration-500"
                        style={{
                            borderTop: `3px solid ${bracketColor}`,
                            borderRight: `3px solid ${bracketColor}`,
                            borderRadius: '0 10px 0 0',
                        }}
                    />
                    <div
                        className="absolute bottom-0 left-0 w-xd-18 h-xd-18 transition-colors duration-500"
                        style={{
                            borderBottom: `3px solid ${bracketColor}`,
                            borderLeft: `3px solid ${bracketColor}`,
                            borderRadius: '0 0 0 10px',
                        }}
                    />
                    <div
                        className="absolute bottom-0 right-0 w-xd-18 h-xd-18 transition-colors duration-500"
                        style={{
                            borderBottom: `3px solid ${bracketColor}`,
                            borderRight: `3px solid ${bracketColor}`,
                            borderRadius: '0 0 10px 0',
                        }}
                    />
                </div>

                {/* HUD AI scanner — radar ring + face mesh, only while detecting */}
                {phase !== 'init' && phase !== 'ready' && !postFlashSparkles && (
                    <HudScanner
                        tone={tone}
                        rotateY={rotateYTarget}
                        flashing={flashing}
                        challenge={currentChallenge}
                    />
                )}

                {/* First-detection sparkle burst — celebrates initial face lock-on */}
                {firstDetectionBurst && <SparkleField duration={1.2} color="#7AA8FF" />}

                {/* Post-flash brush of stars — small, edge-only, never blocks the face. */}
                {postFlashSparkles && <SparkleField duration={1.0} color="#FFD700" edgeOnly />}

                {/* Post-flash scanning line — sweeps over the cropped face top↔bottom. */}
                {postFlashSparkles && (
                    <motion.div
                        className="absolute left-0 right-0 pointer-events-none"
                        style={{
                            height: '3px',
                            background:
                                'linear-gradient(90deg, transparent 0%, rgba(122,168,255,0.95) 50%, transparent 100%)',
                            boxShadow: '0 0 14px 3px rgba(122,168,255,0.7)',
                        }}
                        animate={{ top: ['0%', '100%', '0%'] }}
                        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}

                {/* AI scan-line — moves vertically during detecting to feel "powered by AI" */}
                {phase === 'detecting' && !flashing && (
                    <motion.div
                        className="absolute left-0 right-0 h-px pointer-events-none"
                        style={{
                            background:
                                'linear-gradient(90deg, transparent 0%, rgba(122,168,255,0.85) 50%, transparent 100%)',
                            boxShadow: '0 0 8px 2px rgba(122,168,255,0.5)',
                        }}
                        animate={{ top: ['0%', '100%', '0%'] }}
                        transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}

                {/* Capture flash — short translucent pulse so the user's face stays visible */}
                <AnimatePresence>
                    {flashing && (
                        <>
                            <motion.div
                                key="flash-white"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: [0, 0.55, 0] }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.6, times: [0, 0.25, 1] }}
                                className="absolute inset-0 bg-white pointer-events-none"
                            />
                            <motion.div
                                key="flash-gold"
                                initial={{ opacity: 0, scale: 0.4 }}
                                animate={{ opacity: [0, 0.6, 0], scale: [0.4, 1.4, 1.8] }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.7, ease: 'easeOut' }}
                                className="absolute inset-0 pointer-events-none"
                                style={{
                                    background:
                                        'radial-gradient(circle at center, rgba(255,215,120,0.7) 0%, rgba(255,215,120,0) 65%)',
                                }}
                            />
                        </>
                    )}
                </AnimatePresence>

                {/* Pre-camera "Begin" overlay — black scrim with AI dashed oval and tips */}
                {(phase === 'init' || phase === 'ready' || phase === 'failed') && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-xd-8 px-xd-20 bg-black/85">
                        <motion.svg
                            width="120"
                            height="155"
                            viewBox="0 0 120 155"
                            fill="none"
                            animate={{ opacity: [0.55, 0.95, 0.55] }}
                            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                        >
                            <ellipse
                                cx="60"
                                cy="77"
                                rx="52"
                                ry="70"
                                stroke={phase === 'failed' ? '#FF5F61' : '#FFD700'}
                                strokeWidth="2"
                                strokeDasharray="8 4"
                            />
                            <circle
                                cx="60"
                                cy="55"
                                r="18"
                                stroke={phase === 'failed' ? '#FF5F61' : '#FFD700'}
                                strokeWidth="1.5"
                                strokeDasharray="4 3"
                                opacity="0.6"
                            />
                        </motion.svg>
                        {phase === 'init' ? (
                            <p className="text-white/90 text-xd-12 text-center">
                                Preparing AI session…
                            </p>
                        ) : phase === 'failed' ? (
                            <p className="text-[#FF5F61] text-xd-12 text-center leading-snug">
                                {instruction}
                            </p>
                        ) : (
                            <p className="text-white/90 text-xd-12 text-center leading-snug">
                                Tap <span className="text-[#FFD700] font-semibold">Begin</span> to
                                start the AI liveness check
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Instruction message — sits below the camera frame */}
            {phase === 'detecting' && !allDone && (
                <div className="mx-auto w-xd-330 mt-xd-12 min-h-xd-40 flex items-center justify-center">
                    <AnimatePresence mode="wait">
                        <motion.p
                            key={instruction}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.2 }}
                            className={`text-xd-14 text-center leading-snug font-medium whitespace-pre-line ${
                                tone === 'red'
                                    ? 'text-[#E53E3E]'
                                    : tone === 'locked'
                                      ? 'text-[#22C55E]'
                                      : 'text-[#1D1D1D]'
                            }`}
                        >
                            {instruction}
                        </motion.p>
                    </AnimatePresence>
                </div>
            )}

            {/* Progress bar — only during the active challenge */}
            {phase === 'detecting' && !allDone && (
                <div className="mx-auto w-xd-330 mt-xd-10">
                    <FaceProgressBar pct={progressPct} tone={tone} />
                </div>
            )}

            {cameraError && (
                <div className="text-center mt-4">
                    <p className="text-xs text-red-500 mb-1">{cameraError}</p>
                    <button
                        onClick={startCamera}
                        className="text-xs text-[#388CFF] hover:underline"
                    >
                        Try Again
                    </button>
                </div>
            )}

            <FlexibleSpace size={200} share={0.8} />

            {/* Bottom section — privacy badge + Begin button (only on ready) */}
            <div className="mt-auto flex items-center flex-col justify-end">
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

                {(phase === 'ready' || phase === 'failed') && (
                    <motion.button
                        onClick={handleBegin}
                        whileTap={{ scale: 0.97 }}
                        className="w-xd-390 h-xd-60 py-4 rounded-xd-20 border border-dashed border-[#5D5C5D]/50 text-[#1D1D1D] text-xd-16 font-medium"
                    >
                        {phase === 'failed' ? 'Restart AI Face Check' : 'Begin AI Face Check'}
                    </motion.button>
                )}

                <FlexibleSpace size={35} share={0.1} />
            </div>
        </div>
    );
}
