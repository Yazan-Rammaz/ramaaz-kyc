

import {
    TextractClient,
    AnalyzeIDCommand,
    type AnalyzeIDCommandOutput,
    type IdentityDocumentField,
    type Block,
} from '@aws-sdk/client-textract';
import {
    RekognitionClient,
    DetectFacesCommand,
    DetectTextCommand,
    CompareFacesCommand,
    DetectLabelsCommand,
    type BoundingBox as RekBoundingBox,
    type FaceDetail,
} from '@aws-sdk/client-rekognition';
// import sharp from 'sharp';
import {
    RGBLuminanceSource,
    BinaryBitmap,
    HybridBinarizer,
    MultiFormatReader,
    DecodeHintType,
    BarcodeFormat,
} from '@zxing/library';
import { idConfig, faceConfig } from '@ramaaz/kyc-shared/config';
import { looksLikeSyrianId, parseSyrianId } from './syrianIdParser';
import { looksLikeTurkishId, parseTurkishId } from './turkishIdParser';
import { looksLikeLebaneseId, parseLebaneseId } from './lebaneseIdParser';
import { extractCountry } from './countryExtractor';
import { KYC_TRANSLATE_ARABIC_NAMES, translateNameIfArabic } from './aiTranslateData';
import { getImageSize, cropToJpeg, getRawRgba } from './imageOps';

export const awsRegion = process.env.AWS_REGION || 'us-east-1';
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
    console.warn(
        '[realKycService] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing. Real KYC calls will fail.',
    );
}

const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

export const textractClient = new TextractClient({
    region: awsRegion,
    credentials,
});
export const rekognitionClient = new RekognitionClient({
    region: awsRegion,
    credentials,
});

/** Normalized [0..1] bounding box, AWS convention (left/top origin top-left). */
export interface NormalizedBox {
    width: number;
    height: number;
    left: number;
    top: number;
}

export interface DetectedField {
    label: string;
    value: string;
}

export interface AnalyzeIdDocumentResult {
    found: boolean;
    extracted: {
        idType?: string;
        country?: string;
        name?: string;
        firstName?: string;
        lastName?: string;
        nationalNumber?: string;
        documentNumber?: string;
        passportNumber?: string;
        birthday?: string;
        expirationDate?: string;
        /** Alias for expirationDate — surfaced as expiryDate for consumers. */
        expiryDate?: string;
        address?: string;
        /** All Textract LINE texts joined with newlines — useful for display and debugging. */
        rawText?: string;
        /**
         * Raw lines harvested from Textract when the standard AnalyzeID
         * fields are sparse / the document type came back UNKNOWN. Keyword-
         * matched rows are surfaced first, then the longest unique strings.
         */
        detectedFields?: DetectedField[];
    };
    /** Document crop as a `data:image/jpeg;base64,...` URL. */
    croppedImageData?: string;
    /** Photo-on-ID crop as a `data:image/jpeg;base64,...` URL (front side only). */
    idFaceImageData?: string;
    documentBox?: NormalizedBox;
    idFaceBox?: NormalizedBox;
    raw?: AnalyzeIDCommandOutput;
    /**
     * Machine-readable rejection reason — only present when `found: false`.
     * 'no_text_detected'   – Textract returned no fields and no raw text.
     * 'invalid_id_type'    – ID_TYPE is missing or not a government document.
     * 'insufficient_fields'– Fewer than the required mandatory fields pass the
     *                        confidence threshold.
     */
    reason?: 'no_text_detected' | 'invalid_id_type' | 'insufficient_fields' | 'wrong_side';
}

// ── Barcode helpers (Arabic-script IDs with PDF417 on back: Syrian, Lebanese) ─

/** Convert Arabic-Indic digits (٠–٩) to Western digits (0–9). */
function arabicIndicToWestern(s: string): string {
    return s.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

/**
 * Attempt to decode a 2D barcode (PDF417, DataMatrix, QR) from an image buffer.
 * Tries the full image first, then the bottom 40% crop (where Syrian ID barcodes live).
 * Returns the decoded text, or null if no barcode was found.
 */
async function decodeBarcodeFromBuffer(imageBuffer: Buffer): Promise<string | null> {
    const meta = getImageSize(imageBuffer);
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return null;

    const hints = new Map<DecodeHintType, unknown>([
        [
            DecodeHintType.POSSIBLE_FORMATS,
            [BarcodeFormat.PDF_417, BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE],
        ],
        [DecodeHintType.TRY_HARDER, true],
    ]);

    const regions: (null | {
        left: number;
        top: number;
        width: number;
        height: number;
    })[] = [
        null, // full image
        {
            left: 0,
            top: Math.floor(h * 0.6),
            width: w,
            height: Math.floor(h * 0.4),
        }, // bottom 40%
    ];

    for (const region of regions) {
        try {
            const { data, width, height } = getRawRgba(imageBuffer, region ?? undefined);
            const source = new RGBLuminanceSource(
                new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
                width,
                height,
            );
            const bitmap = new BinaryBitmap(new HybridBinarizer(source));
            const reader = new MultiFormatReader();
            reader.setHints(hints);
            const decoded = reader.decode(bitmap);
            const text = decoded.getText();
            if (text) return text;
        } catch {
            // NotFoundException is thrown when no barcode found — expected
        }
    }
    return null;
}

/**
 * Extract an 11-digit national number from decoded barcode text.
 * Handles Arabic-Indic and Western digits.
 * Used for Syrian and Lebanese ID backs.
 */
function extractNatNumFromBarcodeText(barcodeText: string): string | undefined {
    const normalized = arabicIndicToWestern(barcodeText);
    const match = normalized.match(/\b\d{11}\b/);
    return match?.[0];
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify which side of the document we appear to be looking at, given a
 * handful of cheap signals derived from Textract / Rekognition output. Used
 * to reject the same-side-twice case (user shows the front during the back
 * step, or vice-versa).
 *
 * Passport photo pages have BOTH a face and an MRZ — we treat that as
 * `front` so passport flows aren't broken.
 */
export function classifySide(opts: {
    hasFace: boolean;
    hasMrz: boolean;
    hasAddress: boolean;
    hasDocumentNumber: boolean;
}): 'front' | 'back' | 'unknown' {
    if (opts.hasFace && opts.hasMrz) return 'front'; // passport photo page
    if (opts.hasFace) return 'front';
    if (opts.hasMrz) return 'back';
    if (opts.hasAddress) return 'back';
    if (opts.hasDocumentNumber) return 'back';
    return 'unknown';
}

/** True when the rawText contains an MRZ chevron run (`<<<<<` …). */
function hasMrzChevrons(rawText: string | undefined): boolean {
    if (!rawText) return false;
    return /<{5,}/.test(rawText);
}

const ID_DOC_PADDING = 0.08; // 8% pad around the unioned text bbox (well-formed IDs)
const ID_DOC_PADDING_LOPSIDED = 0.25; // moderate outward pad when text union is truly lopsided
const ID_DOC_MIN_AREA_RATIO = 0.15; // crops below this fraction → use union directly, not full frame
const ID_DOC_LOPSIDED_AREA_RATIO = 0.2; // text union below this fraction is treated as lopsided
const ID_DOC_MAX_DIMENSION_RATIO = 0.9; // padded box must not exceed this in width OR height
const ID_FACE_PADDING = 0.18; // 18% pad around the photo on the card
const SELFIE_FACE_PADDING = 0.25; // 25% pad around the live selfie face

// ─── Document validation thresholds ─────────────────────────────────────────
/** Minimum Textract confidence (0–100) for a field to count as successfully extracted. */
const FIELD_CONFIDENCE_THRESHOLD = 65;
/**
 * Front-side: ALL of the MANDATORY_FIELD_TYPES must pass the confidence check.
 * Applies to the Textract path AND every fallback parser (Syrian, Turkish, Lebanese).
 * Change this one constant to relax or tighten the rule everywhere.
 */
const MIN_MANDATORY_FIELDS_REQUIRED = 2;
/** Back-side: one mandatory field is sufficient (fewer structured fields are printed on backs). */
const MIN_MANDATORY_FIELDS_BACK = 0;
/**
 * Textract field types that identify a person on a government ID.
 * At least MIN_MANDATORY_FIELDS_REQUIRED must be extracted with
 * confidence ≥ FIELD_CONFIDENCE_THRESHOLD to accept the document.
 */
const MANDATORY_FIELD_TYPES = [
    'FIRST_NAME',
    'LAST_NAME',
    'DOCUMENT_NUMBER',
    'DATE_OF_BIRTH',
] as const;
/**
 * Sub-strings that, when found in the normalised ID_TYPE value, confirm the
 * document is a government-issued identity document.  Multi-word phrases are
 * used deliberately to reduce false-positives from short tokens.
 */
const VALID_ID_TYPE_KEYWORDS = [
    'driver',
    'driving',
    'passport',
    'national id',
    'national identity',
    'national identification',
    'identity card',
    'identification card',
    'id card',
    'residence permit',
    'resident card',
    'military id',
    'military card',
    'voter id',
    'voter card',
    'alien registration',
    'travel document',
] as const;

function stripDataUrlPrefix(base64: string): string {
    const idx = base64.indexOf(',');
    return idx >= 0 ? base64.slice(idx + 1) : base64;
}

function getField(fields: IdentityDocumentField[] | undefined, type: string): string | undefined {
    const match = fields?.find((f) => f.Type?.Text === type);
    return match?.ValueDetection?.Text || undefined;
}

function getFieldConfidence(fields: IdentityDocumentField[] | undefined, type: string): number {
    const match = fields?.find((f) => f.Type?.Text === type);
    return match?.ValueDetection?.Confidence ?? 0;
}

/**
 * Returns true when the normalised ID_TYPE value extracted by Textract
 * matches at least one known government-issued document type.  An exact
 * "id" or "passport" value is also accepted directly.
 */
function isAcceptableIdType(idTypeValue: string | undefined): boolean {
    if (!idTypeValue) return false;
    const normalized = idTypeValue.toLowerCase().trim();
    if (normalized === 'id' || normalized === 'passport') return true;
    return VALID_ID_TYPE_KEYWORDS.some((kw) => normalized.includes(kw));
}

/**
 * Union all WORD/LINE bounding boxes into a single rectangle that tightly
 * encloses the printed text on the card. AnalyzeID does not return a
 * document-level quadrilateral, so this is the most reliable proxy for the
 * card's footprint within the original frame.
 */
/**
 * Unions every block that carries a Geometry.BoundingBox — not just
 * WORD/LINE. On non-standard IDs Textract often emits other block types
 * (KEY_VALUE_SET, SELECTION_ELEMENT, TABLE, …); restricting to WORD/LINE
 * meant we missed half the card whenever text was lopsided.
 *
 * Pass `restrictToText` to recover the old strict behavior if needed.
 */
function unionTextBoxes(
    blocks: Block[] | undefined,
    restrictToText = false,
): NormalizedBox | undefined {
    if (!blocks?.length) return undefined;

    let minLeft = 1;
    let minTop = 1;
    let maxRight = 0;
    let maxBottom = 0;
    let any = false;

    for (const b of blocks) {
        if (restrictToText && b.BlockType !== 'WORD' && b.BlockType !== 'LINE') {
            continue;
        }
        // Skip the PAGE block — it's the whole image and would always pin
        // the union to (0,0)–(1,1).
        if (b.BlockType === 'PAGE') continue;

        const bb = b.Geometry?.BoundingBox;
        if (bb?.Left == null || bb?.Top == null || bb?.Width == null || bb?.Height == null) {
            continue;
        }
        any = true;
        minLeft = Math.min(minLeft, bb.Left);
        minTop = Math.min(minTop, bb.Top);
        maxRight = Math.max(maxRight, bb.Left + bb.Width);
        maxBottom = Math.max(maxBottom, bb.Top + bb.Height);
    }

    if (!any) return undefined;
    return {
        left: minLeft,
        top: minTop,
        width: maxRight - minLeft,
        height: maxBottom - minTop,
    };
}

function findPageBox(blocks: Block[] | undefined): NormalizedBox | undefined {
    const page = blocks?.find((b) => b.BlockType === 'PAGE');
    const bb = page?.Geometry?.BoundingBox;
    if (!bb || bb.Left == null || bb.Top == null || bb.Width == null || bb.Height == null) {
        return undefined;
    }
    return { left: bb.Left, top: bb.Top, width: bb.Width, height: bb.Height };
}

function boxArea(b: NormalizedBox): number {
    return Math.max(0, b.width) * Math.max(0, b.height);
}

/**
 * "Lopsided" = text union sits in one quadrant / one half of the frame and
 * therefore can't possibly enclose the whole card. We detect this when the
 * union area is small relative to the full frame, OR its center is far
 * from the frame center.
 */
function isLopsided(box: NormalizedBox): boolean {
    if (boxArea(box) < ID_DOC_LOPSIDED_AREA_RATIO) return true;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    return Math.abs(cx - 0.5) > 0.18 || Math.abs(cy - 0.5) > 0.22;
}

/** Pads a normalized box by `pad` (fraction of its own size) and clamps to [0,1]. */
function padAndClamp(box: NormalizedBox, pad: number): NormalizedBox {
    const padW = box.width * pad;
    const padH = box.height * pad;
    const left = Math.max(0, box.left - padW);
    const top = Math.max(0, box.top - padH);
    const right = Math.min(1, box.left + box.width + padW);
    const bottom = Math.min(1, box.top + box.height + padH);
    return {
        left,
        top,
        width: right - left,
        height: bottom - top,
    };
}

/** Converts a normalized box into integer pixel coordinates for sharp.extract. */
function toPixelExtract(
    box: NormalizedBox,
    imgWidth: number,
    imgHeight: number,
): { left: number; top: number; width: number; height: number } {
    const left = Math.max(0, Math.floor(box.left * imgWidth));
    const top = Math.max(0, Math.floor(box.top * imgHeight));
    const width = Math.max(1, Math.floor(box.width * imgWidth));
    const height = Math.max(1, Math.floor(box.height * imgHeight));
    return {
        left,
        top,
        width: Math.min(width, imgWidth - left),
        height: Math.min(height, imgHeight - top),
    };
}

async function cropToBase64Jpeg(
    sourceBytes: Buffer,
    box: NormalizedBox,
    imgWidth: number,
    imgHeight: number,
    quality = 90,
): Promise<{ buffer: Buffer; dataUrl: string }> {
    const extract = toPixelExtract(box, imgWidth, imgHeight);
    const buffer = cropToJpeg(sourceBytes, extract, quality);
    return {
        buffer,
        dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    };
}

function rekBoxToNormalized(b: RekBoundingBox | undefined): NormalizedBox | undefined {
    if (!b || b.Left == null || b.Top == null || b.Width == null || b.Height == null) {
        return undefined;
    }
    return { left: b.Left, top: b.Top, width: b.Width, height: b.Height };
}

/**
 * Detects the largest face in the given image bytes via Rekognition and
 * returns its normalized bounding box, or undefined if no face is found.
 */
async function detectLargestFaceBox(imageBytes: Buffer): Promise<NormalizedBox | undefined> {
    const out = await rekognitionClient.send(
        new DetectFacesCommand({
            Image: { Bytes: imageBytes },
            Attributes: ['DEFAULT'],
        }),
    );
    const faces = out.FaceDetails ?? [];
    if (faces.length === 0) return undefined;

    let best: NormalizedBox | undefined;
    let bestArea = 0;
    for (const f of faces) {
        const nb = rekBoxToNormalized(f.BoundingBox);
        if (!nb) continue;
        const area = nb.width * nb.height;
        if (area > bestArea) {
            bestArea = area;
            best = nb;
        }
    }
    return best;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phase D — Face matching (selfie ↔ ID-photo)
// ─────────────────────────────────────────────────────────────────────────────

export type FaceMatchVerdict = 'pass' | 'review' | 'fail';

export interface CompareFacesResult {
    isMatch: boolean;
    similarity: number;
    verdict: FaceMatchVerdict;
    /** Whether AWS detected a face on each side (helps debug 0-similarity). */
    sourceFaceDetected: boolean;
    targetFaceDetected: boolean;
    /** Number of unmatched faces in the target image. */
    unmatchedTargetFaces: number;
}

/** Hard-pass: auto-approve. */
export const FACE_MATCH_PASS_THRESHOLD = 90;
/** Soft-pass: manual review. Anything below this is a hard fail. */
export const FACE_MATCH_REVIEW_THRESHOLD = 85;
/** AWS Rekognition's filter floor — must be at most the lowest threshold. */
const FACE_MATCH_SIMILARITY_THRESHOLD = FACE_MATCH_REVIEW_THRESHOLD;

/**
 * Compares the photo cropped from an ID against a live selfie via
 * Rekognition CompareFaces. Both images should be tight crops produced
 * upstream (Phase A for the ID photo, Phase C for the selfie).
 *
 * Accepts raw base64 or data URLs.
 */
export async function compareFaces(
    idFaceBase64: string,
    liveFaceBase64: string,
    similarityThreshold: number = FACE_MATCH_SIMILARITY_THRESHOLD,
): Promise<CompareFacesResult> {
    const sourceBytes = Buffer.from(stripDataUrlPrefix(idFaceBase64), 'base64');
    const targetBytes = Buffer.from(stripDataUrlPrefix(liveFaceBase64), 'base64');

    const out = await rekognitionClient.send(
        new CompareFacesCommand({
            SourceImage: { Bytes: sourceBytes },
            TargetImage: { Bytes: targetBytes },
            SimilarityThreshold: similarityThreshold,
            QualityFilter: 'AUTO',
        }),
    );

    const matches = out.FaceMatches ?? [];
    const unmatched = out.UnmatchedFaces ?? [];

    // CompareFaces returns matches only for faces ≥ SimilarityThreshold.
    // Pick the strongest match if any.
    let bestSimilarity = 0;
    for (const m of matches) {
        const s = m.Similarity ?? 0;
        if (s > bestSimilarity) bestSimilarity = s;
    }

    const sourceFaceDetected = !!out.SourceImageFace;
    // No face on source → AWS throws InvalidParameterException, but we guard
    // anyway so the caller can return a clean error.
    const targetFaceDetected = matches.length + unmatched.length > 0;

    const verdict: FaceMatchVerdict =
        bestSimilarity >= FACE_MATCH_PASS_THRESHOLD
            ? 'pass'
            : bestSimilarity >= FACE_MATCH_REVIEW_THRESHOLD
              ? 'review'
              : 'fail';

    return {
        // `isMatch` stays true for both pass and review so the user isn't
        // dead-ended on a low-confidence-but-likely-correct match.
        isMatch: verdict !== 'fail',
        similarity: bestSimilarity,
        verdict,
        sourceFaceDetected,
        targetFaceDetected,
        unmatchedTargetFaces: unmatched.length,
    };
}

/**
 * Spec-aligned alias for `compareFaces`. Same contract, same threshold.
 * Kept so that callers reading the spec's `matchFaceToID(idFaceBase64,
 * liveFaceBase64)` shape import a method with that exact name.
 */
export const matchFaceToID = compareFaces;

// ─────────────────────────────────────────────────────────────────────────────
//  Phase C — Face liveness analysis
// ─────────────────────────────────────────────────────────────────────────────

export type LivenessChallenge = 'look_straight' | 'turn_right' | 'turn_left';

export interface FaceLivenessMetrics {
    /**
     * Rekognition convention:
     *   yaw  > 0  → head turned to the user's LEFT (camera-right)
     *   yaw  < 0  → head turned to the user's RIGHT (camera-left)
     *   pitch     → up/down
     *   roll      → tilt
     */
    yaw: number;
    pitch: number;
    roll: number;
    brightness: number;
    sharpness: number;
    eyesOpen: boolean;
    eyesOpenConfidence: number;
    sunglasses: boolean;
    boundingBox?: NormalizedBox;
    confidence: number;
}

export interface FaceLivenessResult {
    found: boolean;
    metrics?: FaceLivenessMetrics;
    /** Tight selfie crop centered on the detected face (when `crop: true`). */
    faceImageData?: string;
}

function pickLargestFace(faces: FaceDetail[]): FaceDetail | undefined {
    let best: FaceDetail | undefined;
    let bestArea = 0;
    for (const f of faces) {
        const bb = f.BoundingBox;
        const w = bb?.Width ?? 0;
        const h = bb?.Height ?? 0;
        const area = w * h;
        if (area > bestArea) {
            bestArea = area;
            best = f;
        }
    }
    return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID SPOOFING DETECTION  (DetectLabels)
// ─────────────────────────────────────────────────────────────────────────────

export interface IdSpoofingResult {
    /** true = appears to be a real physical document; false = spoofing detected */
    isReal: boolean;
    /** Machine-readable reason code when isReal is false */
    reason?: string;
    /** Human-readable message to show the user when isReal is false */
    message?: string;
    /** All labels returned by Rekognition (useful for debugging / threshold tuning) */
    detectedLabels?: { name: string; confidence: number; parents: string[] }[];
}

/**
 * Two-layer spoofing gate using AWS Rekognition DetectLabels:
 *
 * Layer 1 — Direct label match
 *   Any label in `rejectionLabels` with confidence ≥ `minConfidence` → reject.
 *
 * Layer 2 — Ancestor / parent match
 *   Rekognition returns a `Parents` chain for every label (e.g. "Smartphone" →
 *   parents: ["Mobile Phone", "Electronics", "Technology"]).
 *   If any ancestor name appears in `rejectionParentLabels` → reject.
 *   This catches labels like "Smartphone", "Laptop", "Display", "LED",
 *   "iMac", "MacBook" that share an electronic-device ancestor even when
 *   their exact names are not in the primary list.
 *
 * Always logs the full label list so you can tune thresholds from server logs.
 */
export async function detectIdSpoofing(imageBase64: string): Promise<IdSpoofingResult> {
    return runSpoofingGate(imageBase64, idConfig.spoofingDetection, 'detectIdSpoofing');
}

/**
 * Selfie counterpart of {@link detectIdSpoofing}. Runs the SAME Rekognition
 * DetectLabels gate on a live liveness frame to reject a "face" that is actually
 * being shown on another phone / monitor / tablet, or is a printed photo. This is
 * how the web liveness step rejects a presented (non-real) face WITHOUT the AWS
 * Amplify Face Liveness SDK — it reuses an API already in the stack.
 */
export async function detectFaceSpoofing(imageBase64: string): Promise<IdSpoofingResult> {
    return runSpoofingGate(imageBase64, faceConfig.spoofingDetection, 'detectFaceSpoofing');
}

/** Shared two-layer DetectLabels gate used by both the ID and selfie spoof checks. */
async function runSpoofingGate(
    imageBase64: string,
    cfg: {
        minConfidence: number;
        maxLabels: number;
        rejectionLabels: readonly string[];
        rejectionParentLabels: readonly string[];
        messages: Record<string, string>;
    },
    tag: string,
): Promise<IdSpoofingResult> {
    const cleaned = stripDataUrlPrefix(imageBase64);
    const sourceBytes = Buffer.from(cleaned, 'base64');

    const out = await rekognitionClient.send(
        new DetectLabelsCommand({
            Image: { Bytes: sourceBytes },
            MaxLabels: cfg.maxLabels,
            // Use a lower floor than minConfidence so we log everything useful
            // for debugging; the actual gate is applied per-label below.
            MinConfidence: cfg.minConfidence - 15,
            Settings: {
                GeneralLabels: {
                    LabelInclusionFilters: [],
                },
            },
        }),
    );

    // Flatten the full label + parent hierarchy for logging and matching.
    const labels = (out.Labels ?? []).map((l) => ({
        name: l.Name ?? '',
        confidence: l.Confidence ?? 0,
        parents: (l.Parents ?? []).map((p) => p.Name ?? ''),
    }));

    // Always log so operators can tune thresholds from server output.
    console.log(
        `[${tag}] labels:`,
        labels
            .map((l) => `${l.name}(${l.confidence.toFixed(0)}%)[${l.parents.join('>')}]`)
            .join(' | '),
    );

    const rejectionSet = new Set<string>(cfg.rejectionLabels as unknown as string[]);
    const ancestorSet = new Set<string>(cfg.rejectionParentLabels as unknown as string[]);

    for (const label of labels) {
        if (label.confidence < cfg.minConfidence) continue;

        // Layer 1: exact label name match
        const directHit = rejectionSet.has(label.name);

        // Layer 2: any ancestor in the parent-rejection set
        const ancestorHit = label.parents.some((p) => ancestorSet.has(p));

        if (directHit || ancestorHit) {
            const hitName = directHit ? label.name : label.parents.find((p) => ancestorSet.has(p))!;
            const message =
                (cfg.messages as Record<string, string>)[label.name] ??
                (cfg.messages as Record<string, string>)[hitName] ??
                cfg.messages.default;

            console.warn(
                `[${tag}] REJECTED — label="${label.name}" confidence=${label.confidence.toFixed(1)}% hit="${hitName}"`,
            );

            return {
                isReal: false,
                reason: `spoofing_detected:${label.name.toLowerCase().replace(/ /g, '_')}`,
                message,
                detectedLabels: labels,
            };
        }
    }

    return { isReal: true, detectedLabels: labels };
}

/**
 * Sends a base64 face frame to AWS Rekognition DetectFaces and returns the
 * pose, quality, and (optionally) a Sharp-cropped selfie. Used by the
 * frontend active-liveness state machine to validate each challenge step
 * (Look Straight → Turn Right → Turn Left).
 *
 * When `crop` is true and a face is found, the bounding box is padded and
 * `sharp.extract`ed to produce a tight selfie JPEG suitable for the
 * face-match step.
 */
export async function analyzeFaceLiveness(
    imageBase64: string,
    options: { crop?: boolean } = {},
): Promise<FaceLivenessResult> {
    const cleaned = stripDataUrlPrefix(imageBase64);
    const sourceBytes = Buffer.from(cleaned, 'base64');

    const out = await rekognitionClient.send(
        new DetectFacesCommand({
            Image: { Bytes: sourceBytes },
            Attributes: ['ALL'],
        }),
    );

    const faces = out.FaceDetails ?? [];
    if (faces.length === 0) {
        return { found: false };
    }

    const face = pickLargestFace(faces);
    if (!face) return { found: false };

    const metrics: FaceLivenessMetrics = {
        yaw: face.Pose?.Yaw ?? 0,
        pitch: face.Pose?.Pitch ?? 0,
        roll: face.Pose?.Roll ?? 0,
        brightness: face.Quality?.Brightness ?? 0,
        sharpness: face.Quality?.Sharpness ?? 0,
        eyesOpen: face.EyesOpen?.Value ?? false,
        eyesOpenConfidence: face.EyesOpen?.Confidence ?? 0,
        sunglasses: face.Sunglasses?.Value ?? false,
        boundingBox: rekBoxToNormalized(face.BoundingBox),
        confidence: face.Confidence ?? 0,
    };

    // Optional Sharp crop of the live selfie for the face-match step.
    let faceImageData: string | undefined;
    if (options.crop && metrics.boundingBox) {
        try {
            const meta = getImageSize(sourceBytes);
            const w = meta.width ?? 0;
            const h = meta.height ?? 0;
            if (w > 0 && h > 0) {
                const padded = padAndClamp(metrics.boundingBox, SELFIE_FACE_PADDING);
                const crop = await cropToBase64Jpeg(sourceBytes, padded, w, h);
                faceImageData = crop.dataUrl;
            }
        } catch (err) {
            console.warn('[realKycService] selfie crop failed:', err);
        }
    }

    return { found: true, metrics, faceImageData };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Raw-text harvesting (fallback for UNKNOWN / non-standard documents)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keywords we recognize on non-standard documents. The regex captures the
 * keyword itself so we can use it as the field label, and a separator
 * (`:` or whitespace) before the rest of the line as the value.
 *
 * Order matters: more-specific keys are listed first so e.g. "Date of Birth"
 * wins over "Date".
 */
const RAW_FIELD_KEYWORDS: Array<{ label: string; pattern: RegExp }> = [
    {
        label: 'Date of Birth',
        pattern: /\b(date\s*of\s*birth|d\.?o\.?b\.?|birth(?:day|date)?)\b[:\s\-]+(.+)/i,
    },
    {
        label: 'Expiration',
        pattern: /\b(expir(?:y|ation)|expires?|valid\s*until)\b[:\s\-]+(.+)/i,
    },
    {
        label: 'Issued',
        pattern: /\b(issue(?:d)?|issuance|date\s*of\s*issue)\b[:\s\-]+(.+)/i,
    },
    {
        label: 'Serial',
        pattern: /\b(serial(?:\s*(?:no|number))?)\b[:\s#\-]+(.+)/i,
    },
    { label: 'Price', pattern: /\b(price|amount|total)\b[:\s\-]+(.+)/i },
    {
        label: 'National Number',
        pattern: /\b(national\s*(?:id|no|number))\b[:\s\-]+(.+)/i,
    },
    {
        label: 'Document Number',
        pattern: /\b(doc(?:ument)?\s*(?:no|number)|document\s*#)\b[:\s\-]+(.+)/i,
    },
    {
        label: 'ID Number',
        pattern: /\b(id\s*(?:no|number|#)|identification\s*no)\b[:\s\-]+(.+)/i,
    },
    { label: 'Country', pattern: /\b(country|nationality)\b[:\s\-]+(.+)/i },
    { label: 'Name', pattern: /\b(full\s*name|name)\b[:\s\-]+(.+)/i },
    { label: 'Address', pattern: /\b(address|residence)\b[:\s\-]+(.+)/i },
    { label: 'Sex', pattern: /\b(sex|gender)\b[:\s\-]+(.+)/i },
    { label: 'Date', pattern: /\b(date)\b[:\s\-]+(.+)/i },
    { label: 'No.', pattern: /\b(no\.?|number|#)\b[:\s]+(.+)/i },
];

const DETECTED_FIELDS_LIMIT = 8; // cap how many we surface to the UI
const LONGEST_LINES_TOPN = 4; // additional anonymous lines beyond keyword matches

function collectLineTexts(blocks: Block[] | undefined): string[] {
    if (!blocks?.length) return [];
    const out: string[] = [];
    for (const b of blocks) {
        if (b.BlockType !== 'LINE') continue;
        const text = (b.Text ?? '').trim();
        if (!text) continue;
        out.push(text);
    }
    return out;
}

/**
 * Harvest a list of `{ label, value }` entries from raw Textract LINE
 * blocks. We first try keyword matches; for any line that doesn't match a
 * keyword, we keep the longest unique strings as anonymous "Detected"
 * fields. Returns at most DETECTED_FIELDS_LIMIT entries.
 */
function extractRawFields(blocks: Block[] | undefined): DetectedField[] {
    const lines = collectLineTexts(blocks);
    if (lines.length === 0) return [];

    const fields: DetectedField[] = [];
    const usedLines = new Set<string>();
    const usedLabels = new Set<string>();

    // 1) Keyword-matched lines.
    for (const line of lines) {
        if (fields.length >= DETECTED_FIELDS_LIMIT) break;

        for (const { label, pattern } of RAW_FIELD_KEYWORDS) {
            if (usedLabels.has(label)) continue;
            const match = line.match(pattern);
            if (!match) continue;
            const captured = (match[2] ?? match[1] ?? '').trim().replace(/[.\s]+$/, '');
            if (!captured) continue;
            fields.push({ label, value: captured });
            usedLabels.add(label);
            usedLines.add(line);
            break; // one label per line
        }
    }

    // 2) Top-N longest remaining lines as anonymous "Detected Text" entries.
    const remaining = lines
        .filter((l) => !usedLines.has(l))
        .sort((a, b) => b.length - a.length)
        .slice(0, LONGEST_LINES_TOPN);

    for (const line of remaining) {
        if (fields.length >= DETECTED_FIELDS_LIMIT) break;
        // Skip very short noise tokens.
        if (line.length < 4) continue;
        fields.push({ label: 'Detected Text', value: line });
    }

    return fields;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MRZ parser — ICAO 9303 TD3 (passport) name + country extraction
// ─────────────────────────────────────────────────────────────────────────────

interface MrzNames {
    firstName?: string;
    lastName?: string;
    country?: string;
}

/**
 * Parses ICAO 9303 TD3 passport MRZ lines from raw OCR text.
 * Line 1 format (44 chars): P<{ISO3}{SURNAME}<<{GIVEN}<<<<<...
 * Returns first/last name and issuing country.
 * Returns null if no TD3 MRZ line is found.
 */
function parseMrzNames(rawText: string): MrzNames | null {
    // Find a TD3 passport MRZ line 1: starts with P followed by < or letter, then 3-letter ISO
    const lines = rawText.split('\n').map((l) => l.trim());
    const mrzLine1 = lines.find((l) => /^P[<A-Z][A-Z]{3}[A-Z<]{39}$/.test(l));
    if (!mrzLine1) return null;

    const iso3 = mrzLine1.slice(2, 5);
    const nameField = mrzLine1.slice(5).replace(/</g, ' ').trim();
    // Double-space marks surname/given boundary (was `<<`)
    const parts = nameField.split(/\s{2,}/);
    const lastName = parts[0]?.replace(/\s+/g, ' ').trim() || undefined;
    const firstName = parts.slice(1).join(' ').replace(/\s+/g, ' ').trim() || undefined;

    // Map ISO-3 to full country name using the same dictionary as countryExtractor
    const ISO3_NAME: Record<string, string> = {
        TUR: 'Turkey',
        SYR: 'Syria',
        NLD: 'Netherlands',
        USA: 'United States',
        GBR: 'United Kingdom',
        DEU: 'Germany',
        FRA: 'France',
        ESP: 'Spain',
        ITA: 'Italy',
        SAU: 'Saudi Arabia',
        ARE: 'United Arab Emirates',
        EGY: 'Egypt',
        JOR: 'Jordan',
        LBN: 'Lebanon',
        IRQ: 'Iraq',
        IRN: 'Iran',
    };
    const country = ISO3_NAME[iso3] ?? iso3;

    return { firstName, lastName, country };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phase A — ID document analysis (existing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a base64 ID image to AWS Textract AnalyzeID and returns parsed fields,
 * a Sharp-cropped document image, and (front side, when detectable) a tight
 * crop of the photo printed on the card via Rekognition DetectFaces.
 *
 * Accepts raw base64 or data URL ("data:image/jpeg;base64,...").
 */
export async function analyzeIdDocument(
    imageBase64: string,
    side: 'front' | 'back' = 'front',
): Promise<AnalyzeIdDocumentResult> {
    const cleaned = stripDataUrlPrefix(imageBase64);
    const sourceBytes = Buffer.from(cleaned, 'base64');
    // Probe original dimensions once — we'll need them for every extract.
    const meta = getImageSize(sourceBytes);
    const imgWidth = meta.width ?? 0;
    const imgHeight = meta.height ?? 0;

    const command = new AnalyzeIDCommand({
        DocumentPages: [{ Bytes: sourceBytes }],
    });
    const response = await textractClient.send(command);

    const doc = response.IdentityDocuments?.[0];
    const fields = doc?.IdentityDocumentFields;

    // Collect any raw lines we can find — used both for sparse standard
    // results and as the sole source on UNKNOWN documents.
    const detectedFields = extractRawFields(doc?.Blocks);

    // Bail only if we have NO usable signal at all (no AnalyzeID fields
    // AND no raw text). A card with text but unknown type still yields
    // detectedFields, so we want to surface those.
    if ((!doc || !fields || fields.length === 0) && detectedFields.length === 0) {
        return { found: false, extracted: {}, reason: 'no_text_detected' };
    }

    // Collect all LINE texts for rawText — gives the consumer every word
    // Textract read from the card, including fields AnalyzeID doesn't model.
    const rawText = collectLineTexts(doc?.Blocks).join('\n') || undefined;

    // ── MRZ name override ────────────────────────────────────────────────────
    // When a passport MRZ is present, Textract's MIDDLE_NAME often captures
    // institutional text (e.g. "BAKANLIGI" from "T.C. ICISLERI BAKANLIGI")
    // which pollutes the full name. The MRZ is standardised (ICAO 9303) and
    // the most reliable source — always prefer it over Textract fields for
    // name when the document is a passport.
    // Document chrome that Textract (or a failed MRZ parse) sometimes returns as the
    // "name" — e.g. the literal word "PASSPORT" on a specimen page, or field labels.
    // Strip such tokens so a keyword never becomes the person's name; if nothing real
    // remains the name is left undefined (the summary screen lets the user correct it).
    const NON_NAME_KEYWORDS =
        /^(PASSPORT|REPUBLIC|IDENTITY|NATIONAL|CARD|SPECIMEN|TRAVEL|DOCUMENT|MINISTRY|INTERIOR|AUTHORITY|TYPE|CODE|SURNAME|GIVEN|NAMES?|NATIONALITY|SEX|MALE|FEMALE)$/i;
    const cleanName = (value: string | undefined): string | undefined => {
        if (!value) return undefined;
        const kept = value
            .trim()
            .split(/\s+/)
            .filter((w) => w.length >= 2 && !NON_NAME_KEYWORDS.test(w));
        const cleaned = kept.join(' ').trim();
        return cleaned.length >= 2 ? cleaned : undefined;
    };

    const mrzNames = rawText ? parseMrzNames(rawText) : null;
    const firstName = cleanName(mrzNames?.firstName ?? getField(fields, 'FIRST_NAME'));
    const lastName = cleanName(mrzNames?.lastName ?? getField(fields, 'LAST_NAME'));
    const fullName =
        cleanName(
            mrzNames
                ? [mrzNames.firstName, mrzNames.lastName].filter(Boolean).join(' ')
                : [
                      getField(fields, 'FIRST_NAME'),
                      getField(fields, 'MIDDLE_NAME'),
                      getField(fields, 'LAST_NAME'),
                  ]
                      .filter(Boolean)
                      .join(' '),
        ) || undefined;

    const expiryDate = getField(fields, 'EXPIRATION_DATE');

    // ── Country extraction ───────────────────────────────────────────────────
    // Textract's PLACE_OF_BIRTH often returns institutional phrases (e.g.
    // "BAKANLIGI" from "T.C. ICISLERI BAKANLIGI") rather than a real country.
    // Priority: (1) MRZ ISO-3 code, (2) extractCountry from rawText phrases,
    // (3) Textract COUNTY/PLACE_OF_BIRTH as last resort.
    let country: string | undefined;
    if (mrzNames?.country) {
        country = mrzNames.country;
        console.log(`[realKycService] country from MRZ: ${country}`);
    } else if (rawText) {
        const hit = extractCountry(rawText);
        if (hit) {
            country = hit.name;
            console.log(
                `[realKycService] country recovered from rawText via ${hit.via}: ${hit.name} (${hit.iso3})`,
            );
        }
    }
    if (!country) {
        country = getField(fields, 'COUNTY') || getField(fields, 'PLACE_OF_BIRTH');
    }

    const idTypeRaw = getField(fields, 'ID_TYPE');
    const isPassport = /passport/i.test(idTypeRaw ?? '');
    const docNumber = getField(fields, 'DOCUMENT_NUMBER');

    // Syrian (and many Arab) passports carry a letter-prefixed serial as the real
    // passport number — Syrian ones start with `N` (e.g. "N01234567"). AWS Textract
    // frequently mislabels the 11-digit NATIONAL number printed on the same page as
    // DOCUMENT_NUMBER. When this is a passport and Textract's value is empty or a bare
    // 11-digit national number, prefer a letter-prefixed serial found in the OCR text.
    const passportSerial = (() => {
        if (!isPassport || !rawText) return undefined;
        const normalized = rawText
            .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
            .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
        const m = normalized.match(/(?:^|[^A-Z0-9])([A-Z]\d{7,11})(?![A-Z0-9])/i);
        return m && m[1] ? m[1].toUpperCase() : undefined;
    })();
    const passportNumber = isPassport
        ? (!docNumber || /^\d{11}$/.test(docNumber)) && passportSerial
            ? passportSerial
            : docNumber
        : undefined;

    const standardExtracted = {
        idType: idTypeRaw,
        idName: idTypeRaw,
        country,
        name: fullName,
        firstName,
        lastName,
        nationalNumber: isPassport ? undefined : docNumber,
        documentNumber: isPassport ? passportNumber : docNumber,
        passportNumber,
        birthday: getField(fields, 'DATE_OF_BIRTH'),
        expirationDate: expiryDate,
        expiryDate,
        address: getField(fields, 'ADDRESS'),
        rawText,
    };

    // Only attach detectedFields when standard fields are sparse (UNKNOWN
    // documents typically have all-undefined or all-empty AnalyzeID values).
    // Threshold: ≤ 2 of the standard fields populated.
    const populatedStandard = Object.values(standardExtracted).filter(
        (v) => typeof v === 'string' && v.length > 0,
    ).length;
    const extracted = {
        ...standardExtracted,
        detectedFields:
            populatedStandard <= 2 && detectedFields.length > 0 ? detectedFields : undefined,
    };

    // ---- Security validation: reject non-government-ID documents ----------
    //
    // 1. ID_TYPE must be recognised as a government-issued document type.
    // 2. A minimum number of mandatory identity fields must be present
    //    with sufficient Textract confidence.
    //
    // This prevents advertisement cards, loyalty cards, receipts, etc. from
    // passing through as valid identity documents.
    //
    // Set BYPASS_STRICT_VALIDATION=true in .env.local to skip these checks
    // during local development so you can inspect crops on any test card.
    const bypassValidation = process.env.BYPASS_STRICT_VALIDATION === 'true';

    const idTypeValue = getField(fields, 'ID_TYPE');
    const hasValidIdType = isAcceptableIdType(idTypeValue);

    // Build a per-field confidence breakdown for debugging.
    const fieldScores = MANDATORY_FIELD_TYPES.map((ft) => ({
        field: ft,
        value: getField(fields, ft) ?? '(missing)',
        confidence: Math.round(getFieldConfidence(fields, ft)),
        pass:
            !!getField(fields, ft) && getFieldConfidence(fields, ft) >= FIELD_CONFIDENCE_THRESHOLD,
    }));
    const mandatoryFieldCount = fieldScores.filter((f) => f.pass).length;
    const requiredMandatoryFields =
        side === 'front' ? MIN_MANDATORY_FIELDS_REQUIRED : MIN_MANDATORY_FIELDS_BACK;

    console.log(
        `[realKycService] ── validation report (side=${side}) ──\n` +
            `  ID_TYPE  : "${idTypeValue ?? '(missing)'}"  →  ${hasValidIdType ? '✓ accepted' : '✗ rejected'}\n` +
            `  Mandatory fields (${mandatoryFieldCount}/${requiredMandatoryFields} required, threshold=${FIELD_CONFIDENCE_THRESHOLD}%):\n` +
            fieldScores
                .map(
                    (f) =>
                        `    ${f.pass ? '✓' : '✗'} ${f.field.padEnd(15)} value="${f.value}"  confidence=${f.confidence}%`,
                )
                .join('\n') +
            (bypassValidation ? '\n  ⚠ BYPASS_STRICT_VALIDATION=true — skipping rejection' : ''),
    );

    // 💡 إضافة: فحص سريع لسطور أمازون لنعرف إذا الهوية تركية أو عربية قبل ما نقبل بيانات أمازون الغبية
    const textractLines = collectLineTexts(doc?.Blocks);
    const isTurkish = looksLikeTurkishId(textractLines);
    const isSyrian = looksLikeSyrianId(textractLines);
    const isLebanese = looksLikeLebaneseId(textractLines);
    const forceFallback = isTurkish || isSyrian || isLebanese;

    if (
        !bypassValidation &&
        (!hasValidIdType || mandatoryFieldCount < requiredMandatoryFields || forceFallback)
    ) {
        console.log(
            `[realKycService] Fallback triggered (side=${side}, forceFallback=${forceFallback}) — running Rekognition`,
        );
        try {
            const detectTextOut = await rekognitionClient.send(
                new DetectTextCommand({ Image: { Bytes: sourceBytes } }),
            );
            const detectedLines = (detectTextOut.TextDetections ?? [])
                .filter((t) => t.Type === 'LINE')
                .map((t) => t.DetectedText ?? '')
                .filter(Boolean);
            const mergedLines = Array.from(new Set([...textractLines, ...detectedLines]));

            console.log(
                `[realKycService] Rekognition lines (${detectedLines.length}):\n  ${mergedLines.join('\n  ')}`,
            );

            // ── MRZ Passport rescue ──────────────────────────────────────────
            // If the merged OCR contains an MRZ, this is a passport. Textract
            // may have correctly identified PASSPORT but failed confidence on
            // low-res/rotated scans. Never let the Syrian/Turkish parsers claim
            // a document that has an MRZ — they will extract garbage.
            const mergedRawForMrz = mergedLines.join('\n');
            if (hasMrzChevrons(mergedRawForMrz)) {
                console.log(
                    `[realKycService] MRZ detected in Rekognition lines — using passport MRZ rescue`,
                );
                // Parse MRZ from merged lines to get authoritative name + country + DOB + docNo
                const mrzRescue = parseMrzNames(mergedRawForMrz);
                // Extract DOB from MRZ line 2: YYMMDD at position 13-18
                let mrzBirthday: string | undefined;
                let mrzDocNumber: string | undefined;
                const mrzLine2 = mergedLines.find((l) =>
                    /^[A-Z0-9<]{9}[0-9][A-Z]{3}[0-9]{6}[0-9][MF<][0-9]{6}[0-9][A-Z0-9<]{14}[0-9][0-9]$/.test(
                        l.replace(/\s/g, ''),
                    ),
                );
                if (mrzLine2) {
                    const m2 = mrzLine2.replace(/\s/g, '');
                    mrzDocNumber = m2.slice(0, 9).replace(/</g, '').trim() || undefined;
                    const dob = m2.slice(13, 19);
                    // YYMMDD → readable date
                    const yy = parseInt(dob.slice(0, 2), 10);
                    const mm = dob.slice(2, 4);
                    const dd = dob.slice(4, 6);
                    const year = yy <= 30 ? 2000 + yy : 1900 + yy;
                    mrzBirthday = `${dd}.${mm}.${year}`;
                }

                // Prefer Textract fields (already extracted above as standardExtracted)
                // but fill gaps with MRZ values.
                const rescueName = mrzRescue
                    ? [mrzRescue.firstName, mrzRescue.lastName].filter(Boolean).join(' ')
                    : undefined;

                const rescueCrop = await (async () => {
                    const lineBoxes = (detectTextOut.TextDetections ?? [])
                        .filter((t) => t.Type === 'LINE')
                        .map((t) => t.Geometry?.BoundingBox)
                        .filter(
                            (b): b is RekBoundingBox =>
                                !!b &&
                                b.Left != null &&
                                b.Top != null &&
                                b.Width != null &&
                                b.Height != null,
                        );
                    if (lineBoxes.length === 0 || imgWidth === 0 || imgHeight === 0)
                        return undefined;
                    let minLeft = 1,
                        minTop = 1,
                        maxRight = 0,
                        maxBottom = 0;
                    for (const b of lineBoxes) {
                        minLeft = Math.min(minLeft, b.Left!);
                        minTop = Math.min(minTop, b.Top!);
                        maxRight = Math.max(maxRight, b.Left! + b.Width!);
                        maxBottom = Math.max(maxBottom, b.Top! + b.Height!);
                    }
                    const union: NormalizedBox = {
                        left: minLeft,
                        top: minTop,
                        width: maxRight - minLeft,
                        height: maxBottom - minTop,
                    };
                    const docBox = padAndClamp(union, ID_DOC_PADDING);
                    try {
                        const c = await cropToBase64Jpeg(sourceBytes, docBox, imgWidth, imgHeight);
                        return { dataUrl: c.dataUrl, box: docBox };
                    } catch {
                        return undefined;
                    }
                })();

                return {
                    found: true,
                    extracted: {
                        idType: 'PASSPORT',
                        country: mrzRescue?.country ?? standardExtracted.country,
                        name: rescueName ?? standardExtracted.name,
                        firstName: mrzRescue?.firstName ?? standardExtracted.firstName,
                        lastName: mrzRescue?.lastName ?? standardExtracted.lastName,
                        nationalNumber: undefined,
                        documentNumber: mrzDocNumber ?? standardExtracted.documentNumber,
                        passportNumber: mrzDocNumber ?? standardExtracted.documentNumber,
                        birthday: mrzBirthday ?? standardExtracted.birthday,
                        expirationDate: standardExtracted.expirationDate,
                        expiryDate: standardExtracted.expiryDate,
                        rawText: mergedRawForMrz,
                    },
                    croppedImageData: rescueCrop?.dataUrl,
                    documentBox: rescueCrop?.box,
                };
            }
            if (looksLikeTurkishId(mergedLines)) {
                // ── Turkish-ID fallback ──────────────────────────────────
                // Textract misclassifies TR national IDs as `DRIVER LICENSE
                // FRONT` and OCRs the printed labels (`TÜRKİYE`, `Soyadı`)
                // into name fields. Reuse the Syrian-fallback machinery
                // (Rekognition LINE boxes → union → sharp.extract) since we
                // already have it computed.
                const parsed = parseTurkishId(mergedLines);
                console.log('[realKycService] Turkish parser output:', parsed);

                const recoveredFront = [
                    parsed.firstName ?? parsed.lastName,
                    parsed.birthday,
                    parsed.nationalNumber,
                ].filter(Boolean).length;
                const acceptable =
                    side === 'front' ? recoveredFront >= MIN_MANDATORY_FIELDS_REQUIRED : true;

                if (acceptable) {
                    console.log(
                        `[realKycService] Turkish-ID fallback recovered ${parsed.recovered}/7 fields (side=${side})`,
                    );

                    let fbCroppedImageData: string | undefined;
                    let fbCroppedBuffer: Buffer | undefined;
                    let fbDocumentBox: NormalizedBox | undefined;
                    if (imgWidth > 0 && imgHeight > 0) {
                        const lineBoxes = (detectTextOut.TextDetections ?? [])
                            .filter((t) => t.Type === 'LINE')
                            .map((t) => t.Geometry?.BoundingBox)
                            .filter(
                                (b): b is RekBoundingBox =>
                                    !!b &&
                                    b.Left != null &&
                                    b.Top != null &&
                                    b.Width != null &&
                                    b.Height != null,
                            );
                        if (lineBoxes.length > 0) {
                            let minLeft = 1,
                                minTop = 1,
                                maxRight = 0,
                                maxBottom = 0;
                            for (const b of lineBoxes) {
                                minLeft = Math.min(minLeft, b.Left!);
                                minTop = Math.min(minTop, b.Top!);
                                maxRight = Math.max(maxRight, b.Left! + b.Width!);
                                maxBottom = Math.max(maxBottom, b.Top! + b.Height!);
                            }
                            const union: NormalizedBox = {
                                left: minLeft,
                                top: minTop,
                                width: maxRight - minLeft,
                                height: maxBottom - minTop,
                            };
                            const lopsided = isLopsided(union);
                            const pad = lopsided ? ID_DOC_PADDING_LOPSIDED : ID_DOC_PADDING;
                            fbDocumentBox = padAndClamp(union, pad);
                            if (
                                lopsided &&
                                (fbDocumentBox.width > ID_DOC_MAX_DIMENSION_RATIO ||
                                    fbDocumentBox.height > ID_DOC_MAX_DIMENSION_RATIO)
                            ) {
                                fbDocumentBox = padAndClamp(union, ID_DOC_PADDING);
                            }
                            try {
                                const crop = await cropToBase64Jpeg(
                                    sourceBytes,
                                    fbDocumentBox,
                                    imgWidth,
                                    imgHeight,
                                );
                                fbCroppedImageData = crop.dataUrl;
                                fbCroppedBuffer = crop.buffer;
                            } catch (err) {
                                console.warn(
                                    '[realKycService] Turkish-fallback document crop failed:',
                                    err,
                                );
                            }
                        }
                    }

                    let fbIdFaceImageData: string | undefined;
                    let fbIdFaceBox: NormalizedBox | undefined;
                    let fbHasFace = false;
                    if (fbCroppedBuffer) {
                        try {
                            const faceBoxOnCrop = await detectLargestFaceBox(fbCroppedBuffer);
                            if (faceBoxOnCrop) {
                                fbHasFace = true;
                                // Only crop the face image when scanning the front (needed for face-match)
                                if (side === 'front') {
                                    fbIdFaceBox = padAndClamp(faceBoxOnCrop, ID_FACE_PADDING);
                                    const cropMeta = getImageSize(fbCroppedBuffer);
                                    const cw = cropMeta.width ?? 0;
                                    const ch = cropMeta.height ?? 0;
                                    if (cw > 0 && ch > 0) {
                                        const faceCrop = await cropToBase64Jpeg(
                                            fbCroppedBuffer,
                                            fbIdFaceBox,
                                            cw,
                                            ch,
                                        );
                                        fbIdFaceImageData = faceCrop.dataUrl;
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn(
                                '[realKycService] Turkish-fallback face crop failed:',
                                err,
                            );
                        }
                    }

                    // Side-discrimination signals from the merged OCR.
                    const mergedRaw = mergedLines.join('\n');
                    const detectedSide = classifySide({
                        hasFace: fbHasFace,
                        hasMrz: hasMrzChevrons(mergedRaw),
                        hasAddress: false,
                        hasDocumentNumber: !!parsed.documentNumber,
                    });
                    if (detectedSide !== 'unknown' && detectedSide !== side) {
                        console.log(
                            `[realKycService] Turkish-ID wrong_side: requested=${side} detected=${detectedSide}`,
                        );
                        return { found: false, extracted: {}, reason: 'wrong_side' };
                    }

                    const extractedForSide =
                        side === 'front'
                            ? {
                                  idType: 'turkish_national_id',
                                  idName: 'Turkish National ID',
                                  country: 'Turkey',
                                  name: parsed.name,
                                  firstName: parsed.firstName,
                                  lastName: parsed.lastName,
                                  nationalNumber: parsed.nationalNumber,
                                  documentNumber: parsed.documentNumber ?? parsed.nationalNumber,
                                  birthday: parsed.birthday,
                                  expirationDate: parsed.expiryDate,
                                  expiryDate: parsed.expiryDate,
                                  rawText: mergedRaw || undefined,
                              }
                            : {
                                  idType: 'turkish_national_id',
                                  idName: 'Turkish National ID',
                                  country: 'Turkey',
                                  rawText: mergedRaw || undefined,
                              };

                    return {
                        found: true,
                        extracted: extractedForSide,
                        croppedImageData: fbCroppedImageData,
                        idFaceImageData: fbIdFaceImageData,
                        documentBox: fbDocumentBox,
                        idFaceBox: fbIdFaceBox,
                    };
                }
                console.log(
                    `[realKycService] Turkish-ID heuristic matched but front-side parser only found ${recoveredFront}/3 fields (need 2) — rejecting`,
                );
            } else if (looksLikeSyrianId(mergedLines)) {
                const parsed = parseSyrianId(mergedLines);
                if (parsed.name) {
                    parsed.name = await translateNameIfArabic(parsed.name);
                }
                console.log('[realKycService] Syrian parser output:', parsed);

                // Front side: require ≥2 of 3 (national number, name, dob)
                // — those are the legally meaningful identity fields.
                // Back side: the heuristic match alone is enough. Syrian-ID
                // backs only have a registration number, issue date, and a
                // barcode — no name/national-number/birthday — so we never
                // try to fabricate those from the back. Accept and pass back
                // an empty extracted record (the front already populated the
                // structured fields earlier in the flow).
                const recovered = [parsed.nationalNumber, parsed.name, parsed.birthday].filter(
                    Boolean,
                ).length;
                const acceptable = side === 'front' ? recovered >= 2 : true;

                if (acceptable) {
                    console.log(
                        `[realKycService] Syrian-ID fallback recovered ${recovered}/3 fields (side=${side})`,
                    );

                    // Build a document crop using Rekognition's per-line
                    // bounding boxes — Textract gave us no geometry, but
                    // DetectText returns Geometry.BoundingBox for every
                    // detection. Union LINE boxes → pad → sharp.extract.
                    let fbCroppedImageData: string | undefined;
                    let fbCroppedBuffer: Buffer | undefined;
                    let fbDocumentBox: NormalizedBox | undefined;
                    if (imgWidth > 0 && imgHeight > 0) {
                        const lineBoxes = (detectTextOut.TextDetections ?? [])
                            .filter((t) => t.Type === 'LINE')
                            .map((t) => t.Geometry?.BoundingBox)
                            .filter(
                                (b): b is RekBoundingBox =>
                                    !!b &&
                                    b.Left != null &&
                                    b.Top != null &&
                                    b.Width != null &&
                                    b.Height != null,
                            );

                        if (lineBoxes.length > 0) {
                            let minLeft = 1,
                                minTop = 1,
                                maxRight = 0,
                                maxBottom = 0;
                            for (const b of lineBoxes) {
                                minLeft = Math.min(minLeft, b.Left!);
                                minTop = Math.min(minTop, b.Top!);
                                maxRight = Math.max(maxRight, b.Left! + b.Width!);
                                maxBottom = Math.max(maxBottom, b.Top! + b.Height!);
                            }
                            const union: NormalizedBox = {
                                left: minLeft,
                                top: minTop,
                                width: maxRight - minLeft,
                                height: maxBottom - minTop,
                            };
                            const lopsided = isLopsided(union);
                            const pad = lopsided ? ID_DOC_PADDING_LOPSIDED : ID_DOC_PADDING;
                            fbDocumentBox = padAndClamp(union, pad);
                            if (
                                lopsided &&
                                (fbDocumentBox.width > ID_DOC_MAX_DIMENSION_RATIO ||
                                    fbDocumentBox.height > ID_DOC_MAX_DIMENSION_RATIO)
                            ) {
                                fbDocumentBox = padAndClamp(union, ID_DOC_PADDING);
                            }
                            try {
                                const crop = await cropToBase64Jpeg(
                                    sourceBytes,
                                    fbDocumentBox,
                                    imgWidth,
                                    imgHeight,
                                );
                                fbCroppedImageData = crop.dataUrl;
                                fbCroppedBuffer = crop.buffer;
                            } catch (err) {
                                console.warn(
                                    '[realKycService] Syrian-fallback document crop failed:',
                                    err,
                                );
                            }
                        }
                    }

                    // Detect face presence for side classification; only crop the image on front.
                    let fbIdFaceImageData: string | undefined;
                    let fbIdFaceBox: NormalizedBox | undefined;
                    let fbHasFace = false;
                    if (fbCroppedBuffer) {
                        try {
                            const faceBoxOnCrop = await detectLargestFaceBox(fbCroppedBuffer);
                            if (faceBoxOnCrop) {
                                fbHasFace = true;
                                if (side === 'front') {
                                    fbIdFaceBox = padAndClamp(faceBoxOnCrop, ID_FACE_PADDING);
                                    const cropMeta = getImageSize(fbCroppedBuffer);
                                    const cw = cropMeta.width ?? 0;
                                    const ch = cropMeta.height ?? 0;
                                    if (cw > 0 && ch > 0) {
                                        const faceCrop = await cropToBase64Jpeg(
                                            fbCroppedBuffer,
                                            fbIdFaceBox,
                                            cw,
                                            ch,
                                        );
                                        fbIdFaceImageData = faceCrop.dataUrl;
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('[realKycService] Syrian-fallback face crop failed:', err);
                        }
                    }

                    // Side-discrimination signals from the merged OCR.
                    const mergedRawSyr = mergedLines.join('\n');
                    const detectedSide = classifySide({
                        // On Syrian IDs, the back can include a small portrait,
                        // so only trust face presence as a front-side signal.
                        hasFace: side === 'front' ? fbHasFace : false,
                        hasMrz: hasMrzChevrons(mergedRawSyr),
                        hasAddress: false,
                        hasDocumentNumber: !!parsed.nationalNumber,
                    });
                    if (detectedSide !== 'unknown' && detectedSide !== side) {
                        console.log(
                            `[realKycService] Syrian-ID wrong_side: requested=${side} detected=${detectedSide}`,
                        );
                        return { found: false, extracted: {}, reason: 'wrong_side' };
                    }

                    // On the back side don't surface name/dob/nationalNumber
                    // from OCR — those belong to the front side.
                    // However, decode the PDF417 barcode on the Syrian back
                    // to extract the nationalNumber for cross-side verification.
                    let syrianBackNatNum: string | undefined;
                    if (side === 'back' && fbCroppedBuffer) {
                        const barcodeText = await decodeBarcodeFromBuffer(fbCroppedBuffer);
                        if (barcodeText) {
                            syrianBackNatNum = extractNatNumFromBarcodeText(barcodeText);
                            const syrMatch =
                                syrianBackNatNum && parsed.nationalNumber
                                    ? syrianBackNatNum === parsed.nationalNumber
                                        ? '✓ exact'
                                        : '✗ differ (edit dist checked in verifier)'
                                    : '— cannot compare';
                            console.log(
                                '[realKycService] ── Syrian back barcode ──────────────────────\n' +
                                    '  raw text      : ' +
                                    barcodeText +
                                    '\n' +
                                    '  nationalNumber : ' +
                                    (syrianBackNatNum ?? '(not found)') +
                                    '\n' +
                                    '  front natNum   : ' +
                                    (parsed.nationalNumber ?? '(not on front)') +
                                    '\n' +
                                    '  match          : ' +
                                    syrMatch,
                            );
                        } else {
                            console.log('[realKycService] Syrian back barcode: no barcode decoded');
                        }
                    }

                    const extractedForSide =
                        side === 'front'
                            ? {
                                  idType: 'syrian_national_id',
                                  idName: 'Syrian National ID',
                                  country: 'Syria',
                                  name: parsed.name,
                                  nationalNumber: parsed.nationalNumber,
                                  documentNumber: parsed.nationalNumber,
                                  birthday: parsed.birthday,
                                  rawText: mergedRawSyr || undefined,
                              }
                            : {
                                  idType: 'syrian_national_id',
                                  idName: 'Syrian National ID',
                                  country: 'Syria',
                                  nationalNumber: syrianBackNatNum, // from barcode — used by backSideVerifier
                                  rawText: mergedRawSyr || undefined,
                              };

                    return {
                        found: true,
                        extracted: extractedForSide,
                        croppedImageData: fbCroppedImageData,
                        idFaceImageData: fbIdFaceImageData,
                        documentBox: fbDocumentBox,
                        idFaceBox: fbIdFaceBox,
                    };
                }
                console.log(
                    `[realKycService] Syrian-ID heuristic matched but front-side parser only found ${recovered}/3 fields (need 2) — rejecting`,
                );
            } else if (looksLikeLebaneseId(mergedLines)) {
                // ── Lebanese-ID fallback ─────────────────────────────────
                const parsed = parseLebaneseId(mergedLines);
                if (parsed.firstName)
                    parsed.firstName = await translateNameIfArabic(parsed.firstName);
                if (parsed.lastName) parsed.lastName = await translateNameIfArabic(parsed.lastName);
                if (parsed.name) parsed.name = await translateNameIfArabic(parsed.name);
                console.log('[realKycService] Lebanese parser output:', parsed);

                const recoveredLb = [
                    parsed.firstName ?? parsed.lastName,
                    parsed.birthday,
                    parsed.nationalNumber,
                ].filter(Boolean).length;
                const acceptable =
                    side === 'front' ? recoveredLb >= MIN_MANDATORY_FIELDS_REQUIRED : true;

                if (acceptable) {
                    console.log(
                        `[realKycService] Lebanese-ID fallback recovered ${recoveredLb}/3 fields (side=${side})`,
                    );

                    // ── Crop document from Rekognition LINE boxes ────────
                    let fbCroppedImageData: string | undefined;
                    let fbCroppedBuffer: Buffer | undefined;
                    let fbDocumentBox: NormalizedBox | undefined;
                    if (imgWidth > 0 && imgHeight > 0) {
                        const lineBoxes = (detectTextOut.TextDetections ?? [])
                            .filter((t) => t.Type === 'LINE')
                            .map((t) => t.Geometry?.BoundingBox)
                            .filter(
                                (b): b is RekBoundingBox =>
                                    !!b &&
                                    b.Left != null &&
                                    b.Top != null &&
                                    b.Width != null &&
                                    b.Height != null,
                            );
                        if (lineBoxes.length > 0) {
                            let minLeft = 1,
                                minTop = 1,
                                maxRight = 0,
                                maxBottom = 0;
                            for (const b of lineBoxes) {
                                minLeft = Math.min(minLeft, b.Left!);
                                minTop = Math.min(minTop, b.Top!);
                                maxRight = Math.max(maxRight, b.Left! + b.Width!);
                                maxBottom = Math.max(maxBottom, b.Top! + b.Height!);
                            }
                            const union: NormalizedBox = {
                                left: minLeft,
                                top: minTop,
                                width: maxRight - minLeft,
                                height: maxBottom - minTop,
                            };
                            const lopsided = isLopsided(union);
                            fbDocumentBox = padAndClamp(
                                union,
                                lopsided ? ID_DOC_PADDING_LOPSIDED : ID_DOC_PADDING,
                            );
                            if (
                                lopsided &&
                                (fbDocumentBox.width > ID_DOC_MAX_DIMENSION_RATIO ||
                                    fbDocumentBox.height > ID_DOC_MAX_DIMENSION_RATIO)
                            ) {
                                fbDocumentBox = padAndClamp(union, ID_DOC_PADDING);
                            }
                            try {
                                const crop = await cropToBase64Jpeg(
                                    sourceBytes,
                                    fbDocumentBox,
                                    imgWidth,
                                    imgHeight,
                                );
                                fbCroppedImageData = crop.dataUrl;
                                fbCroppedBuffer = crop.buffer;
                            } catch (err) {
                                console.warn(
                                    '[realKycService] Lebanese-fallback document crop failed:',
                                    err,
                                );
                            }
                        }
                    }

                    // ── Face crop (front only) ────────────────────────────
                    let fbIdFaceImageData: string | undefined;
                    let fbIdFaceBox: NormalizedBox | undefined;
                    let fbHasFace = false;
                    if (fbCroppedBuffer) {
                        try {
                            const faceBoxOnCrop = await detectLargestFaceBox(fbCroppedBuffer);
                            if (faceBoxOnCrop) {
                                fbHasFace = true;
                                if (side === 'front') {
                                    fbIdFaceBox = padAndClamp(faceBoxOnCrop, ID_FACE_PADDING);
                                    const cropMeta = getImageSize(fbCroppedBuffer);
                                    const cw = cropMeta.width ?? 0,
                                        ch = cropMeta.height ?? 0;
                                    if (cw > 0 && ch > 0) {
                                        const faceCrop = await cropToBase64Jpeg(
                                            fbCroppedBuffer,
                                            fbIdFaceBox,
                                            cw,
                                            ch,
                                        );
                                        fbIdFaceImageData = faceCrop.dataUrl;
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn(
                                '[realKycService] Lebanese-fallback face crop failed:',
                                err,
                            );
                        }
                    }

                    // ── Barcode decode on back (PDF417 contains national number) ─
                    let lbBackNatNum: string | undefined;
                    if (side === 'back' && fbCroppedBuffer) {
                        const barcodeText = await decodeBarcodeFromBuffer(fbCroppedBuffer);
                        if (barcodeText) {
                            lbBackNatNum = extractNatNumFromBarcodeText(barcodeText);
                            const lbMatch =
                                lbBackNatNum && parsed.nationalNumber
                                    ? lbBackNatNum === parsed.nationalNumber
                                        ? '✓ exact'
                                        : '✗ differ (edit dist checked in verifier)'
                                    : '— cannot compare';
                            console.log(
                                '[realKycService] ── Lebanese back barcode ─────────────────────\n' +
                                    '  raw text      : ' +
                                    barcodeText +
                                    '\n' +
                                    '  nationalNumber : ' +
                                    (lbBackNatNum ?? '(not found)') +
                                    '\n' +
                                    '  front natNum   : ' +
                                    (parsed.nationalNumber ?? '(not on front)') +
                                    '\n' +
                                    '  match          : ' +
                                    lbMatch,
                            );
                        } else {
                            console.log(
                                '[realKycService] Lebanese back barcode: no barcode decoded',
                            );
                        }
                    }

                    // ── Side classifier ───────────────────────────────────
                    const mergedRawLb = mergedLines.join('\n');
                    const detectedSide = classifySide({
                        hasFace: fbHasFace,
                        hasMrz: hasMrzChevrons(mergedRawLb),
                        hasAddress: false,
                        hasDocumentNumber: !!parsed.nationalNumber,
                    });
                    if (detectedSide !== 'unknown' && detectedSide !== side) {
                        console.log(
                            `[realKycService] Lebanese-ID wrong_side: requested=${side} detected=${detectedSide}`,
                        );
                        return { found: false, extracted: {}, reason: 'wrong_side' };
                    }

                    const extractedForSide =
                        side === 'front'
                            ? {
                                  idType: 'lebanese_national_id',
                                  idName: 'Lebanese National ID',
                                  country: 'Lebanon',
                                  name: parsed.name,
                                  firstName: parsed.firstName,
                                  lastName: parsed.lastName,
                                  nationalNumber: parsed.nationalNumber,
                                  documentNumber: parsed.nationalNumber,
                                  birthday: parsed.birthday,
                                  rawText: mergedRawLb || undefined,
                              }
                            : {
                                  idType: 'lebanese_national_id',
                                  idName: 'Lebanese National ID',
                                  country: 'Lebanon',
                                  nationalNumber: lbBackNatNum,
                                  rawText: mergedRawLb || undefined,
                              };

                    return {
                        found: true,
                        extracted: extractedForSide,
                        croppedImageData: fbCroppedImageData,
                        idFaceImageData: fbIdFaceImageData,
                        documentBox: fbDocumentBox,
                        idFaceBox: fbIdFaceBox,
                    };
                }
                console.log(
                    `[realKycService] Lebanese-ID heuristic matched but only recovered ${recoveredLb}/3 fields (need 2) — rejecting`,
                );
            } else {
                console.log(
                    `[realKycService] Rekognition returned ${detectedLines.length} lines but they don't look Syrian, Turkish, or Lebanese — proceeding with rejection`,
                );
            }
        } catch (err) {
            console.warn('[realKycService] Rekognition DetectText fallback failed:', err);
        }
        const reason = !hasValidIdType ? 'invalid_id_type' : 'insufficient_fields';
        return { found: false, extracted: {}, reason };
    }

    // ---- Phase A.1: Sharp-crop the ID using a tiered fallback strategy --
    //
    //   1. Union ALL geometry-bearing blocks (not just WORD/LINE).
    //   2. If the union is truly lopsided (area below ID_DOC_LOPSIDED_AREA_RATIO
    //      or center far from frame centre), apply moderate outward padding.
    //      A safety cap (ID_DOC_MAX_DIMENSION_RATIO) prevents the padded box
    //      from ballooning to near-full-frame width or height — which was the
    //      root cause of documentBox.width = 1 for IDs close to a frame edge.
    //      When the cap triggers, the normal (tighter) padding is used instead.
    //   3. If the crop area is still below ID_DOC_MIN_AREA_RATIO, use the
    //      raw union with minimal padding rather than returning the full frame.
    //   4. Only fall back to the full frame ({width:1}) when Textract returned
    //      absolutely no usable block geometry.
    let croppedImageData: string | undefined;
    let croppedBuffer: Buffer | undefined;
    let documentBox: NormalizedBox | undefined;
    let usedRawFallback = false;

    if (imgWidth > 0 && imgHeight > 0) {
        const fullUnion = unionTextBoxes(doc?.Blocks, false);
        const candidate = fullUnion ?? findPageBox(doc?.Blocks);

        if (candidate) {
            const lopsided = isLopsided(candidate);
            const pad = lopsided ? ID_DOC_PADDING_LOPSIDED : ID_DOC_PADDING;
            documentBox = padAndClamp(candidate, pad);

            // Safety cap: when lopsided padding over-expands either dimension
            // to near-full-frame size (ID close to a frame edge), fall back
            // to the normal, tighter padding to preserve a useful crop.
            if (
                lopsided &&
                (documentBox.width > ID_DOC_MAX_DIMENSION_RATIO ||
                    documentBox.height > ID_DOC_MAX_DIMENSION_RATIO)
            ) {
                documentBox = padAndClamp(candidate, ID_DOC_PADDING);
            }

            // If the crop area is still too small, prefer the raw union with
            // minimal padding over returning the entire frame.
            if (boxArea(documentBox) < ID_DOC_MIN_AREA_RATIO) {
                const minimal = padAndClamp(candidate, 0.02);
                documentBox = boxArea(minimal) >= ID_DOC_MIN_AREA_RATIO ? minimal : candidate;
                if (boxArea(documentBox) < ID_DOC_MIN_AREA_RATIO) {
                    // Union itself is too small to be useful — full frame fallback.
                    documentBox = { left: 0, top: 0, width: 1, height: 1 };
                    usedRawFallback = true;
                }
            }
        } else {
            // Nothing usable from Textract — return the raw frame as-is.
            documentBox = { left: 0, top: 0, width: 1, height: 1 };
            usedRawFallback = true;
        }

        try {
            const crop = await cropToBase64Jpeg(sourceBytes, documentBox, imgWidth, imgHeight);
            croppedImageData = crop.dataUrl;
            croppedBuffer = crop.buffer;
        } catch (err) {
            console.warn('[realKycService] document crop failed:', err);
        }

        if (usedRawFallback) {
            console.info(
                '[realKycService] using raw frame as document crop — Textract geometry was missing or too tight',
            );
        }
    }

    // ---- Phase A.2: Run Rekognition on the cropped ID, then crop the face ----
    // Detect on BOTH sides — face presence is the strongest signal for the
    // side classifier below. On front we additionally crop the photo for the
    // downstream face-match step.
    let idFaceImageData: string | undefined;
    let idFaceBox: NormalizedBox | undefined;
    let faceBoxOnCrop: NormalizedBox | undefined;

    if (croppedBuffer) {
        try {
            faceBoxOnCrop = await detectLargestFaceBox(croppedBuffer);
            if (faceBoxOnCrop && side === 'front') {
                idFaceBox = padAndClamp(faceBoxOnCrop, ID_FACE_PADDING);
                const cropMeta = getImageSize(croppedBuffer);
                const cw = cropMeta.width ?? 0;
                const ch = cropMeta.height ?? 0;
                if (cw > 0 && ch > 0) {
                    const faceCrop = await cropToBase64Jpeg(croppedBuffer, idFaceBox, cw, ch);
                    idFaceImageData = faceCrop.dataUrl;
                }
            }
        } catch (err) {
            console.warn('[realKycService] ID-face detection/crop failed:', err);
        }
    }

    // ---- Phase A.2 fallback: run DetectFaces on the full original frame -----
    // If the document crop was too tight, rotated, or the face landed outside
    // the crop bounds, retry on the raw source image.  We still only do this
    // for the front side (passports / national IDs always have the photo on
    // the front).
    if (!idFaceImageData && side === 'front') {
        try {
            console.info(
                '[realKycService] idFaceImageData missing after crop — retrying DetectFaces on original frame',
            );
            const fallbackFaceBox = await detectLargestFaceBox(sourceBytes);
            if (fallbackFaceBox) {
                faceBoxOnCrop = fallbackFaceBox; // update for side-classifier
                idFaceBox = padAndClamp(fallbackFaceBox, ID_FACE_PADDING);
                const faceCrop = await cropToBase64Jpeg(
                    sourceBytes,
                    idFaceBox,
                    imgWidth,
                    imgHeight,
                );
                idFaceImageData = faceCrop.dataUrl;
                console.info('[realKycService] face recovered from original frame');
            } else {
                console.warn('[realKycService] no face detected on original frame either');
            }
        } catch (err) {
            console.warn('[realKycService] original-frame face fallback failed:', err);
        }
    }

    // ---- Side-discrimination: reject same-side-twice ────────────────────────
    // Signals: face on the card / MRZ chevrons / address field / document
    // number prominence. `unknown` means we can't tell — preserve today's
    // behaviour and fall through.
    const detectedSide = classifySide({
        hasFace: !!faceBoxOnCrop,
        hasMrz: hasMrzChevrons(rawText),
        hasAddress: !!extracted.address,
        hasDocumentNumber: !!extracted.documentNumber,
    });
    console.log(
        `[realKycService] side classifier: requested=${side} detected=${detectedSide} ` +
            `(face=${!!faceBoxOnCrop}, mrz=${hasMrzChevrons(rawText)}, addr=${!!extracted.address}, docNo=${!!extracted.documentNumber})`,
    );
    if (detectedSide !== 'unknown' && detectedSide !== side) {
        return { found: false, extracted: {}, reason: 'wrong_side' };
    }

    // ── Back-side barcode decode (Lebanese, Syrian-Textract path, others) ───
    // IDs like the Lebanese national card have a PDF417 barcode on the back
    // containing the national number. Textract cannot decode barcodes, so we
    // run ZXing on the cropped document image. If successful, the national
    // number is added to `extracted` so backSideVerifier can compare it
    // against the front-side value.
    if (side === 'back' && !extracted.nationalNumber && croppedImageData) {
        try {
            const croppedBuffer = Buffer.from(stripDataUrlPrefix(croppedImageData), 'base64');
            const barcodeText = await decodeBarcodeFromBuffer(croppedBuffer);
            if (barcodeText) {
                const natNum = extractNatNumFromBarcodeText(barcodeText);
                console.log(
                    '[realKycService] ── General back barcode (Textract path) ──────────\n' +
                        `  raw text      : ${barcodeText}\n` +
                        `  nationalNumber : ${natNum ?? '(not found in barcode)'}`,
                );
                if (natNum) {
                    extracted.nationalNumber = natNum;
                    extracted.documentNumber = natNum;
                }
            } else {
                console.log('[realKycService] General back barcode: no barcode decoded');
            }
        } catch (err) {
            console.warn('[realKycService] back barcode decode failed:', err);
        }
    }

    return {
        found: true,
        extracted,
        croppedImageData,
        idFaceImageData,
        documentBox,
        idFaceBox,
        raw: response,
    };
}
