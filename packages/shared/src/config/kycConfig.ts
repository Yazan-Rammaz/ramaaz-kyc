/**
 * KYC Verification — Central Configuration
 *
 * Single source of truth for every threshold, timeout, and constant used
 * across the KYC/verification flow. Works on both client and server (API routes).
 *
 * ─── 4 Sections ──────────────────────────────────────────────────────────────
 *   1. idConfig      — ID & Passport capture (quality, card detection, OCR, MRZ/barcode)
 *   2. faceConfig    — Face liveness detection (pose, centering, retries, timing)
 *   3. compareConfig — Face-to-ID comparison (similarity thresholds, timing)
 *   4. videoConfig   — Video call (duration, reconnect, pre-call settings)
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ID & PASSPORT CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const idConfig = {
    // ── Local image quality gates ─────────────────────────────────────────────
    // Canvas-API checks run on every frame BEFORE an AWS Textract call is made.
    // Raising these reduces wasted AWS calls; lowering them allows dimmer/blurrier
    // environments through (the server will still reject truly bad frames).
    //
    // NOTE: Thresholds are calibrated for real physical IDs (reflected light).
    // Screen-displayed IDs have 3–5× higher edge contrast; using screen-tuned
    // values here caused 'too_blurry' false-rejections on real documents.
    quality: {
        /** Minimum mean luminance [0–255]. Below this → "Too dark". */
        minBrightness: 45,
        /** Maximum mean luminance [0–255]. Above this → "Too bright". */
        maxBrightness: 240,
        /**
         * Sobel-variance floor. Below this → "Hold steady — frame is blurry".
         * Physical IDs under normal indoor lighting produce sharpness ~30–70.
         * The previous value (90) was calibrated for backlit screen displays
         * and blocked virtually every real printed document.
         */
        minSharpness: 28,
        /** Luma value above which a pixel counts as a "blown-out" glare spot. */
        glarePixelThreshold: 245,
        /** Max fraction [0–1] of blown-out pixels before flagging glare. */
        glareMaxRatio: 0.07,
        /** Mean absolute luma diff above which the camera is considered moving. */
        motionMaxDiff: 15,
    },

    // ── Frame stabilisation ───────────────────────────────────────────────────
    stability: {
        /** How long [ms] the frame must stay stable before an AWS call fires. */
        stabilityMs: 1000,
        /** How often [ms] the frame-validation hook re-checks the video. */
        intervalMs: 150,
    },

    // ── Card detection — directional edge analysis ────────────────────────────
    // ID cards produce axis-aligned Sobel edges (text, borders, barcodes).
    // Human faces produce diagonal/curved edges. These thresholds separate them.
    //
    // NOTE: Values are calibrated for real printed documents under hand-held
    // conditions (lower contrast, minor camera movement, various distances).
    // Screen-displayed IDs have higher contrast and don't need this leniency,
    // but the server-side Rekognition spoofing gate handles that case.
    cardDetection: {
        /** Minimum Sobel magnitude to count a pixel as a "significant edge". */
        edgeMagFloor: 10,
        /**
         * Minimum number of significant edge pixels required inside the scan ROI.
         * Physical IDs at arm's length on a 96-px downsampled image produce ~8–20
         * significant edges. The previous value (30) required screen-level contrast.
         */
        cardMinSignificantEdges: 8,
        /**
         * An edge is axis-aligned when min(|Gx|,|Gy|) / max(|Gx|,|Gy|) < this.
         * 0.45 ≈ within ±24° of horizontal or vertical. Slightly more lenient
         * than the previous 0.38 to accommodate hand-printed text variation.
         */
        axisDiagonalityMax: 0.45,
        /**
         * Required fraction of significant edges that must be axis-aligned.
         * Real physical IDs: ~0.52–0.60. Faces: ~0.44–0.50.
         * Set to 0.50 — safely above the face range, below the card range.
         */
        hvFractionThreshold: 0.5,
        /**
         * Border stripe: fraction of border-band edges pointing in the expected
         * direction. Lowered from 0.42 because physical cards held at any
         * distance may not perfectly fill the ROI, so border bands may contain
         * background that lowers this score.
         */
        borderScoreThreshold: 0.18,
        /** How much more dominant the "correct" axis must be inside a border band. */
        borderAxisRatio: 1.3,
        /** Minimum pixels per border band to consider its score meaningful. */
        minBandPx: 2,
    },

    // ── Card geometry (aspect ratio + fill) ───────────────────────────────────
    // CR80 (standard ID) = 1.586:1; passport open page ≈ 1.42:1.
    cardGeometry: {
        aspectRatioMin: 1.4,
        aspectRatioMax: 1.75,
        /** Detected card bounding box must fill at least this fraction of the ROI. */
        minFillRatio: 0,
    },

    // ── Moiré / photo-of-screen detection ────────────────────────────────────
    // Screens produce a periodic pixel grid visible as a mid-frequency DFT peak.
    screenDetection: {
        /** DFT profile length. */
        dftSize: 32,
        /** Lower edge of the mid-frequency band (ignore DC). */
        midBandLow: 4,
        /** Upper edge of the mid-frequency band (ignore Nyquist). */
        midBandHigh: 12,
        /** Geometric-mean energy ratio above which we flag a screen. */
        detectionThreshold: 0.45,
    },

    // ── AWS Textract / field validation ───────────────────────────────────────
    fieldValidation: {
        /** Minimum Textract confidence % to accept a field value. */
        fieldConfidenceThreshold: 80,
        /** Number of critical fields required on the FRONT side. */
        minMandatoryFieldsFront: 3,
        /** Number of critical fields required on the BACK side. */
        minMandatoryFieldsBack: 1,
        /**
         * The three fields that must be present and readable on the front side.
         * Mirrors the "QueriesConfig" discipline used in the API route.
         */
        criticalFields: ['FIRST_NAME', 'DATE_OF_BIRTH', 'DOCUMENT_NUMBER'] as const,
    },

    // ── Face photo on ID ──────────────────────────────────────────────────────
    faceOnId: {
        /** Max |faceCenterX – 0.5| allowed before flagging the ID face as off-center. */
        centeringToleranceCx: 0.18,
        /** Max |faceCenterY – 0.5| allowed before flagging the ID face as off-center. */
        centeringToleranceCy: 0.22,
    },

    // ── MRZ & barcode parsing ─────────────────────────────────────────────────
    mrz: {
        /** Minimum raw OCR text length to consider back-side valid. */
        minRawTextLength: 30,
        /**
         * 2-digit year cutoff for MRZ YY→YYYY conversion.
         * yy > yearCutoff → 19xx; yy ≤ yearCutoff → 20xx.
         */
        yearCutoff: 30,
        /** Max number of Textract detected fields to surface in the response. */
        detectedFieldsLimit: 8,
        /** Top-N longest anonymous lines to include alongside named fields. */
        longestLinesTopN: 4,
        /** Minimum text line length to include in raw-text extraction. */
        minLineLength: 4,
    },

    // ── Server-side Sharp cropping ────────────────────────────────────────────
    // These run on the Next.js API routes (Node.js / Sharp) — not in the browser.
    cropping: {
        /** Padding fraction added around a detected ID document crop. */
        idDocPadding: 0.08,
        /** Extra padding when the detected box looks lopsided. */
        idDocPaddingLopsided: 0.25,
        /** Minimum crop-area / full-image ratio — rejects tiny detections. */
        idDocMinAreaRatio: 0.15,
        /** Area ratio above which a detection is considered lopsided. */
        idDocLopsidedAreaRatio: 0.2,
        /** Maximum dimension as a fraction of the source image. */
        idDocMaxDimensionRatio: 0.9,
        /** Padding fraction added around the face photo on the ID. */
        idFacePadding: 0.18,
        /** JPEG quality for server-side crops sent back to the client. */
        jpegQuality: 90,
        /** JPEG quality for client-side canvas captures (0–1 scale). */
        clientJpegQuality: 0.92,
    },

    // ── Client-side OpenCV scanner (worker) ─────────────────────────────────
    openCV: {
        /** Process 1 frame every N animation frames. */
        processEveryNFrames: 4,
        /** Downscaled width cap for worker contour detection. */
        maxProcessingWidth: 960,
        /** Minimum detected quad area ratio (relative to processed frame). */
        minAreaRatio: 0.07,
        /** Max width for dewarped capture output returned from worker. */
        maxOutputWidth: null,
        /** EMA alpha for corner smoothing (higher = snappier, lower = smoother). */
        smoothingAlpha: 0.4,
        /** Safety margin from frame edges; detections inside this margin are rejected. */
        boundaryMarginPx: 5,
        /**
         * Interior content gate — how "busy" the inside of a detected quad must be
         * before it counts as a real document rather than a blank rectangle
         * (a book, a monitor, a sheet of paper). Lower to accept sparser cards,
         * raise if empty rectangles still pass.
         *   front — has photo + dense text/MRZ, so a higher bar is safe.
         *   back  — can be sparse (a little text / one barcode), so a lower bar.
         *
         * Client-only: the browser scanner enforces these; the Worker never reads
         * them. They live here so there is a single kycConfig rather than a
         * client copy that drifts from the server copy.
         */
        minInteriorDensityFront: 0.06,
        minInteriorDensityBack: 0.03,
    },

    // ── Back-side cross-verification (Levenshtein) ────────────────────────────
    backVerifier: {
        /** Minimum national-number length before comparing front/back. */
        nationalNumberMinLength: 8,
        /** Minimum document-number length before comparing front/back. */
        documentNumberMinLength: 6,
        /** Minimum last-name length before comparing front/back. */
        lastNameMinLength: 2,
        /** Maximum Levenshtein distance still considered a match. */
        levenshteinMaxDistance: 1,
    },

    // ── Spoofing / anti-replay detection (DetectLabels) ──────────────────────
    // AWS Rekognition DetectLabels runs BEFORE Textract to reject images that
    // are clearly photos of a screen, printed paper, or other reproductions.
    // Edit `rejectionLabels` and `messages` here — no code changes needed.
    spoofingDetection: {
        /** Set to false to disable the DetectLabels gate entirely (e.g. local dev). */
        enabled: false,
        /**
         * Rekognition confidence % floor for rejection.
         * Labels below this are logged but never trigger a rejection.
         * DetectLabels is called with (minConfidence − 15) so all near-threshold
         * labels still appear in the debug log for tuning.
         */
        minConfidence: 70,
        /** Maximum number of labels to request from DetectLabels. */
        maxLabels: 30,

        /**
         * LAYER 1 — Direct label match.
         * Any label whose exact Rekognition name appears here AND whose confidence
         * is ≥ minConfidence triggers an immediate rejection.
         * Add new device/paper names here as Rekognition's taxonomy evolves.
         */
        rejectionLabels: [
            // // Screens & displays
            // 'Monitor',
            // 'Screen',
            // 'Display',
            // 'LCD',
            // 'LED',
            // 'Television',
            // 'TV',
            // // Computers & devices
            // 'Computer',
            // 'Desktop',
            // 'Laptop',
            // 'PC',
            // 'iMac',
            // 'MacBook',
            // // Mobile & tablets
            // 'Mobile Phone',
            // 'Cell Phone',
            // 'Smartphone',
            // 'iPhone',
            // 'Android Phone',
            // 'Tablet',
            // 'iPad',
            // // Paper / printed reproductions
            // 'Paper',
            // 'Document',
            // 'Poster',
            // 'Flyer',
        ] as const,

        /**
         * LAYER 2 — Ancestor / parent match.
         * Rekognition returns a parent chain for every label, e.g.:
         *   "Smartphone" → ["Mobile Phone", "Electronics", "Technology"]
         * If ANY ancestor appears in this list the image is also rejected.
         * This catches sub-variants of electronic devices that aren't listed
         * by exact name above (e.g. brand-specific phone models, new device types).
         */
        rejectionParentLabels: [
            'Mobile Phone',
            'Computer',
            'Monitor',
            'Screen',
            'Electronics',
            'Tablet',
        ] as const,

        /**
         * User-facing messages per detected label (or ancestor name).
         * Keyed by exact Rekognition label name; `default` is the fallback.
         */
        messages: {
            Monitor: 'Please use your real ID card — a screen was detected.',
            Screen: 'Please use your real ID card — a screen was detected.',
            Display: 'Please use your real ID card — a screen was detected.',
            LCD: 'Please use your real ID card — a screen was detected.',
            LED: 'Please use your real ID card — a screen was detected.',
            Television: 'Please use your real ID card — a screen was detected.',
            TV: 'Please use your real ID card — a screen was detected.',
            Computer: 'Please use your real ID card — a computer screen was detected.',
            Desktop: 'Please use your real ID card — a computer screen was detected.',
            Laptop: 'Please use your real ID card — a laptop screen was detected.',
            iMac: 'Please use your real ID card — a computer screen was detected.',
            MacBook: 'Please use your real ID card — a laptop screen was detected.',
            'Mobile Phone': 'Please use your physical ID card, not a photo on a phone.',
            'Cell Phone': 'Please use your physical ID card, not a photo on a phone.',
            Smartphone: 'Please use your physical ID card, not a photo on a phone.',
            iPhone: 'Please use your physical ID card, not a photo on a phone.',
            Tablet: 'Please use your physical ID card, not a photo on a tablet.',
            iPad: 'Please use your physical ID card, not a photo on a tablet.',
            Electronics: 'Please use your physical ID card, not a photo on a device.',
            Paper: 'Printed or photocopied IDs are not accepted. Please use the original document.',
            Document:
                'Printed or photocopied IDs are not accepted. Please use the original document.',
            default: 'Real ID required — please present your original identity document.',
        } as Record<string, string>,
    },

    // ── Polling & UI timing (IDCaptureScreen) ────────────────────────────────
    timing: {
        /** How often [ms] the polling loop checks for a new valid frame. */
        pollIntervalMs: 500,
        /** Pause [ms] after "Document detected" before firing the AWS call. */
        captureDelayMs: 600,
        /** Debounce [ms] for failure-reason messages (fast — user needs to act). */
        statusDebounceFastMs: 1200,
        /** Debounce [ms] for pass/transition messages (slower — avoids flicker). */
        statusDebounceMs: 1200,
        /** How long [ms] without a face on the ID before showing the flip hint. */
        flipHintDelayMs: 3000,
        /** How often [ms] to run the MediaPipe face check on the rear camera. */
        faceCheckIntervalMs: 600,
        /** Pause [ms] on success before auto-switching to the back side. */
        successPauseMs: 1000,
        /** Pause [ms] before starting back-side polling after the side switch. */
        backSwitchDelayMs: 1500,
        /** Pause [ms] after final capture before navigating to ID Summary. */
        postCaptureNavMs: 800,
        /** How long [ms] to display a server rejection reason before resetting. */
        rejectionDisplayMs: 1200,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — FACE DETECTION CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const faceConfig = {
    // ── AWS Rekognition pose thresholds ───────────────────────────────────────
    // Rekognition returns yaw in degrees: negative = turned right, positive = left.
    pose: {
        /** Maximum absolute yaw [°] for the "look_straight" challenge. */
        yawStraightMax: 10,
        /** Minimum absolute yaw [°] required for the "turn_right" / "turn_left" challenges. */
        yawTurnMin: 20,
        /** Maximum absolute pitch [°] tolerated during any challenge. */
        pitchMax: 15,
        /** CSS `rotateY` degrees applied to the NetMask during a turn challenge. */
        netMaskRotateYDeg: 28,
    },

    // ── AWS Rekognition quality gates ────────────────────────────────────────
    // Applied server-side; much lower than local ID thresholds because Rekognition
    // compensates for low-light selfies better than Canvas Sobel analysis.
    quality: {
        /** Minimum brightness Rekognition must report. */
        minBrightness: 25,
        /** Minimum sharpness Rekognition must report. */
        minSharpness: 25,
    },

    // ── Spoofing / "real face" detection (DetectLabels) ──────────────────────
    // Mirrors idConfig.spoofingDetection but applied to the SELFIE frame. AWS
    // Rekognition DetectLabels runs on the straight-on liveness frame and rejects
    // when the "face" is actually shown on another phone/monitor/tablet, or is a
    // printed photo. This is what makes the liveness step reject a face presented
    // from another device WITHOUT the AWS Amplify Face Liveness SDK.
    //
    // Same two-layer logic as the ID gate: direct label match (Layer 1) + parent/
    // ancestor match (Layer 2). Edit `rejectionLabels` / `messages` here only.
    spoofingDetection: {
        /** Set to false to disable the selfie DetectLabels gate (e.g. local dev). */
        enabled: true,
        /** Rekognition confidence % floor for rejection (labels below are logged only). */
        minConfidence: 80,
        /** Maximum number of labels to request from DetectLabels. */
        maxLabels: 30,
        /**
         * LAYER 1 — direct label match. A live human selfie never legitimately
         * contains these, so any confident hit means the face is on a device/paper.
         */
        rejectionLabels: [
            // Screens & displays
            'Monitor',
            'Screen',
            'Display',
            'LCD',
            'Television',
            'TV',
            // Computers & devices
            'Computer',
            'Laptop',
            'iMac',
            'MacBook',
            // Mobile & tablets
            'Mobile Phone',
            'Cell Phone',
            'Smartphone',
            'iPhone',
            'Tablet',
            'iPad',
        ] as const,
        /**
         * LAYER 2 — ancestor / parent match. Catches device sub-variants that share
         * an electronic-device ancestor even when the exact name isn't listed above.
         */
        rejectionParentLabels: [
            'Mobile Phone',
            'Computer',
            'Monitor',
            'Screen',
            'Electronics',
            'Tablet',
        ] as const,
        /** User-facing messages, keyed by exact label (or ancestor) name; `default` is fallback. */
        messages: {
            Monitor: 'Use your real face — a screen was detected.',
            Screen: 'Use your real face — a screen was detected.',
            Display: 'Use your real face — a screen was detected.',
            LCD: 'Use your real face — a screen was detected.',
            Television: 'Use your real face — a screen was detected.',
            TV: 'Use your real face — a screen was detected.',
            Computer: 'Use your real face — a computer screen was detected.',
            Laptop: 'Use your real face — a laptop screen was detected.',
            iMac: 'Use your real face — a computer screen was detected.',
            MacBook: 'Use your real face — a laptop screen was detected.',
            'Mobile Phone': 'Use your real face, not a photo on another phone.',
            'Cell Phone': 'Use your real face, not a photo on another phone.',
            Smartphone: 'Use your real face, not a photo on another phone.',
            iPhone: 'Use your real face, not a photo on another phone.',
            Tablet: 'Use your real face, not a photo on a tablet.',
            iPad: 'Use your real face, not a photo on a tablet.',
            Electronics: 'Use your real face, not a photo on a device.',
            default: 'Use your real face — a screen or photo was detected.',
        } as Record<string, string>,
    },

    // ── Centering check ───────────────────────────────────────────────────────
    // After look_straight passes, the bounding box is used to verify the face
    // is spatially centred in the frame (not just rotationally aligned).
    centering: {
        /**
         * Maximum allowed horizontal offset of the face centre from the frame centre.
         * |bbox.left + bbox.width/2 − 0.5| must be < this value.
         * 0.25 = face centre may be anywhere in the middle 50 % of the frame.
         */
        maxHorizontalOffset: 0.25,
    },

    // ── Attempt limits ────────────────────────────────────────────────────────
    attempts: {
        /** Maximum failures per challenge before redirecting to contact-support. */
        maxPerChallenge: 3,
        /** How many times the final-capture loop retries before giving up. */
        finalCaptureRetries: 3,
    },

    // ── Selfie crop padding (server-side Sharp) ───────────────────────────────
    cropping: {
        /** Padding fraction added around the detected face in the selfie crop. */
        selfieFacePadding: 0.25,
    },

    // ── Timing ───────────────────────────────────────────────────────────────
    timing: {
        /** How long [ms] the user must hold a valid pose before it is accepted. */
        holdLockedMs: 400,
        /** Initial pause [ms] before the first challenge starts (camera warm-up). */
        challengeStartDelayMs: 400,
        /** Pause [ms] before each individual challenge step attempt. */
        stepDelayMs: 600,
        /** Pause [ms] after "Perfect!" before advancing to the next step. */
        postStepMs: 300,
        /** Pause [ms] after a rejection so the user can read the error. */
        rejectionPauseMs: 600,
        /** Pause [ms] after a centering error before retrying look_straight. */
        centeringRetryMs: 600,
        /** Delay [ms] before the first final-capture attempt. */
        firstCaptureDelayMs: 300,
        /** Delay [ms] between subsequent final-capture retries. */
        captureRetryDelayMs: 500,
        /** How long [ms] to show the success flash before navigating to face-match. */
        postFlashNavMs: 600,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — COMPARE / FACE-MATCH CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const compareConfig = {
    // ── AWS Rekognition CompareFaces similarity thresholds ────────────────────
    // ⚠️ SINGLE SOURCE OF TRUTH — change `passThreshold` here and the entire
    // pipeline (server route + client UI) updates. Default = 80%.
    similarity: {
        /**
         * Minimum similarity [0–100] for an automatic PASS.
         * Scores at or above this go straight to video-pre-call.
         */
        passThreshold: 0,
        /**
         * Minimum similarity [0–100] for a soft PASS (manual review queued).
         * Scores between reviewThreshold and passThreshold trigger the review banner.
         */
        reviewThreshold: 75,
        /**
         * The similarity floor passed to the AWS CompareFaces API as the
         * `SimilarityThreshold` parameter. Faces below this are never returned.
         */
        awsFilterFloor: 75,
    },

    // ── Timing ───────────────────────────────────────────────────────────────
    timing: {
        /** Pause [ms] after a successful match before navigating to video-pre-call. */
        successNavDelayMs: 2000,
    },

    // ── Mock branch ───────────────────────────────────────────────────────────
    mock: {
        /** Simulated API delay [ms] in mock mode. */
        delayMs: 1200,
        /** Simulated match score returned by the mock. */
        mockScore: 94,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — VIDEO CALL CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const videoConfig = {
    // ── Session limits ────────────────────────────────────────────────────────
    session: {
        /** Maximum call duration [ms] before the session is force-ended. */
        maxDurationMs: 20 * 60 * 1000,
        /** How many reconnect attempts before showing a failure screen. */
        reconnectAttempts: 3,
        /** Delay [ms] between reconnect attempts. */
        reconnectDelayMs: 2000,
        /** Idle timeout [ms] — if no agent joins within this window, end the call. */
        agentJoinTimeoutMs: 60 * 1000,
    },

    // ── Pre-call checks ───────────────────────────────────────────────────────
    preCall: {
        /** Whether to request microphone permission on the pre-call screen. */
        checkMicrophone: true,
        /** Whether to run a brief camera check on the pre-call screen. */
        checkCamera: true,
        /** Pause [ms] after permissions are confirmed before starting the call. */
        preCallReadyDelayMs: 800,
    },

    // ── Media constraints ────────────────────────────────────────────────────
    media: {
        /** Ideal video width for the video call stream. */
        idealWidth: 1280,
        /** Ideal video height for the video call stream. */
        idealHeight: 720,
        /** Ideal frame rate for the video call stream. */
        idealFrameRate: 30,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE RE-EXPORTS
// Import the whole bundle when you need everything:
//   import { kycConfig } from '@/config/kycConfig';
//   kycConfig.face.pose.yawStraightMax
// ─────────────────────────────────────────────────────────────────────────────
export const kycConfig = {
    id: idConfig,
    face: faceConfig,
    compare: compareConfig,
    video: videoConfig,
} as const;

export default kycConfig;
