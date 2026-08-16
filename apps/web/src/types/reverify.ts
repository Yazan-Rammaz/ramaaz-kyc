/**
 * Face re-verification (step-up) contract.
 *
 * Moved verbatim in shape from rdb's `services/kyc/kycService.interface.ts` and
 * `context/FaceReverifyContext.tsx` so the wire format is unchanged — the Worker
 * and NestJS are untouched by this extraction.
 */

/** Outcome handed back to the calling app once a challenge settles. */
export type FaceVerifyOutcome =
    | { ok: true; stepToken: string }
    | { ok: false; reason: FaceVerifyFailReason };

export type FaceVerifyFailReason = 'mismatch' | 'liveness' | 'cancelled' | 'expired' | 'error';

export interface ReverifySession {
    sessionId: string;
    region: string;
    mock?: boolean;
}

export interface ReverifyPayload {
    challengeId: string;
    /** AWS Face Liveness session id (streaming path). */
    sessionId?: string;
    /** Captured straight-face frame as a data URL (single-frame path). */
    liveFaceImageData?: string;
}

export interface ReverifyResult {
    status: 'passed' | 'failed' | 'error';
    /** Failure reason from NestJS when `status === 'failed'`. */
    reason?: string;
    /** Machine-readable error code when `status === 'error'`. */
    code?: string;
    /** User-facing message when `status === 'error'`. */
    message?: string;
    /** Single-use step-up proof, present when `status === 'passed'`. */
    stepToken?: string;
    faceMatchScore?: number;
    livenessConfidence?: number;
}
