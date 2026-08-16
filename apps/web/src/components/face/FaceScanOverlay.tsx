'use client';

import React, { useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

export type ScanState = 'intro' | 'matching' | 'success' | 'fail';

const BLUE = '#388CFF';
const BLUE_GLOW = 'rgba(122, 168, 255, 0.9)';
const GREEN = '#34D317';
const RED = '#FF5F61';

// Design-space size of the camera frame (matches w-xd-350 h-xd-400).
const W = 350;
const H = 400;
const CX = W / 2;
const CY = 190;

// Face ID-style radial tick ring
const TICK_COUNT = 56;
const TICK_R = 128;
const TICK_LEN = 10;
const SWEEP_S = 1.5; // one full highlight revolution

// Shimmering "analysis points" scattered over the face area (golden-angle
// spiral — deterministic, no Math.random so SSR/CSR markup matches).
const DOT_COUNT = 28;

interface Tick {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    delay: number;
}

function buildTicks(): Tick[] {
    return Array.from({ length: TICK_COUNT }, (_, i) => {
        const angle = (i / TICK_COUNT) * Math.PI * 2 - Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
            x1: CX + cos * TICK_R,
            y1: CY + sin * TICK_R,
            x2: CX + cos * (TICK_R + TICK_LEN),
            y2: CY + sin * (TICK_R + TICK_LEN),
            delay: (i / TICK_COUNT) * SWEEP_S,
        };
    });
}

function buildDots(): { x: number; y: number; delay: number; dur: number }[] {
    return Array.from({ length: DOT_COUNT }, (_, i) => {
        const r = Math.sqrt((i + 0.5) / DOT_COUNT);
        const theta = i * 2.39996; // golden angle
        return {
            x: CX + Math.cos(theta) * r * 78,
            y: CY + Math.sin(theta) * r * 96,
            delay: (i % 7) * 0.23,
            dur: 1.4 + (i % 5) * 0.18,
        };
    });
}

const CORNERS: string[] = [
    `M 26 60 L 26 40 Q 26 26 40 26 L 60 26`, // top-left
    `M ${W - 60} 26 L ${W - 40} 26 Q ${W - 26} 26 ${W - 26} 40 L ${W - 26} 60`, // top-right
    `M ${W - 26} ${H - 60} L ${W - 26} ${H - 40} Q ${W - 26} ${H - 26} ${W - 40} ${H - 26} L ${W - 60} ${H - 26}`, // bottom-right
    `M 60 ${H - 26} L 40 ${H - 26} Q 26 ${H - 26} 26 ${H - 40} L 26 ${H - 60}`, // bottom-left
];

interface FaceScanOverlayProps {
    state: ScanState;
    /**
     * True once a face is present in the frame. The scanning layers (ticks,
     * beam, dots, corners) stay hidden until verification has started AND a
     * face is detected; before that only a faint positioning oval shows.
     */
    faceDetected: boolean;
}

/**
 * Face ID-style AI scanning overlay for the live camera frame.
 *
 * Nothing renders during 'intro'. Once verification starts, a faint oval
 * guides positioning; when a face is detected all scanning layers fade in:
 *  - radial tick ring with a sweeping highlight
 *  - thin vertical scan beam + shimmering analysis points over the face
 *  - pulsing viewfinder corner brackets
 *  - on success: ring + checkmark stroke-draw with a green flash
 *  - on fail: ring + cross stroke-draw
 *
 * Respects prefers-reduced-motion: loops freeze into calm static states.
 */
export default function FaceScanOverlay({ state, faceDetected }: FaceScanOverlayProps) {
    const reduceMotion = useReducedMotion();
    const ticks = useMemo(buildTicks, []);
    const dots = useMemo(buildDots, []);

    if (state === 'intro') return null;

    const matching = state === 'matching';
    const scanning = matching && faceDetected;
    const tickColor = state === 'success' ? GREEN : state === 'fail' ? RED : BLUE;

    return (
        <div className="absolute inset-0 pointer-events-none z-20" aria-hidden="true">
            {/* Vignette to lift the overlay off the video feed */}
            <motion.div
                className="absolute inset-0"
                style={{
                    background:
                        'radial-gradient(ellipse 62% 55% at 50% 47.5%, transparent 55%, rgba(0,0,0,0.45) 100%)',
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: scanning ? 1 : 0.4 }}
                transition={{ duration: 0.5 }}
            />

            {/* Scan beam — thin bright edge with a soft trailing veil */}
            <AnimatePresence>
                {scanning && !reduceMotion && (
                    <motion.div
                        key="beam"
                        className="absolute left-0 right-0"
                        style={{
                            height: '12%',
                            background:
                                'linear-gradient(180deg, transparent 0%, rgba(122,168,255,0.06) 45%, rgba(122,168,255,0.16) 88%, rgba(190,215,255,0.8) 99.2%, transparent 100%)',
                            mixBlendMode: 'screen',
                        }}
                        initial={{ top: '-14%', opacity: 0 }}
                        animate={{ top: ['-14%', '102%'], opacity: 1 }}
                        exit={{ opacity: 0, transition: { duration: 0.25 } }}
                        transition={{
                            top: { duration: 1.9, repeat: Infinity, ease: 'easeInOut' },
                            opacity: { duration: 0.3 },
                        }}
                    />
                )}
            </AnimatePresence>

            <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 w-full h-full">
                {/* Corner brackets */}
                {CORNERS.map((d, i) => (
                    <motion.path
                        key={`corner-${i}`}
                        d={d}
                        fill="none"
                        stroke={tickColor}
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        initial={{ opacity: 0 }}
                        animate={
                            scanning && !reduceMotion
                                ? { opacity: [0.4, 1, 0.4] }
                                : { opacity: matching ? 0 : 0.9 }
                        }
                        transition={
                            scanning && !reduceMotion
                                ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut' }
                                : { duration: 0.4 }
                        }
                    />
                ))}

                {/* Radial tick ring */}
                {ticks.map((t, i) => (
                    <motion.line
                        key={`tick-${i}`}
                        x1={t.x1}
                        y1={t.y1}
                        x2={t.x2}
                        y2={t.y2}
                        stroke={tickColor}
                        strokeWidth={1.1}
                        strokeLinecap="round"
                        initial={{ opacity: 0 }}
                        animate={
                            scanning && !reduceMotion
                                ? { opacity: [0.12, 1, 0.12] }
                                : {
                                      opacity:
                                          state === 'success'
                                              ? 0.95
                                              : state === 'fail'
                                                ? 0.5
                                                : scanning
                                                  ? 0.5
                                                  : 0,
                                  }
                        }
                        transition={
                            scanning && !reduceMotion
                                ? {
                                      duration: SWEEP_S,
                                      repeat: Infinity,
                                      ease: 'easeInOut',
                                      delay: t.delay,
                                  }
                                : { duration: 0.5 }
                        }
                    />
                ))}

                {/* Face guide oval — the only thing visible before a face is found */}
                <AnimatePresence>
                    {matching && (
                        <motion.ellipse
                            key="guide"
                            cx={CX}
                            cy={CY}
                            rx={86}
                            ry={104}
                            fill="none"
                            stroke={BLUE}
                            strokeWidth={1}
                            strokeDasharray="2 6"
                            strokeLinecap="round"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: faceDetected ? 0.45 : 0.3 }}
                            exit={{ opacity: 0, transition: { duration: 0.3 } }}
                            transition={{ duration: 0.4 }}
                        />
                    )}
                </AnimatePresence>

                {/* Shimmering analysis points */}
                <AnimatePresence>
                    {scanning && (
                        <motion.g
                            key="dots"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0, transition: { duration: 0.25 } }}
                        >
                            {dots.map((d, i) => (
                                <motion.circle
                                    key={`dot-${i}`}
                                    cx={d.x}
                                    cy={d.y}
                                    r={1.2}
                                    fill={BLUE_GLOW}
                                    animate={
                                        reduceMotion
                                            ? { opacity: 0.4 }
                                            : { opacity: [0, 0.8, 0], scale: [0.6, 1.2, 0.6] }
                                    }
                                    transition={{
                                        duration: d.dur,
                                        repeat: Infinity,
                                        ease: 'easeInOut',
                                        delay: d.delay,
                                    }}
                                />
                            ))}
                        </motion.g>
                    )}
                </AnimatePresence>

                {/* Result badge: stroke-drawn ring + checkmark / cross */}
                <AnimatePresence>
                    {(state === 'success' || state === 'fail') && (
                        <motion.g
                            key={`result-${state}`}
                            initial={{ scale: 0.65, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 320, damping: 22 }}
                            style={{ transformOrigin: `${CX}px ${CY}px` }}
                        >
                            <circle cx={CX} cy={CY} r={46} fill="rgba(0,0,0,0.45)" />
                            <motion.circle
                                cx={CX}
                                cy={CY}
                                r={46}
                                fill="none"
                                stroke={state === 'success' ? GREEN : RED}
                                strokeWidth={2}
                                strokeLinecap="round"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 0.45, ease: 'easeOut' }}
                            />
                            {state === 'success' ? (
                                <motion.path
                                    d={`M ${CX - 20} ${CY + 2} L ${CX - 6} ${CY + 16} L ${CX + 22} ${CY - 14}`}
                                    fill="none"
                                    stroke={GREEN}
                                    strokeWidth={3}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    initial={{ pathLength: 0 }}
                                    animate={{ pathLength: 1 }}
                                    transition={{ duration: 0.35, delay: 0.2, ease: 'easeOut' }}
                                />
                            ) : (
                                <motion.path
                                    d={`M ${CX - 15} ${CY - 15} L ${CX + 15} ${CY + 15} M ${CX + 15} ${CY - 15} L ${CX - 15} ${CY + 15}`}
                                    fill="none"
                                    stroke={RED}
                                    strokeWidth={3}
                                    strokeLinecap="round"
                                    initial={{ pathLength: 0 }}
                                    animate={{ pathLength: 1 }}
                                    transition={{ duration: 0.35, delay: 0.2, ease: 'easeOut' }}
                                />
                            )}
                        </motion.g>
                    )}
                </AnimatePresence>
            </svg>

            {/* Success flash */}
            <AnimatePresence>
                {state === 'success' && (
                    <motion.div
                        key="flash"
                        className="absolute inset-0"
                        style={{ background: GREEN }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0, 0.16, 0] }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.7, ease: 'easeOut' }}
                    />
                )}
            </AnimatePresence>
        </div>
    );
}
