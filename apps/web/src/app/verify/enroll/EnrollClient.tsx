'use client';

import React, { useCallback } from 'react';
import { EnrollFlowProvider, useEnrollFlow, type EnrollStep } from '@/context/EnrollFlowContext';
import IntroScreen from '@/components/verification/screens/IntroScreen';
import IDCaptureScreen from '@/components/verification/screens/IDCaptureScreen';
import IDSummaryScreen from '@/components/verification/screens/IDSummaryScreen';
import AwsFaceLivenessScreen from '@/components/verification/screens/AwsFaceLiveness';
import FaceMatchScreen from '@/components/verification/screens/FaceMatchScreen';
import SuccessScreen from '@/components/verification/screens/SuccessScreen';
import ContactSupportScreen from '@/components/verification/screens/ContactSupportScreen';

type Settle = (outcome: 'passed' | 'failed', reason?: string) => void;

/**
 * Renders whichever stage the flow is on.
 *
 * The stage LIST comes from the signed hand-off token, so two consumers run
 * different journeys against identical code:
 *
 *   rdb   steps: ["id", "liveness"]
 *   root  steps: ["face", "id", "liveness"]
 *
 * Note there is no 'intro' or 'summary' in that list. Those are presentation
 * belonging to a capture stage, not compliance checks a consumer chooses — the
 * ID stage shows its own summary, and the intro is shown once before the first
 * stage. Only things a consumer can meaningfully require or omit are steps.
 */
function Stage({ onSettle }: { onSettle: Settle }) {
    const { phase, completeStep, idDocument } = useEnrollFlow();

    const exit = useCallback(() => onSettle('failed', 'cancelled'), [onSettle]);
    const done = useCallback(() => onSettle('passed'), [onSettle]);

    switch (phase) {
        // Capture and review are two views of one stage, not two steps. The
        // summary appears once a document exists and owns advancing the stage,
        // so "retake" can return to the camera without rewinding the journey.
        case 'id':
            return idDocument ? (
                <IDSummaryScreen onExit={exit} />
            ) : (
                <IDCaptureScreen onExit={exit} />
            );
        case 'liveness':
            return <AwsFaceLivenessScreen onExit={exit} />;

        // Not ported yet. Advancing past it would let a flow claim a check ran
        // that never did, so it blocks visibly instead of being skipped.
        case 'face':
            return <NotPorted step="face check" onSkip={completeStep} />;

        // Terminal stages, entered after the last capture step.
        case 'submitting':
            return <FaceMatchScreen onExit={exit} />;
        case 'done':
            return <SuccessScreen onDone={done} />;
        case 'support':
            return <ContactSupportScreen onExit={exit} />;
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

/** Shows the explainer once, then hands over to the step sequence. */
function Flow({ onSettle }: { onSettle: Settle }) {
    const [introDone, setIntroDone] = React.useState(false);
    const exit = useCallback(() => onSettle('failed', 'cancelled'), [onSettle]);

    if (!introDone) {
        return <IntroScreen onStart={() => setIntroDone(true)} onExit={exit} />;
    }
    return <Stage onSettle={onSettle} />;
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
    const onSettle = useCallback<Settle>(
        (outcome, reason) => {
            const url = new URL(returnTo);
            url.searchParams.set('kycChallenge', challengeId);
            url.searchParams.set('kyc', outcome);
            if (reason) url.searchParams.set('kycReason', reason);
            // Full navigation — this leaves the KYC origin. The step token is
            // never in this URL; the consumer's backend fetches the result from
            // NestJS using the challenge id.
            window.location.replace(url.toString());
        },
        [returnTo, challengeId],
    );

    return (
        <EnrollFlowProvider steps={steps}>
            <main className="xd-fit-screen h-dvh w-full bg-white">
                <Flow onSettle={onSettle} />
            </main>
        </EnrollFlowProvider>
    );
}
