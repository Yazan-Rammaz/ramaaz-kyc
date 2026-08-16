import { NextRequest, NextResponse } from 'next/server';
import { verifyHandoffToken, readStepsClaim } from '@/lib/handoff';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { validateReturnTo } from '@/lib/returnTo';

/**
 * Entry point for an enrollment. Consumer apps redirect here:
 *
 *   /verify/enroll/start?t=<handoffToken>&challengeId=…&returnTo=…
 *
 * Same shape as /verify/face/start — verify the token, exchange it for an
 * httpOnly session cookie, then redirect to the flow so the token never sits in
 * the address bar or the back-stack. See that file for why the redirect matters.
 *
 * Additionally requires the token to carry at least one runnable `steps` entry.
 * Failing closed here is deliberate: a token with no recognised steps would
 * otherwise open a flow that captures nothing and still reports back, which is
 * the worst possible outcome for a compliance check.
 */
export async function GET(req: NextRequest) {
    const q = req.nextUrl.searchParams;
    const token = q.get('t') ?? '';
    const challengeId = q.get('challengeId') ?? '';
    const returnTo = validateReturnTo(q.get('returnTo'));

    if (!returnTo || !token || !challengeId) return fail(req, 'invalid_link');

    const result = await verifyHandoffToken(token, challengeId, process.env.KYC_HANDOFF_SECRET);

    if (!result.ok) {
        // Coarse on purpose — this endpoint is publicly reachable, so telling a
        // caller "bad signature" vs "wrong audience" hands them a probing oracle.
        console.warn('[kyc/handoff] enroll rejected:', result.reason);
        return fail(req, result.reason === 'expired' ? 'expired' : 'invalid_link');
    }

    if (readStepsClaim(result.raw).length === 0) {
        console.warn('[kyc/handoff] enroll rejected: no runnable steps in token');
        return fail(req, 'invalid_link');
    }

    const dest = new URL('/verify/enroll', req.nextUrl.origin);
    dest.searchParams.set('challengeId', challengeId);
    dest.searchParams.set('returnTo', returnTo.toString());

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
