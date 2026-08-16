'use client';

import React, { useCallback } from 'react';
import FaceVerifyFlow from '@/components/face/FaceVerifyFlow';
import type { FaceVerifyOutcome } from '@/types/reverify';

/**
 * Client half of the hosted face flow.
 *
 * `returnTo` arrives already validated against the origin allowlist by the
 * server component — this component must not re-derive it from the URL, or the
 * allowlist could be bypassed by editing the address bar after load.
 *
 * ─── How the result crosses back ────────────────────────────────────────────
 * The step token is NEVER placed in the redirect. URLs leak through the Referer
 * header, browser history and server access logs, and that token authorises the
 * action the user was stopped on. The consumer is told only that the challenge
 * settled; its backend then retrieves the proof from NestJS using the
 * challengeId it already holds.
 */
export default function FaceVerifyClient({
    challengeId,
    reason,
    returnTo,
}: {
    challengeId: string;
    reason?: string;
    returnTo: string;
}) {
    const onResult = useCallback(
        (outcome: FaceVerifyOutcome) => {
            const url = new URL(returnTo);
            url.searchParams.set('kycChallenge', challengeId);
            if (outcome.ok) {
                url.searchParams.set('kyc', 'passed');
            } else {
                url.searchParams.set('kyc', 'failed');
                url.searchParams.set('kycReason', outcome.reason);
            }
            // Full navigation — this leaves the KYC origin. `replace` keeps the
            // verification URL out of the consumer app's back-stack.
            window.location.replace(url.toString());
        },
        [returnTo, challengeId],
    );

    return <FaceVerifyFlow challengeId={challengeId} reason={reason} onResult={onResult} />;
}
