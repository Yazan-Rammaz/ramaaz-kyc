import type { ReverifyPayload, ReverifyResult, ReverifySession } from '@/types/reverify';

/**
 * Client for the KYC Worker's re-verification endpoints.
 *
 * Replaces rdb's `HttpKycService` for this flow. Two deliberate differences:
 *
 * 1. **Direct paths, not opcodes.** rdb called these through an opcode gateway
 *    (`apiFetchOp('vs'|'vv')` → PROXY_OPS → /api/kyc/reverify/*) to keep endpoint
 *    names out of its client bundle. This service is a dedicated KYC origin whose
 *    only job is verification, so hiding the route names buys nothing here.
 *
 * 2. **No injected `fetch`.** rdb passed its auth-aware `apiFetch` because the
 *    session cookie lived in the host app. Here the request is same-origin to
 *    this app's own /api routes, which attach the verification session server-side.
 */

const BASE = '/api/kyc';

async function post<T>(path: string, body: unknown): Promise<{ res: Response; data: Partial<T> }> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as Partial<T>;
    return { res, data };
}

/**
 * Validates the challenge and, on the streaming path, opens the AWS session.
 * Throws on transport/HTTP failure — a rejected challenge is an error, not a
 * "failed" verification.
 */
export async function startReverify(challengeId: string): Promise<ReverifySession> {
    const { res, data } = await post<ReverifySession & { error?: string }>('/reverify/start', {
        challengeId,
    });
    if (!res.ok) {
        throw new Error(data.error ?? `Re-verify start failed: ${res.status}`);
    }
    return data as ReverifySession;
}

/**
 * Submits the captured frame. The Worker returns a structured result even for a
 * logical failure (wrong face, liveness rejected), so only a transport error or
 * a body with no `status` throws.
 *
 * The pass/fail decision is made ONLY in NestJS. This never decides locally.
 */
export async function submitReverify(payload: ReverifyPayload): Promise<ReverifyResult> {
    const { res, data } = await post<ReverifyResult & { error?: string }>(
        '/reverify/verify',
        payload,
    );
    if (!res.ok && !data.status) {
        throw new Error(data.error ?? `Re-verify failed: ${res.status}`);
    }
    return {
        status: data.status ?? 'error',
        reason: data.reason,
        code: data.code,
        message: data.message ?? data.error,
        stepToken: data.stepToken,
        faceMatchScore: data.faceMatchScore,
        livenessConfidence: data.livenessConfidence,
    };
}
