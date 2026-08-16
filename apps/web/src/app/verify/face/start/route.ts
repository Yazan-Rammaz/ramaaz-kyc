import { NextRequest, NextResponse } from 'next/server';
import { verifyHandoffToken } from '@/lib/handoff';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { validateReturnTo } from '@/lib/returnTo';

/**
 * Entry point for a verification. This is the URL consumer apps redirect to:
 *
 *   /verify/face/start?t=<handoffToken>&challengeId=…&returnTo=…&reason=…
 *
 * It verifies the token, converts it into an httpOnly session cookie, and
 * redirects to the flow itself — which never sees the token.
 *
 * Why a redirect rather than rendering the flow here: an HTTP redirect REPLACES
 * the entry in session history rather than adding one, so `?t=` does not sit in
 * the user's back-stack where a later screenshot, shared link, or browser-sync
 * would carry it. It also means a page refresh mid-flow re-reads the cookie
 * instead of replaying a now-consumed token.
 */
export async function GET(req: NextRequest) {
    const q = req.nextUrl.searchParams;
    const token = q.get('t') ?? '';
    const challengeId = q.get('challengeId') ?? '';
    const reason = q.get('reason');
    const returnToRaw = q.get('returnTo');

    // Validate the return target first. If we cannot safely report a result,
    // running the flow only burns the user's challenge for nothing.
    const returnTo = validateReturnTo(returnToRaw);
    if (!returnTo) return fail(req, 'invalid_link');

    if (!token || !challengeId) return fail(req, 'invalid_link');

    const result = await verifyHandoffToken(
        token,
        challengeId,
        process.env.KYC_HANDOFF_SECRET,
    );

    if (!result.ok) {
        // Deliberately coarse: the user sees "expired" vs "invalid" and nothing
        // more. Reporting bad_signature vs wrong_audience separately would let
        // an attacker probe the token format. The precise reason is logged.
        console.warn('[kyc/handoff] rejected:', result.reason);
        const shown = result.reason === 'expired' ? 'expired' : 'invalid_link';
        return fail(req, shown);
    }

    const dest = new URL('/verify/face', req.nextUrl.origin);
    dest.searchParams.set('challengeId', challengeId);
    dest.searchParams.set('returnTo', returnTo.toString());
    if (reason) dest.searchParams.set('reason', reason);

    const res = NextResponse.redirect(dest, 303);
    res.cookies.set(
        SESSION_COOKIE,
        result.raw,
        sessionCookieOptions({ secure: req.nextUrl.protocol === 'https:' }),
    );
    return res;
}

function fail(req: NextRequest, code: 'invalid_link' | 'expired') {
    const url = new URL('/verify/error', req.nextUrl.origin);
    url.searchParams.set('code', code);
    return NextResponse.redirect(url, 303);
}
