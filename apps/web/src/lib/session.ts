import { cookies } from 'next/headers';

/**
 * Verification session.
 *
 * Once a hand-off token is verified we stop passing it around in URLs and hold
 * it in an httpOnly cookie scoped to this origin. The browser then behaves
 * normally for the rest of the flow (the client calls /api/kyc/* same-origin,
 * the proxy attaches identity server-side) and the token never appears in
 * client JavaScript, the address bar, or browser history.
 *
 * The cookie stores the hand-off token verbatim rather than a rewritten session
 * id, because the Worker needs a JWT whose payload carries `sub`. Re-minting one
 * here would mean this service signing identity assertions about users, which is
 * NestJS's job, not ours.
 */

export const SESSION_COOKIE = 'kyc_handoff';

/**
 * Lifetime of the verification session. Long enough for a user to read the
 * prompt, grant camera permission, and retry a couple of times; short enough
 * that a stolen cookie is nearly worthless.
 */
export const SESSION_TTL_SECONDS = 15 * 60;

export interface SessionCookieOptions {
    /** Set false only for local http development. */
    secure: boolean;
}

export function sessionCookieOptions({ secure }: SessionCookieOptions) {
    return {
        httpOnly: true,
        secure,
        // Lax, not Strict: the user arrives here by a top-level cross-site
        // redirect from the consumer app, and Strict would withhold the cookie
        // on that navigation. Lax still blocks cross-site subrequests.
        sameSite: 'lax' as const,
        path: '/',
        maxAge: SESSION_TTL_SECONDS,
    };
}

/** Reads the raw hand-off token for this request, or null. */
export async function readSessionToken(): Promise<string | null> {
    const jar = await cookies();
    return jar.get(SESSION_COOKIE)?.value ?? null;
}
