import type { LivenessResult, IDDocument, MatchResult } from '@ramaaz/kyc-shared/types';

export type LivenessChallenge = 'look_straight' | 'turn_right' | 'turn_left';

/**
 * Structured status returned by the analyze-id API.
 *
 * - `not_found`  — No document detected in the frame; caller should keep polling.
 * - `error`      — Document detected but failed validation (see `code`).
 * - `success`    — Document detected and validated; see `nextStep` for the next action.
 */
export type AnalyzeIdStatus = 'not_found' | 'error' | 'success';

/**
 * Machine-readable error code, present when `status === 'error'`.
 *
 * - `MISSING_CRITICAL_DATA`  — Required fields (first name, DOB, document number) are
 *                              missing or below the confidence threshold.
 * - `INVALID_ID_TYPE`        — Document is not a recognised government-issued ID.
 * - `NO_TEXT_DETECTED`       — Textract found no text in the image.
 * - `WRONG_SIDE`             — Captured side doesn't match the requested side
 *                              (e.g. user shows the front during the back step).
 */
export type AnalyzeIdCode =
    | 'MISSING_CRITICAL_DATA'
    | 'INVALID_ID_TYPE'
    | 'NO_TEXT_DETECTED'
    | 'WRONG_SIDE'
    | 'SPOOFING_DETECTED';

/**
 * Next UI step, present when `status === 'success'`.
 *
 * - `REQUIRE_BACK` — Front side captured; the user must now capture the back side.
 * - `COMPLETE`     — Both sides captured; proceed to the summary / review step.
 */
export type AnalyzeIdNextStep = 'REQUIRE_BACK' | 'COMPLETE';

export interface AnalyzeIdResult {
    /** Structured status — the primary discriminant for all branching logic. */
    status: AnalyzeIdStatus;

    /** Error code — present when `status === 'error'`. */
    code?: AnalyzeIdCode;

    /** User-facing guidance message — present when `status === 'error'`. */
    message?: string;

    /** Next UI step — present when `status === 'success'`. */
    nextStep?: AnalyzeIdNextStep;

    /** Cropped document image (data URL) — present on success. */
    croppedImageData?: string;

    /** Tight crop of the ID photo — present on front-side success only. */
    idFaceImageData?: string;

    /** Which side of the ID this result describes. */
    side: 'front' | 'back';

    /**
     * Full extracted fields forwarded from `realKycService`.
     * Prefer `extractedData` for the summary UI; `extracted` is the raw
     * Partial<IDDocument> used internally.
     */
    extracted?: Partial<IDDocument>;

    /**
     * Clean 5-field payload for the confirmation UI — present when
     * `status === 'success'` and `nextStep === 'COMPLETE'`.
     */
    extractedData?: {
        idType: string;
        idName: string;
        country: string;
        name: string;
        nationalNumber: string;
        birthday: string;
        firstName?: string;
        lastName?: string;
        documentNumber?: string;
        expiryDate?: string;
        rawText?: string;
    };

    /**
     * @deprecated Use `status` / `code` instead.
     * Kept for transient backward-compatibility until all callers are updated.
     */
    found?: boolean;
    /** @deprecated Use `code` instead. */
    reason?: 'no_text_detected' | 'invalid_id_type' | 'insufficient_fields' | 'wrong_side';
}

export interface KycRequest {
    id: string;
    status: 'pending' | 'approved' | 'rejected';
    rejectionReason: string | null;
    fullName?: string;
}

export interface SubmitVerificationPayload {
    kycSessionId: string;
    frontImageData: string;
    backImageData?: string;
    selfieImageData: string;
    selfieVsIdScore: number;
    extracted: Partial<IDDocument>;
}

export interface IKycService {
    detectFace(
        faceImageData: string,
        challengeStep?: LivenessChallenge,
        options?: { crop?: boolean },
    ): Promise<LivenessResult>;
    analyzeId(
        imageData: string,
        side: 'front' | 'back',
        sessionHint?: string,
    ): Promise<AnalyzeIdResult>;
    captureID(imageData: string, side: 'front' | 'back'): Promise<Partial<IDDocument>>;
    matchFaceToID(faceData: string, idData: string): Promise<MatchResult>;
    startVideoCall(sessionId: string): Promise<{ streamUrl: string }>;
    endVideoCall(sessionId: string): Promise<{ success: boolean }>;
    sendWebhook(
        userId: string,
        status: 'verified' | 'rejected',
        extractedData: Record<string, unknown>,
    ): Promise<{ success: boolean }>;
    startSession(): Promise<{ sessionId: string; expiresAt: string }>;
    submitVerification(
        payload: SubmitVerificationPayload,
    ): Promise<{ success: boolean; kycRequest?: KycRequest }>;
    completeVideo(payload: {
        kycSessionId: string;
        videoCallUrl: string;
        livenessConfidence: number;
        videoVsIdScore: number;
    }): Promise<{ success: boolean; kycRequest?: KycRequest }>;
    verifyVideo(payload: VerifyVideoPayload): Promise<VerifyVideoResult>;
}

export interface VerifyVideoPayload {
    kycSessionId: string;
    language: 'ar' | 'en' | 'tr';
    expectedName: string;
    expectedBirthday: string;
    nameTranscript: string | null;
    ageTranscript: string | null;
    faceFrames: string[];
    idFaceImageData: string;
    livenessConfidence: number;
    videoCallUrl?: string;
}

export interface VerifyVideoMatch {
    matches: boolean;
    confidence: number;
    reasoning: string;
}

export interface VerifyVideoResult {
    passed: boolean;
    nameMatch: VerifyVideoMatch;
    ageMatch: VerifyVideoMatch;
    face: { bestScore: number; usedFrames: number };
    kycStatus?: 'pending' | 'approved' | 'rejected';
}
