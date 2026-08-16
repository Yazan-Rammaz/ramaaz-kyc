import type { AnalyzeIdResult } from '@ramaaz/kyc-shared/types/analyze-id';
import type { LivenessChallenge, LivenessResult } from '@ramaaz/kyc-shared/types';
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
 * Scores one captured frame of the liveness challenge.
 *
 * `crop` asks the server to return a tight face crop, which becomes the selfie
 * carried into face-match. The response's `faceImageData` falls back to the
 * frame we sent when the server returns no crop — downstream matching always
 * needs a usable image, and silently passing `undefined` would fail much later
 * and much less obviously.
 */
export async function detectFace(
    faceImageData: string,
    challengeStep: LivenessChallenge = 'look_straight',
    options: { crop?: boolean } = {},
): Promise<LivenessResult> {
    const { res, data } = await post<LivenessResult & { error?: string }>('/liveness', {
        faceImageData,
        challengeStep,
        crop: options.crop,
    });
    // A rejected pose comes back 200 with isLive:false — only transport failures
    // throw, so the capture loop can keep polling frames.
    if (!res.ok && data.isLive === undefined) {
        throw new Error(data.error ?? `Liveness failed: ${res.status}`);
    }
    return { ...data, faceImageData: data.faceImageData ?? faceImageData } as LivenessResult;
}

/**
 * Runs OCR and validation over one captured side of a document.
 *
 * Throws only on transport/HTTP failure. A document that is unreadable, the
 * wrong side, or shown on a screen comes back as a normal 200 with
 * `status: 'error'` and a `code` — those are expected outcomes of the capture
 * loop, not exceptions, and the caller retries on the next frame.
 *
 * `sessionHint` groups the front and back captures of one document together so
 * the server can cross-check that the back belongs to the same card.
 */
export async function analyzeId(
    imageData: string,
    side: 'front' | 'back',
    sessionHint = 'default',
): Promise<AnalyzeIdResult> {
    const { res, data } = await post<AnalyzeIdResult & { error?: string }>('/analyze-id', {
        imageData,
        side,
        sessionHint,
    });
    if (!res.ok && !data.status) {
        throw new Error(data.error ?? `Analyze ID failed: ${res.status}`);
    }
    return data as AnalyzeIdResult;
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
