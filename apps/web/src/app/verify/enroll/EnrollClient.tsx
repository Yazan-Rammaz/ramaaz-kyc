'use client';

import React, { useCallback } from 'react';
import { EnrollFlowProvider, useEnrollFlow, type EnrollStep } from '@/context/EnrollFlowContext';
import IDCaptureScreen from '@/components/verification/screens/IDCaptureScreen';
import AwsFaceLivenessScreen from '@/components/verification/screens/AwsFaceLiveness';

/**
 * Enrollment flow shell.
 *
 * Renders whichever stage the flow is on. The stage LIST comes from the signed
 * hand-off token, so two consumers can run different journeys against identical
 * code:
 *
 *   rdb   steps: ["id", "liveness"]
 *   root  steps: ["face", "id", "liveness"]   (face check before the document)
 *
 * Stages not yet ported render a placeholder rather than being silently skipped
 * — a missing step must be visible, not quietly dropped from a compliance flow.
 */
function Stage({ onSettle }: { onSettle: (outcome: 'passed' | 'failed', reason?: string) => void }) {
    const { phase, completeStep } = useEnrollFlow();

    const exit = useCallback(() => onSettle('failed', 'cancelled'), [onSettle]);

    switch (phase) {
        case 'id':
            return <IDCaptureScreen onExit={exit} />;
        case 'liveness':
            return <AwsFaceLivenessScreen onExit={exit} />;

        // Ported in a later commit. Advancing past it here would let a flow
        // claim a step ran that never did, so it blocks instead.
        case 'face':
            return <NotPorted step="face check" onSkip={completeStep} />;

        case 'submitting':
            return <Centered>Submitting your verification…</Centered>;
        case 'support':
            return <Centered>We could not complete your verification.</Centered>;
        default:
            return <Centered>Preparing…</Centered>;
    }
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center px-8">
            <p className="text-center text-sm text-[#8D8D8D]">{children}</p>
        </div>
    );
}

function NotPorted({ step, onSkip }: { step: string; onSkip: () => void }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
            <p className="text-center text-sm text-[#8D8D8D]">
                The <strong>{step}</strong> step is not available in this build yet.
            </p>
            <button
                onClick={onSkip}
                className="rounded-xd-20 border border-dashed border-[#5D5C5D]/50 px-6 py-3 text-xd-14"
            >
                Skip for testing
            </button>
        </div>
    );
}

export default function EnrollClient({
    steps,
    challengeId,
    returnTo,
}: {
    steps: EnrollStep[];
    challengeId: string;
    returnTo: string;
}) {
    const onSettle = useCallback(
        (outcome: 'passed' | 'failed', reason?: string) => {
            const url = new URL(returnTo);
            url.searchParams.set('kycChallenge', challengeId);
            url.searchParams.set('kyc', outcome);
            if (reason) url.searchParams.set('kycReason', reason);
            // Full navigation — this leaves the KYC origin.
            window.location.replace(url.toString());
        },
        [returnTo, challengeId],
    );

    return (
        <EnrollFlowProvider steps={steps}>
            <main className="xd-fit-screen h-dvh w-full bg-white">
                <Stage onSettle={onSettle} />
            </main>
        </EnrollFlowProvider>
    );
}
