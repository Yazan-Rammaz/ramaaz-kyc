/**
 * Contract for the enrollment submit path.
 *
 * Shared because both halves depend on the shape: the browser assembles it, the
 * Worker forwards it (signed) to NestJS.
 */

/** The KYC record NestJS returns after a submit. */
export interface KycRequest {
    id: string;
    status: 'pending' | 'approved' | 'rejected';
    rejectionReason: string | null;
    fullName?: string;
}

/**
 * Everything captured during enrollment, submitted in one call.
 *
 * Note what is NOT here: any pass/fail decision. The client sends artifacts and
 * a similarity score; NestJS decides. Which faces get compared (live↔ID,
 * live↔enrolled) and at what threshold is server-side policy, so a consumer can
 * require a stricter check without any frontend change.
 */
export interface SubmitVerificationPayload {
    /** Single-use — NestJS consumes it on the first submit, even a rejected one. */
    kycSessionId: string;
    frontImageData: string;
    backImageData?: string;
    /** The live face captured during the liveness challenge. */
    selfieImageData: string;
    /** Similarity of the live face to the photo on the document, 0–100. */
    selfieVsIdScore: number;
    /** Liveness confidence, so the backend can weigh it in the decision. */
    livenessConfidence?: number;
    extracted: {
        idType?: string;
        country?: string;
        /** The person's full name — never the document-type label. */
        name?: string;
        nationalNumber?: string;
        documentNumber?: string;
        birthday?: string;
        expiryDate?: string;
    };
}

export interface SubmitVerificationResult {
    success: boolean;
    kycRequest?: KycRequest;
}

export interface KycSession {
    sessionId: string;
    expiresAt: string;
}
