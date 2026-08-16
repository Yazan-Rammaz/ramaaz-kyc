'use client';

import React, { Suspense, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import FaceVerifyFlow from '@/components/face/FaceVerifyFlow';
import { validateReturnTo } from '@/lib/returnTo';
import type { FaceVerifyOutcome } from '@/types/reverify';

/**
 * Hosted face re-verification.
 *
 * Entered by redirect from a consumer app (or loaded in a Flutter webview):
 *   /verify/face?challengeId=…&reason=…&returnTo=https://app.example/home
 *
 * Replaces rdb's local /face-verify route. The behavioural difference is the
 * hand-off: rdb ran same-origin and could write the step token straight into its
 * own cookie. This app is a separate origin, so the result has to cross back.
 *
 * ─── How the result is delivered ────────────────────────────────────────────
 * The step token is NEVER placed in the redirect URL. URLs leak — through the
 * Referer header, browser history, and server access logs — and this token is a
 * bearer proof that authorises the gated action the user was stopped on.
 *
 * Instead the flow reports only an opaque outcome, and the consumer's backend
 * retrieves the token from NestJS using the challengeId it already holds. The
 * consumer learns "this challenge passed"; the secret never transits the client.
 */
function FaceVerifyPageInner() {
    const params = useSearchParams();

    const challengeId = params.get('challengeId') ?? '';
    const reason = params.get('reason') ?? undefined;
    const returnTo = validateReturnTo(params.get('returnTo'));

    const onResult = useCallback(
        (outcome: FaceVerifyOutcome) => {
            if (!returnTo) return;

            const url = new URL(returnTo.toString());
            url.searchParams.set('kycChallenge', challengeId);
            if (outcome.ok) {
                url.searchParams.set('kyc', 'passed');
            } else {
                url.searchParams.set('kyc', 'failed');
                url.searchParams.set('kycReason', outcome.reason);
            }

            // Full navigation, not router.push — this leaves the KYC origin.
            // `replace` keeps the verification URL (which carries challengeId)
            // out of the consumer app's back-stack.
            window.location.replace(url.toString());
        },
        [returnTo, challengeId],
    );

    if (!challengeId) return <Fatal message="Missing verification challenge." />;

    // Fail closed: an unvalidated returnTo means we have nowhere safe to send the
    // result, so the flow must not run at all. Starting and then discarding the
    // outcome would burn the user's challenge for nothing.
    if (!returnTo) return <Fatal message="This verification link is not valid." />;

    return (
        <main className="h-dvh w-full bg-white">
            <FaceVerifyFlow challengeId={challengeId} reason={reason} onResult={onResult} />
        </main>
    );
}

function Fatal({ message }: { message: string }) {
    return (
        <main className="flex h-dvh items-center justify-center px-8">
            <p className="text-center text-sm text-[#8D8D8D]">{message}</p>
        </main>
    );
}

export default function FaceVerifyPage() {
    return (
        <Suspense fallback={null}>
            <FaceVerifyPageInner />
        </Suspense>
    );
}
