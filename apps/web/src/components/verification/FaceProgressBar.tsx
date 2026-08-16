'use client';

import React from 'react';
import { motion } from 'framer-motion';

/**
 * Progress bar shared by the ID-capture and liveness steps.
 *
 * In rdb this was exported from AwsFaceLiveness.tsx and imported by
 * IDCaptureScreen — a cross-import between two screens that only shared a
 * widget. Standalone here so neither screen depends on the other.
 */
export type Tone = 'idle' | 'aligned' | 'locked' | 'red';

const FILL: Record<Tone, string> = {
    red: '#EF4444',
    locked: '#22C55E',
    aligned: '#F59E0B',
    idle: '#388CFF',
};

export function FaceProgressBar({ pct, tone }: { pct: number; tone: Tone }) {
    const clamped = Math.max(0, Math.min(1, pct / 100));

    return (
        <svg
            width="100%"
            height="5"
            viewBox="0 0 330 5"
            preserveAspectRatio="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            {/* Track — same stroke style as face-bar.svg */}
            <rect
                x="0.25"
                y="0.25"
                width="329.5"
                height="4.5"
                rx="2.25"
                fill="none"
                stroke="#707070"
                strokeWidth="0.5"
            />
            {/* Animated fill.
                `width` is set as well as animated: motion only supplies it once the
                first animation frame runs, so the initial render emitted
                width="undefined" and the browser logged
                `<rect> attribute width: Expected length, "undefined"` on every mount. */}
            <motion.rect
                x="0"
                y="0"
                width={330 * clamped}
                height="5"
                rx="2.5"
                fill={FILL[tone]}
                animate={{ width: 330 * clamped }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
            />
        </svg>
    );
}

export default FaceProgressBar;
