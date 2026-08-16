/**
 * Hand-off token verification.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 * In rdb this flow ran same-origin: the browser already held the `rdb_at` /
 * `rdb_step` cookies and they rode along automatically. This service is a
 * separate origin, so those cookies are not sent and identity has to cross the
 * boundary explicitly.
 *
 * The naive fix — forward the user's access token in the redirect URL — is bad:
 * it is long-lived, grants the full API surface, and URLs leak (Referer,
 * history, access logs). Instead NestJS mints a token scoped to exactly one
 * verification: one user, one challenge, a few minutes, this audience.
 *
 * ─── Why we verify the signature here ───────────────────────────────────────
 * The Worker's `jwtSub()` only base64-decodes the payload to read `sub`; it does
 * NOT check the signature. Its safety comes from NestJS's
 * `validateReverifyChallenge(challengeId, userId)`, which rejects a challenge
 * that does not belong to that user.
 *
 * That is adequate when the caller is rdb's own trusted frontend. It is not
 * adequate for a public redirect endpoint: anyone can craft a URL. So this
 * service verifies the signature before it will act on a token, and only then
 * establishes a session. An unsigned or expired token never reaches the Worker.
 */

export interface HandoffClaims {
    /** User id. The Worker reads this as `sub` to identify the subject. */
    sub: string;
    /** Challenge this token is bound to. Must match the challenge being run. */
    cid: string;
    /** Intended audience — prevents a token minted for another service being replayed here. */
    aud: string;
    /** Expiry, seconds since epoch. */
    exp: number;
    /** Unique token id, for single-use enforcement. */
    jti?: string;
    iss?: string;
    /**
     * Ordered capture stages the client must run, e.g. ["face","id","liveness"].
     * Optional — the face-only flow has no need for it.
     *
     * This belongs in the signed token rather than the URL because it decides
     * which compliance checks happen. A ?steps= parameter could be edited to
     * drop liveness; a signed claim cannot.
     *
     * Only stages exist here. What gets COMPARED afterwards (live↔ID,
     * live↔enrolled) and at what threshold is NestJS policy — the client never
     * acts on it, so it is deliberately not signed into this token.
     */
    steps?: string[];
}

/** Stages this build knows how to run. */
const KNOWN_STEPS = ['face', 'id', 'liveness'] as const;
export type KnownStep = (typeof KNOWN_STEPS)[number];

/**
 * Reads the `steps` claim from an already-verified token.
 *
 * Safe to decode without re-verifying ONLY because the caller obtained this
 * token from the httpOnly session cookie, which the `start` route of each flow
 * writes only after a successful signature check. Never call this on a token
 * taken straight off the wire.
 *
 * Unknown stage names are dropped rather than trusted: a token asking for a step
 * this build cannot render must not silently become a shorter journey that still
 * reports success.
 */
export function readStepsClaim(token: string): KnownStep[] {
    try {
        const payload = token.split('.')[1];
        if (!payload) return [];
        const claims = JSON.parse(bytesToUtf8(b64urlToBytes(payload))) as HandoffClaims;
        const raw = Array.isArray(claims.steps) ? claims.steps : [];
        return raw.filter((s): s is KnownStep =>
            (KNOWN_STEPS as readonly string[]).includes(s),
        );
    } catch {
        return [];
    }
}

export type VerifyResult =
    | { ok: true; claims: HandoffClaims; raw: string }
    | { ok: false; reason: VerifyFailure };

export type VerifyFailure =
    | 'missing_secret'
    | 'malformed'
    | 'bad_signature'
    | 'expired'
    | 'wrong_audience'
    | 'missing_claims'
    | 'challenge_mismatch';

const EXPECTED_AUDIENCE = 'ramaaz-kyc';

// Returns a Uint8Array explicitly backed by an ArrayBuffer (not ArrayBufferLike),
// which is what SubtleCrypto's BufferSource requires under strict TS.
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToUtf8(b: Uint8Array): string {
    return new TextDecoder().decode(b);
}

/**
 * Verifies an HS256 hand-off token.
 *
 * `expectedChallengeId` binds the token to the challenge actually being run — a
 * valid token for challenge A must not be usable to run challenge B.
 */
export async function verifyHandoffToken(
    token: string,
    expectedChallengeId: string,
    secret: string | undefined,
    now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
    // Fail closed. An unconfigured secret must never mean "skip verification".
    if (!secret) return { ok: false, reason: 'missing_secret' };

    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [h, p, s] = parts;

    let claims: HandoffClaims;
    try {
        claims = JSON.parse(bytesToUtf8(b64urlToBytes(p))) as HandoffClaims;
    } catch {
        return { ok: false, reason: 'malformed' };
    }

    // Signature first — never trust claims from an unverified token.
    let valid: boolean;
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify'],
        );
        // subtle.verify is constant-time; do not hand-roll a string comparison.
        valid = await crypto.subtle.verify(
            'HMAC',
            key,
            b64urlToBytes(s),
            new TextEncoder().encode(`${h}.${p}`),
        );
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!valid) return { ok: false, reason: 'bad_signature' };

    if (!claims.sub || !claims.cid) return { ok: false, reason: 'missing_claims' };
    if (claims.aud !== EXPECTED_AUDIENCE) return { ok: false, reason: 'wrong_audience' };
    if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'expired' };
    if (claims.cid !== expectedChallengeId) return { ok: false, reason: 'challenge_mismatch' };

    return { ok: true, claims, raw: token };
}
