'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { IDDocument, LivenessResult, MatchResult } from '@ramaaz/kyc-shared/types';

/**
 * Enrollment flow state.
 *
 * Replaces rdb's VerificationContext, with one structural difference: the step
 * order is DATA, not code.
 *
 * rdb hardcoded the sequence in three places — a VerificationStep union, a
 * STEP_ORDER array, and a switch in VerificationPage — and every screen named
 * its own successor (`goTo('face-match')`). Adding or reordering a step meant
 * editing all four.
 *
 * Here the sequence arrives in the signed hand-off token:
 *
 *   rdb   → steps: ["id", "liveness"]
 *   root  → steps: ["face", "id", "liveness"]
 *
 * Screens report an outcome (`completeStep`) and the flow decides what is next,
 * so a consumer changes its journey with one field in a token rather than a
 * frontend release. It lives in the token specifically so the client cannot
 * choose which compliance checks run — a query param would be trivially edited.
 */

/** A capture stage the client can be asked to run. */
export type EnrollStep = 'face' | 'id' | 'liveness';

/** Terminal states — reached after the last step, or on an unrecoverable failure. */
export type EnrollTerminal = 'submitting' | 'done' | 'support';

export type EnrollPhase = EnrollStep | EnrollTerminal;

interface EnrollFlowValue {
    /** Ordered stages for this challenge, from the token. */
    steps: EnrollStep[];
    /** Stage currently on screen. */
    phase: EnrollPhase;
    /** Direction of the last transition, for slide animations. */
    direction: 1 | -1;

    idDocument: IDDocument | null;
    livenessResult: LivenessResult | null;
    matchResult: MatchResult | null;
    /**
     * Single-use session for the submit call. NestJS consumes it on the first
     * submit — even a rejected one — so a retry must fetch a fresh one.
     */
    kycSessionId: string | null;

    setIdDocument: (doc: IDDocument | null) => void;
    setLivenessResult: (r: LivenessResult | null) => void;
    setMatchResult: (r: MatchResult | null) => void;
    setKycSessionId: (id: string | null) => void;

    /** Finish the current stage and advance; past the last stage → 'submitting'. */
    completeStep: () => void;
    /** Abandon the flow — unrecoverable failure or too many attempts. */
    failToSupport: () => void;
    /** Step back one stage (e.g. "retake" from a summary). */
    goBack: () => void;

    /** Attempts for a named stage, used to cap retries. */
    attempts: (key: string) => number;
    recordAttempt: (key: string) => number;
}

const Ctx = createContext<EnrollFlowValue | null>(null);

export function EnrollFlowProvider({
    steps,
    children,
}: {
    steps: EnrollStep[];
    children: React.ReactNode;
}) {
    const [index, setIndex] = useState(0);
    const [terminal, setTerminal] = useState<EnrollTerminal | null>(null);
    const [direction, setDirection] = useState<1 | -1>(1);

    const [idDocument, setIdDocument] = useState<IDDocument | null>(null);
    const [livenessResult, setLivenessResult] = useState<LivenessResult | null>(null);
    const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
    const [kycSessionId, setKycSessionId] = useState<string | null>(null);

    // Counts are refs, not state: bumping an attempt must not re-render a screen
    // mid-capture. rdb's version used state and returned a stale count from
    // incrementAttempt because the setter had not flushed yet.
    const attemptsRef = useRef<Record<string, number>>({});

    const completeStep = useCallback(() => {
        setDirection(1);
        // Past the last capture stage the flow enters 'submitting' (face match +
        // submit to NestJS); completing THAT reaches 'done'. Without this second
        // hop, a successful submit would re-enter 'submitting' and loop.
        setTerminal((t) => (t === 'submitting' ? 'done' : t));
        setIndex((i) => {
            const next = i + 1;
            if (next >= steps.length) setTerminal((t) => t ?? 'submitting');
            return next;
        });
    }, [steps.length]);

    const failToSupport = useCallback(() => {
        setDirection(1);
        setTerminal('support');
    }, []);

    const goBack = useCallback(() => {
        setDirection(-1);
        setTerminal(null);
        setIndex((i) => Math.max(0, i - 1));
    }, []);

    const recordAttempt = useCallback((key: string) => {
        const n = (attemptsRef.current[key] ?? 0) + 1;
        attemptsRef.current[key] = n;
        return n;
    }, []);

    const attempts = useCallback((key: string) => attemptsRef.current[key] ?? 0, []);

    const phase: EnrollPhase = terminal ?? steps[index] ?? 'submitting';

    const value = useMemo<EnrollFlowValue>(
        () => ({
            steps,
            phase,
            direction,
            idDocument,
            livenessResult,
            matchResult,
            kycSessionId,
            setIdDocument,
            setLivenessResult,
            setMatchResult,
            setKycSessionId,
            completeStep,
            failToSupport,
            goBack,
            attempts,
            recordAttempt,
        }),
        [
            steps,
            phase,
            direction,
            idDocument,
            livenessResult,
            matchResult,
            kycSessionId,
            completeStep,
            failToSupport,
            goBack,
            attempts,
            recordAttempt,
        ],
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEnrollFlow(): EnrollFlowValue {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error('useEnrollFlow must be used within an EnrollFlowProvider');
    return ctx;
}
