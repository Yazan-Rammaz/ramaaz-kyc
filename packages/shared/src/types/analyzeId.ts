/**
 * Contract for POST /api/kyc/analyze-id — the response the Worker returns after
 * running Textract/Rekognition over one side of a document.
 *
 * Lives in shared because both halves depend on it: the browser branches its
 * capture flow on `status`/`nextStep`, and the Worker produces it.
 */

/**
 * Primary discriminant for all branching.
 *
 * - `not_found` — no document detected in the frame; caller should keep polling
 * - `error`     — document detected but failed validation (see `code`)
 * - `success`   — detected and validated; see `nextStep` for the next action
 */
export type AnalyzeIdStatus = 'not_found' | 'error' | 'success';

/**
 * Machine-readable failure, present when `status === 'error'`.
 *
 * Consumers should map these to their own copy rather than rendering `message`
 * directly — that is what keeps the flow translatable.
 *
 * - `MISSING_CRITICAL_DATA` — required fields (first name, DOB, document
 *                             number) missing or below the confidence threshold
 * - `INVALID_ID_TYPE`       — not a recognised government-issued ID
 * - `NO_TEXT_DETECTED`      — Textract found no text in the image
 * - `WRONG_SIDE`            — captured side doesn't match the requested side
 * - `SPOOFING_DETECTED`     — the document appears to be shown on a screen
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
 * - `REQUIRE_BACK` — front captured; the user must now capture the back
 * - `COMPLETE`     — single-sided document (passport) or both sides captured
 */
export type AnalyzeIdNextStep = 'REQUIRE_BACK' | 'COMPLETE';

/** Fields extracted from a document, once both sides are accepted. */
export interface ExtractedIdData {
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
}

export interface AnalyzeIdResult {
    status: AnalyzeIdStatus;
    /** Present when `status === 'error'`. */
    code?: AnalyzeIdCode;
    /** Server-supplied guidance. Prefer mapping `code` to your own copy. */
    message?: string;
    /** Present when `status === 'success'`. */
    nextStep?: AnalyzeIdNextStep;
    /** Cropped document image (data URL) — present on success. */
    croppedImageData?: string;
    /** Tight crop of the photo printed on the ID — front-side success only. */
    idFaceImageData?: string;
    /** Which side this result describes. */
    side: 'front' | 'back';
    /** Raw extracted fields, used internally by the capture flow. */
    extracted?: Partial<ExtractedIdData & { frontImageData: string; idFaceImageData: string }>;
    /** Clean payload for the confirmation UI, when `nextStep === 'COMPLETE'`. */
    extractedData?: ExtractedIdData;
}
