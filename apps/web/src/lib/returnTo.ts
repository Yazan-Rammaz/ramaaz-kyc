/**
 * Return-URL validation.
 *
 * The flow is entered by redirect from a consumer app and must send the user
 * back when it settles. A `returnTo` taken straight from the query string is an
 * open redirect: an attacker links to
 *   /verify/face?challengeId=…&returnTo=https://evil.example
 * and the verification result is delivered to them.
 *
 * Every returnTo is therefore checked against an explicit origin allowlist.
 * Unknown origin → the flow refuses to start. There is no "just this once".
 */

/** Comma-separated absolute origins, e.g. "https://app.rdb.com,https://staging.rdb.com". */
const RAW_ALLOWED = process.env.NEXT_PUBLIC_KYC_ALLOWED_RETURN_ORIGINS ?? '';

export function allowedOrigins(): string[] {
    return RAW_ALLOWED.split(',')
        .map((o) => o.trim())
        .filter(Boolean);
}

/**
 * Returns the validated absolute URL, or null when it must be rejected.
 * Rejects: unparseable URLs, non-http(s) schemes (javascript:, data:), and any
 * origin not on the allowlist.
 */
export function validateReturnTo(raw: string | null): URL | null {
    if (!raw) return null;

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null; // relative or malformed — a cross-origin hand-off must be absolute
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const allowed = allowedOrigins();
    if (allowed.length === 0) return null; // fail closed when unconfigured
    if (!allowed.includes(url.origin)) return null;

    return url;
}
