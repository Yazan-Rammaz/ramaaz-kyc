/**
 * Verification domain types.
 *
 * These previously lived in rdb at apps/frontend/src/core/types/verification.ts,
 * and this package reached across the monorepo for them:
 *
 *   import type { … } from '../../../../../apps/frontend/src/core/types/verification'
 *
 * That only ever worked because the Worker and the frontend shared a checkout.
 * With the KYC service in its own repo the Worker owns its own copy.
 *
 * This is the wire contract between the Worker and any client, so it must stay
 * in step with the consumer's copy. When the KYC web app takes over the
 * enrollment flow, both sides should import one shared definition instead of
 * keeping two — until then, changes here need mirroring in rdb.
 */

export interface LivenessMetrics {
    yaw: number;
    pitch: number;
    roll: number;
    brightness: number;
    sharpness: number;
    eyesOpen: boolean;
    eyesOpenConfidence: number;
    sunglasses: boolean;
    confidence: number;
    boundingBox?: { left: number; top: number; width: number; height: number };
}

export interface LivenessResult {
    faceImageData: string;
    isLive: boolean;
    timestamp: number;
    challengeStep?: 'look_straight' | 'turn_right' | 'turn_left';
    metrics?: LivenessMetrics;
    reason?: string;
}

export interface IDDocument {
    frontImageData: string;
    backImageData: string;
    /** Tight crop of the photo printed on the front of the ID, when detected. */
    idFaceImageData?: string;
    idType: string;
    idName: string;
    country: string;
    /** Combined full name. */
    name: string;
    /** First name extracted separately. */
    firstName?: string;
    /** Last name extracted separately. */
    lastName?: string;
    nationalNumber: string;
    /** Alias for nationalNumber — exposed as documentNumber for display. */
    documentNumber?: string;
    birthday: string;
    /** Expiration / expiry date. */
    expiryDate?: string;
    /** All raw text lines from Textract joined with newlines. */
    rawText?: string;
}

export type FaceMatchVerdict = 'pass' | 'review' | 'fail';

export interface MatchResult {
    isMatch: boolean;
    confidence: number;
    /** 'pass' = auto-approve (≥90), 'review' = manual review (85–89), 'fail' = rejected (<85). */
    verdict?: FaceMatchVerdict;
    similarity?: number;
    errorMessage: string | null;
}
