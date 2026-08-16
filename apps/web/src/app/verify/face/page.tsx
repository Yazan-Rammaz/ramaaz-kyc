import React from 'react';
import { redirect } from 'next/navigation';
import { readSessionToken } from '@/lib/session';
import { validateReturnTo } from '@/lib/returnTo';
import FaceVerifyClient from './FaceVerifyClient';

/**
 * Hosted face re-verification.
 *
 * Reached only via /verify/face/start, which verifies the hand-off token and
 * sets the session cookie. This is a server component so the gate runs before
 * any camera UI is sent to the browser — an unauthenticated visitor gets an
 * error page, not a working camera bound to someone else's challenge.
 */
export default async function FaceVerifyPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

    const challengeId = one(params.challengeId) ?? '';
    const reason = one(params.reason);
    const returnTo = validateReturnTo(one(params.returnTo) ?? null);

    // No session → the visitor did not come through /start with a valid token.
    const session = await readSessionToken();
    if (!session) redirect('/verify/error?code=no_session');

    if (!challengeId || !returnTo) redirect('/verify/error?code=invalid_link');

    return (
        <main className="h-dvh w-full bg-white">
            <FaceVerifyClient
                challengeId={challengeId}
                reason={reason}
                returnTo={returnTo.toString()}
            />
        </main>
    );
}
