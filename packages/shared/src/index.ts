/**
 * @ramaaz/kyc-shared
 *
 * The single definition of everything both halves of the service must agree on:
 * the browser app that captures documents and faces, and the Worker that sends
 * them to AWS and NestJS.
 *
 * This package exists because that agreement was previously maintained by hand.
 * `kycConfig.ts`, `kycService.interface.ts` and the ID parsers each existed as
 * two copies — one client-side, one in the Worker — and they had drifted:
 * ~87 lines apart in the config alone. The Worker had also started importing
 * types across the repo from the frontend's source, which broke the moment the
 * two lived in separate repos.
 *
 * Rules for what belongs here:
 *   - it must be runtime-agnostic (no DOM, no node:*, no Workers globals)
 *   - it must be something client and server would otherwise both hardcode
 *
 * Thresholds that only one side enforces still live here (see openCV.* in the
 * config). One config that both sides read beats two that silently diverge.
 */

export type {
    LivenessChallenge,
    LivenessMetrics,
    LivenessResult,
    IDDocument,
    FaceMatchVerdict,
    MatchResult,
} from './types/verification';

export type {
    AnalyzeIdStatus,
    AnalyzeIdCode,
    AnalyzeIdNextStep,
    AnalyzeIdResult,
    ExtractedIdData,
} from './types/analyzeId';

export type {
    KycRequest,
    SubmitVerificationPayload,
    SubmitVerificationResult,
    KycSession,
} from './types/submit';

export {
    idConfig,
    faceConfig,
    compareConfig,
    videoConfig,
    kycConfig,
    default as config,
} from './config/kycConfig';
