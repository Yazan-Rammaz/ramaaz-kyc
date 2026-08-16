import React from 'react';
import { redirect } from 'next/navigation';
import { readSessionToken } from '@/lib/session';
import { validateReturnTo } from '@/lib/returnTo';
import { readStepsClaim } from '@/lib/handoff';
import EnrollClient from './EnrollClient';

/**
 * Hosted KYC enrollment.
 *
 * Reached only via /verify/enroll/start, which verifies the hand-off token and
 * sets the session cookie. Server component so the gate runs before any camera
 * UI reaches the browser.
 *
 * The step list is read from the SESSION COOKIE's token, never from the URL.
 * A ?steps= parameter would let anyone drop the liveness check by editing the
 * address bar; inside the signed token it is the issuer's decision.
 */
export default async function EnrollPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

    const challengeId = one(params.challengeId) ?? '';
    const returnTo = validateReturnTo(one(params.returnTo) ?? null);

    const session = await readSessionToken();
    if (!session) redirect('/verify/error?code=no_session');
    if (!challengeId || !returnTo) redirect('/verify/error?code=invalid_link');

    const steps = readStepsClaim(session);
    if (steps.length === 0) redirect('/verify/error?code=invalid_link');

    return (
        <EnrollClient
            steps={steps}
            challengeId={challengeId}
            returnTo={returnTo.toString()}
        />
    );
}
