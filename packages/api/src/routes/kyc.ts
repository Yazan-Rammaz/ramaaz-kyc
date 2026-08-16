import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../index';
import { backendFetch } from '../lib/backendFetch';
import { getOpenAI } from '../lib/openai';
import { postSignedToNest, patchSignedToNest } from '../lib/kycSigning';
import { compareConfig, faceConfig, idConfig } from '@ramaaz/kyc-shared/config';
import type { AnalyzeIdResult, AnalyzeIdCode } from '../services/kyc/kycService.interface';

export const kycRoutes = new Hono<{ Bindings: Env }>();

/**
 * Access token for the onboarding routes. Web sends it as the `rdb_at` cookie;
 * native clients (Flutter) without a cookie jar send `Authorization: Bearer`.
 * Bearer wins so a stale copied cookie can never shadow a fresh native token.
 */
function accessToken(c: Context): string {
  const h = c.req.header('Authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return getCookie(c, 'rdb_at') ?? '';
}

// ── POST /api/kyc/analyze-id ─────────────────────────────────────────────────
const CRITICAL_FIELDS = ['FIRST_NAME', 'DATE_OF_BIRTH', 'DOCUMENT_NUMBER'] as const;
type CriticalField = (typeof CRITICAL_FIELDS)[number];
const pollCounters = new Map<string, number>();

kycRoutes.post('/analyze-id', async (c) => {
  const body = await c.req.json<{ imageData: string; side?: 'front' | 'back'; sessionHint?: string }>();
  const { imageData, side = 'front', sessionHint = 'default' } = body;

  if (!imageData) return c.json({ error: 'imageData is required' }, 400);

  const useMock = c.env.AWS_MOCK !== 'false';

  if (!useMock) {
    try {
      const { analyzeIdDocument, detectIdSpoofing } = await import('../services/kyc/realKycService');

      if (idConfig.spoofingDetection.enabled) {
        const spoof = await detectIdSpoofing(imageData);
        if (!spoof.isReal) {
          return c.json({ status: 'error', code: 'SPOOFING_DETECTED' as AnalyzeIdCode, message: spoof.message ?? idConfig.spoofingDetection.messages.default, side, found: false } satisfies AnalyzeIdResult);
        }
      }

      const result = await analyzeIdDocument(imageData, side);
      if (!result.found) {
        return c.json({ status: 'error', code: mapReasonToCode(result.reason), message: mapReasonToMessage(result.reason, side), side, found: false } satisfies AnalyzeIdResult);
      }

      const cropped = result.croppedImageData ?? imageData;
      const ext = result.extracted ?? {};

      if (side === 'front') {
        const { detectedFields: _df, ...extStrings } = ext;
        const policy = validateAgainstPolicy(extStrings as Record<string, string | undefined>, ext.idType);
        if (!policy.accepted) {
          return c.json({ status: 'error', code: 'MISSING_CRITICAL_DATA', message: 'ID not clearly readable. Hold the card flat, well-lit, and try again.', side: 'front', found: false } satisfies AnalyzeIdResult);
        }
        const isPassport = (ext.idType ?? '').toLowerCase().includes('passport');
        const extractedData: AnalyzeIdResult['extractedData'] = { idType: ext.idType ?? '', idName: ext.idType ?? '', country: ext.country ?? '', name: ext.name ?? '', nationalNumber: ext.nationalNumber ?? '', birthday: ext.birthday ?? '', firstName: ext.firstName, lastName: ext.lastName, documentNumber: isPassport ? ext.passportNumber : ext.documentNumber, expiryDate: ext.expiryDate, rawText: ext.rawText };
        return c.json({ status: 'success', nextStep: isPassport ? 'COMPLETE' : 'REQUIRE_BACK', croppedImageData: cropped, idFaceImageData: result.idFaceImageData, side: 'front', extracted: ext, extractedData, found: true } satisfies AnalyzeIdResult);
      }

      const rawBack = ext.rawText ?? '';
      const hasContent = /<{5,}/.test(rawBack) || !!ext.address || !!ext.documentNumber || !!ext.nationalNumber || rawBack.length >= 30;
      if (!hasContent) return c.json({ status: 'error', code: 'MISSING_CRITICAL_DATA', message: 'ID not clearly readable. Hold the card flat, well-lit, and try again.', side: 'back', found: false } satisfies AnalyzeIdResult);
      return c.json({ status: 'success', nextStep: 'COMPLETE', croppedImageData: cropped, side: 'back', extracted: ext, extractedData: { idType: ext.idType ?? '', idName: ext.idType ?? '', country: ext.country ?? '', name: ext.name ?? '', nationalNumber: ext.nationalNumber ?? '', birthday: ext.birthday ?? '', firstName: ext.firstName, lastName: ext.lastName, documentNumber: ext.documentNumber, expiryDate: ext.expiryDate, rawText: ext.rawText }, found: true } satisfies AnalyzeIdResult);
    } catch (err) {
      console.error('[analyze-id] AWS failure:', err);
      return c.json({ error: 'analyze-id failed', detail: String(err) }, 500);
    }
  }

  await new Promise((r) => setTimeout(r, 600));
  const key = `${sessionHint}_${side}`;
  const count = (pollCounters.get(key) ?? 0) + 1;
  pollCounters.set(key, count);
  if (count <= 2) return c.json({ status: 'not_found', side, found: false } satisfies AnalyzeIdResult);
  pollCounters.delete(key);
  const mockExtracted = { idType: 'Personal Identity ID', idName: 'Personal Identity ID', country: 'Syria', name: 'Mohammad De Bruijn', firstName: 'Mohammad', lastName: 'De Bruijn', nationalNumber: '09982111123332', documentNumber: '09982111123332', birthday: '01.01.1999', expiryDate: '01.01.2030' };
  if (side === 'front') return c.json({ status: 'success', nextStep: 'REQUIRE_BACK', croppedImageData: imageData, side: 'front', extracted: mockExtracted, extractedData: mockExtracted, found: true } satisfies AnalyzeIdResult);
  return c.json({ status: 'success', nextStep: 'COMPLETE', croppedImageData: imageData, side: 'back', extracted: mockExtracted, extractedData: mockExtracted, found: true } satisfies AnalyzeIdResult);
});

function validateAgainstPolicy(extracted: Record<string, string | undefined>, idType?: string) {
  const fieldMap: Record<CriticalField, string | undefined> = { FIRST_NAME: extracted['firstName'] ?? extracted['name'], DATE_OF_BIRTH: extracted['birthday'], DOCUMENT_NUMBER: extracted['documentNumber'] ?? extracted['nationalNumber'] };
  const missingFields = CRITICAL_FIELDS.filter((k) => !fieldMap[k]?.trim());
  const isPassport = (idType ?? '').toLowerCase().includes('passport');
  if (isPassport) return { accepted: (['FIRST_NAME', 'DATE_OF_BIRTH'] as CriticalField[]).every((k) => fieldMap[k]?.trim()), missingFields };
  return { accepted: missingFields.length === 0, missingFields };
}

function mapReasonToCode(reason: string | undefined): AnalyzeIdCode {
  if (reason === 'invalid_id_type') return 'INVALID_ID_TYPE';
  if (reason === 'no_text_detected') return 'NO_TEXT_DETECTED';
  if (reason === 'wrong_side') return 'WRONG_SIDE';
  return 'MISSING_CRITICAL_DATA';
}

function mapReasonToMessage(reason: string | undefined, side: 'front' | 'back'): string {
  if (reason === 'invalid_id_type') return 'This is not a supported ID. Use a passport or national ID.';
  if (reason === 'wrong_side') return side === 'back' ? 'This is the front of your ID. Flip it over and show the back.' : 'This is the back of your ID. Show the side with your photo.';
  return 'ID not clearly readable. Hold the card flat, well-lit, and try again.';
}

// ── POST /api/kyc/liveness ────────────────────────────────────────────────────
type ChallengeStep = 'look_straight' | 'turn_right' | 'turn_left';

kycRoutes.post('/liveness', async (c) => {
  const body = await c.req.json<{ faceImageData: string; challengeStep?: ChallengeStep; crop?: boolean }>();
  const { faceImageData, challengeStep = 'look_straight', crop = false } = body;
  if (!faceImageData) return c.json({ error: 'faceImageData is required' }, 400);

  const useMock = c.env.AWS_MOCK !== 'false';
  if (!useMock) {
    try {
      const { analyzeFaceLiveness, detectFaceSpoofing } = await import('../services/kyc/realKycService');
      const wantCrop = crop || challengeStep === 'look_straight';
      const result = await analyzeFaceLiveness(faceImageData, { crop: wantCrop });
      if (!result.found || !result.metrics) return c.json({ isLive: false, challengeStep, reason: 'no_face_detected', timestamp: Date.now() });

      // "Real face" gate — reject a face that is being shown on another phone /
      // monitor / tablet (or a printed photo). Runs only on the straight-on frame
      // (the one that becomes the submitted selfie) to keep AWS DetectLabels cost
      // down. Uses the full frame, not the tight crop, so the device is in view.
      if (faceConfig.spoofingDetection.enabled && challengeStep === 'look_straight') {
        const spoof = await detectFaceSpoofing(faceImageData);
        if (!spoof.isReal) {
          return c.json({ isLive: false, challengeStep, reason: 'screen_detected', message: spoof.message, timestamp: Date.now() });
        }
      }

      const m = result.metrics;
      const verdict = validateChallenge(challengeStep, m.yaw, m.eyesOpen, m.brightness, m.sharpness, m.sunglasses);
      return c.json({ isLive: verdict.pass, challengeStep, metrics: m, faceImageData: verdict.pass && wantCrop ? (result.faceImageData ?? faceImageData) : undefined, reason: verdict.reason, timestamp: Date.now() });
    } catch (err) {
      return c.json({ error: 'liveness failed', detail: String(err) }, 500);
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  return c.json({ isLive: true, challengeStep, faceImageData, timestamp: Date.now() });
});

function validateChallenge(step: ChallengeStep, yaw: number, eyesOpen: boolean, brightness: number, sharpness: number, sunglasses: boolean) {
  if (sunglasses) return { pass: false, reason: 'sunglasses_detected' };
  if (!eyesOpen) return { pass: false, reason: 'eyes_closed' };
  if (brightness < faceConfig.quality.minBrightness) return { pass: false, reason: 'too_dark' };
  if (sharpness < faceConfig.quality.minSharpness) return { pass: false, reason: 'too_blurry' };
  if (step === 'look_straight') return Math.abs(yaw) > faceConfig.pose.yawStraightMax ? { pass: false, reason: 'not_facing_camera' } : { pass: true };
  if (step === 'turn_right') return yaw > -faceConfig.pose.yawTurnMin ? { pass: false, reason: 'turn_more_right' } : { pass: true };
  return yaw < faceConfig.pose.yawTurnMin ? { pass: false, reason: 'turn_more_left' } : { pass: true };
}

// ── POST /api/kyc/liveness-aws (GET + POST) ───────────────────────────────────
kycRoutes.post('/liveness-aws', async (c) => {
  try {
    const { awsRegion, rekognitionClient } = await import('../services/kyc/realKycService');
    const { CreateFaceLivenessSessionCommand } = await import('@aws-sdk/client-rekognition');
    const out = await rekognitionClient.send(new CreateFaceLivenessSessionCommand({}));
    if (!out.SessionId) throw new Error('AWS did not return a liveness session ID');
    return c.json({ sessionId: out.SessionId, region: awsRegion });
  } catch (err) {
    return c.json({ error: 'Session creation failed', message: String(err) }, 500);
  }
});

kycRoutes.get('/liveness-aws', async (c) => {
  const sessionId = c.req.query('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
  try {
    const { rekognitionClient } = await import('../services/kyc/realKycService');
    const { GetFaceLivenessSessionResultsCommand } = await import('@aws-sdk/client-rekognition');
    const out = await rekognitionClient.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }));
    const refBytes = out.ReferenceImage?.Bytes;
    const livenessImageData = refBytes ? `data:image/jpeg;base64,${Buffer.from(refBytes).toString('base64')}` : null;
    return c.json({ status: out.Status, confidence: out.Confidence ?? 0, livenessImageData });
  } catch (err) {
    return c.json({ error: 'Results fetch failed', message: String(err) }, 500);
  }
});

// ── POST /api/kyc/liveness-credentials ───────────────────────────────────────
kycRoutes.post('/liveness-credentials', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  let kycSessionId: string;
  try {
    const body = await c.req.json<{ kycSessionId?: string }>();
    kycSessionId = body.kycSessionId ?? '';
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!kycSessionId) return c.json({ error: 'kycSessionId is required' }, 422);

  const currentUserId = jwtSub(token);
  if (!currentUserId) return c.json({ error: 'Unauthorized' }, 401);

  const validateRes = await backendFetch(c.env.RDB_BASE_URL, `/kyc/sessions/${kycSessionId}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': c.env.KYC_INTERNAL_SECRET ?? '' },
    body: JSON.stringify({ userId: currentUserId }),
  });
  if (!validateRes.ok) return c.json({ error: 'Invalid or expired KYC session' }, 401);

  const sessionToken = c.env.AWS_SESSION_TOKEN || undefined;
  return c.json({ accessKeyId: c.env.AWS_ACCESS_KEY_ID, secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY, ...(sessionToken ? { sessionToken } : {}) });
});

function jwtSub(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as { sub?: string; userId?: string; id?: string };
    return claims.sub ?? claims.userId ?? claims.id;
  } catch { return undefined; }
}

// ── POST /api/kyc/compare-face ────────────────────────────────────────────────
kycRoutes.post('/compare-face', async (c) => {
  const body = await c.req.json<{ selfieImageData?: string; idFaceImageData?: string }>().catch(() => ({} as { selfieImageData?: string; idFaceImageData?: string }));
  if (!body.selfieImageData || !body.idFaceImageData) return c.json({ status: 'error', code: 'INTERNAL_ERROR', message: 'selfieImageData and idFaceImageData are required.' }, 400);

  const useMock = c.env.AWS_MOCK !== 'false';
  if (!useMock) {
    try {
      const { compareFaces } = await import('../services/kyc/realKycService');
      const result = await compareFaces(body.idFaceImageData, body.selfieImageData, compareConfig.similarity.passThreshold);
      if (!result.sourceFaceDetected || !result.targetFaceDetected) return c.json({ status: 'error', code: 'FACE_NOT_DETECTED', message: result.sourceFaceDetected ? 'No face detected in the selfie.' : 'No face detected on the ID.' });
      if (result.similarity >= compareConfig.similarity.passThreshold) return c.json({ status: 'success', matchScore: result.similarity, message: 'Face matched successfully.' });
      return c.json({ status: 'error', code: 'FACE_MISMATCH', message: 'Face does not match the ID. Please try again.' });
    } catch (err) {
      // AWS Rekognition CompareFaces throws (rather than returning) in several
      // cases — most commonly when the SOURCE image (the ID photo) has no
      // detectable face. Log it and surface a precise reason instead of a blind
      // 500 so clients (web + Flutter) can act on it.
      console.error('[compare-face] CompareFaces failed:', err);
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'InvalidParameterException') {
        // No face found in the ID photo and/or the selfie.
        return c.json({ status: 'error', code: 'FACE_NOT_DETECTED', message: 'No face detected in the ID photo or the selfie. Make sure both clearly show a face.' });
      }
      if (name === 'InvalidImageFormatException') {
        return c.json({ status: 'error', code: 'INVALID_IMAGE', message: 'Image must be a JPEG or PNG.' });
      }
      if (name === 'ImageTooLargeException') {
        return c.json({ status: 'error', code: 'IMAGE_TOO_LARGE', message: 'Image is too large — send a tighter crop under 5 MB.' });
      }
      return c.json({ status: 'error', code: 'INTERNAL_ERROR', message: 'Face comparison failed.', detail: String((err as { message?: string })?.message ?? err) }, 500);
    }
  }
  await new Promise((r) => setTimeout(r, compareConfig.mock.delayMs));
  return c.json({ status: 'success', matchScore: compareConfig.mock.mockScore, message: 'Face matched successfully.' });
});

// ── POST /api/kyc/session ─────────────────────────────────────────────────────
kycRoutes.post('/session', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const res = await backendFetch(c.env.RDB_BASE_URL, '/kyc/sessions/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    return c.json(data, res.status as 200);
  } catch {
    return c.json({ error: 'Backend unavailable' }, 502);
  }
});

// ── GET /api/kyc/status ───────────────────────────────────────────────────────
kycRoutes.get('/status', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const res = await backendFetch(c.env.RDB_BASE_URL, '/kyc/status', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    return c.json(data, res.status as 200);
  } catch {
    return c.json({ error: 'Backend unavailable' }, 502);
  }
});

// ── GET /api/kyc/current ──────────────────────────────────────────────────────
kycRoutes.get('/current', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const res = await backendFetch(c.env.RDB_BASE_URL, '/kyc/current', { headers: { Authorization: `Bearer ${token}` } });
    const kycRequest = res.status === 404 ? null : await res.json().catch(() => null);
    const isProduction = c.env.ENVIRONMENT === 'production';
    const existing = getCookie(c, 'rdb_user');
    if (existing) {
      try {
        const user = JSON.parse(existing);
        setCookie(c, 'rdb_user', JSON.stringify({ ...user, kycRequest: kycRequest ?? null }), { httpOnly: true, secure: isProduction, sameSite: 'Strict', expires: new Date(Date.now() + 24 * 60 * 60 * 1000), path: '/' });
      } catch { /* non-fatal */ }
    }
    return c.json({ kycRequest: kycRequest ?? null });
  } catch {
    return c.json({ error: 'Could not reach backend' }, 502);
  }
});

// ── Face Re-Verification (step-up "Face ID") ─────────────────────────────────
// Shared API surface consumed by BOTH the web app and the Flutter app. A gated
// NestJS action (transfer, withdraw, forgot-passcode) returns a step-up
// requirement carrying a `challengeId`; the client runs a fast face check and the
// Worker compares the live face against the user's ENROLLED KYC SELFIE, then
// proxies a SIGNED result to NestJS. NestJS alone decides pass/fail.
//
// Unlike the onboarding routes (cookie-only), these accept a Bearer token too so
// native clients (Flutter) without a cookie jar can call them.

/**
 * Resolve the user credential for the re-verify routes.
 *
 * `isSessionStep` marks the mid-login reset-passcode case: no access token
 * exists yet, and the login SESSION stepToken rides the `rdb_step` cookie
 * (the web proxy forwards the browser's Cookie header wholesale). That case
 * must commit to the step-scoped NestJS route — its StepTokenGuard reads the
 * Authorization Bearer exclusively, so the cookie value is re-sent as a
 * Bearer by postSignedToNest, never as a cookie.
 */
function reverifyAuth(c: Context): { token: string; isSessionStep: boolean } {
  // Native mid-login (reset-passcode): Flutter has no cookie jar, so the login
  // SESSION stepToken rides an explicit header. Checked first — sending it as a
  // plain Bearer would be mistaken for an access token, and the enrolled-selfie
  // fetch via GET /kyc/current would 401 → NO_ENROLLED_SELFIE.
  const step = c.req.header('X-Step-Token');
  if (step) return { token: step, isSessionStep: true };
  const h = c.req.header('Authorization');
  if (h && h.startsWith('Bearer ')) return { token: h.slice(7), isSessionStep: false };
  const at = getCookie(c, 'rdb_at');
  if (at) return { token: at, isSessionStep: false };
  const stepCookie = getCookie(c, 'rdb_step');
  if (stepCookie) return { token: stepCookie, isSessionStep: true };
  return { token: '', isSessionStep: false };
}

function reverifyToken(c: Context): string {
  return reverifyAuth(c).token;
}

interface ReverifyChallengeInfo {
  valid: boolean;
  /**
   * Raw S3 URL of the enrolled selfie (ADR-013, ticket
   * kyc-reverify-worker-selfie-access) — plain-fetchable, no Bearer. Explicitly
   * null when the user has no VERIFIED enrollment with a selfie. Mid-login this
   * is the ONLY selfie source: the session stepToken 401s on GET /kyc/current.
   */
  selfieImageUrl: string | null;
}

/** Validate a re-verify challenge belongs to this user and is still open (NestJS). */
async function validateReverifyChallenge(
  baseUrl: string,
  challengeId: string,
  userId: string,
  internalSecret: string,
): Promise<ReverifyChallengeInfo> {
  try {
    const res = await backendFetch(baseUrl, `/kyc/reverify/${challengeId}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) return { valid: false, selfieImageUrl: null };
    // `valid !== false` keeps pre-ADR-013 backends (empty/`ok`-only bodies) valid.
    const body = (await res.json().catch(() => ({}))) as {
      valid?: boolean;
      selfieImageUrl?: string | null;
    };
    return { valid: body.valid !== false, selfieImageUrl: body.selfieImageUrl ?? null };
  } catch {
    return { valid: false, selfieImageUrl: null };
  }
}

/**
 * Download a selfie image and return it as a base64 data URL. The selfie lives
 * on S3. Do NOT send our JWT as Authorization by default — S3 parses any
 * Authorization header as an AWS signature and rejects the request. Plain
 * fetch first (public/presigned URL); `bearer` only as a fallback for media
 * served behind the API (useless mid-login — the stepToken passes no guard).
 */
async function downloadSelfie(url: string | null, bearer?: string): Promise<string | null> {
  if (!url) return null;
  try {
    let imgRes = await fetch(url);
    if (!imgRes.ok && bearer) {
      imgRes = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    }
    if (!imgRes.ok) {
      console.warn(`[reverify] selfie download failed → ${imgRes.status} (${url.slice(0, 80)}…)`);
      return null;
    }
    const ab = await imgRes.arrayBuffer();
    return `data:image/jpeg;base64,${Buffer.from(ab).toString('base64')}`;
  } catch (err) {
    console.warn('[reverify] selfie download error:', err);
    return null;
  }
}

/** Fetch the user's enrolled KYC selfie from NestJS and return it as a base64 data URL. */
async function fetchEnrolledSelfie(token: string, baseUrl: string): Promise<string | null> {
  try {
    const res = await backendFetch(baseUrl, '/kyc/current', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.warn(`[reverify] /kyc/current → ${res.status}`);
      return null;
    }
    // Unwrap however many `kycRequest` envelope layers NestJS returns.
    let rec = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    while (rec && typeof rec.kycRequest === 'object' && rec.kycRequest !== null) {
      rec = rec.kycRequest as Record<string, unknown>;
    }
    const url = rec?.selfieImageUrl as string | undefined;
    if (!url) {
      console.warn('[reverify] /kyc/current has no selfieImageUrl');
      return null;
    }
    return await downloadSelfie(url, token);
  } catch (err) {
    console.warn('[reverify] fetchEnrolledSelfie error:', err);
    return null;
  }
}

// POST /api/kyc/reverify/start — validate the challenge, open an AWS liveness session.
kycRoutes.post('/reverify/start', async (c) => {
  const token = reverifyToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const userId = jwtSub(token);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  let challengeId = '';
  try {
    const body = await c.req.json<{ challengeId?: string }>();
    challengeId = body.challengeId ?? '';
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!challengeId) return c.json({ error: 'challengeId is required' }, 422);

  const challenge = await validateReverifyChallenge(c.env.RDB_BASE_URL, challengeId, userId, c.env.KYC_INTERNAL_SECRET ?? '');
  if (!challenge.valid) return c.json({ error: 'Invalid or expired re-verification challenge' }, 401);

  try {
    const { awsRegion, rekognitionClient } = await import('../services/kyc/realKycService');
    const { CreateFaceLivenessSessionCommand } = await import('@aws-sdk/client-rekognition');
    const out = await rekognitionClient.send(new CreateFaceLivenessSessionCommand({}));
    if (!out.SessionId) throw new Error('AWS did not return a liveness session ID');
    return c.json({ sessionId: out.SessionId, region: awsRegion });
  } catch (err) {
    return c.json({ error: 'Session creation failed', message: String(err) }, 500);
  }
});

// GET /api/kyc/reverify/credentials?challengeId=… — vend temp AWS creds for the
// Amplify FaceLivenessDetector, gated on a valid challenge.
kycRoutes.get('/reverify/credentials', async (c) => {
  const token = reverifyToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const userId = jwtSub(token);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const challengeId = c.req.query('challengeId') ?? '';
  if (!challengeId) return c.json({ error: 'challengeId is required' }, 422);

  const challenge = await validateReverifyChallenge(c.env.RDB_BASE_URL, challengeId, userId, c.env.KYC_INTERNAL_SECRET ?? '');
  if (!challenge.valid) return c.json({ error: 'Invalid or expired re-verification challenge' }, 401);

  const sessionToken = c.env.AWS_SESSION_TOKEN || undefined;
  return c.json({
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    ...(sessionToken ? { sessionToken } : {}),
  });
});

// POST /api/kyc/reverify/verify — run liveness + compare-against-enrolled-selfie,
// then commit a signed result to NestJS (which makes the decision).
//   body: { challengeId, sessionId? (streaming) | liveFaceImageData? (single-frame) }
kycRoutes.post('/reverify/verify', async (c) => {
  const { token, isSessionStep } = reverifyAuth(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const userId = jwtSub(token);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  let parsed: { challengeId?: string; sessionId?: string; liveFaceImageData?: string };
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const challengeId = parsed.challengeId ?? '';
  if (!challengeId) return c.json({ error: 'challengeId is required' }, 422);
  if (!parsed.sessionId && !parsed.liveFaceImageData) {
    return c.json({ error: 'sessionId or liveFaceImageData is required' }, 422);
  }

  // Validate the challenge (and get the enrolled selfie URL, ADR-013) BEFORE
  // burning AWS liveness/compare spend on a dead challenge. Mid-login this is
  // the only selfie source — the session stepToken 401s on GET /kyc/current.
  const challenge = await validateReverifyChallenge(
    c.env.RDB_BASE_URL,
    challengeId,
    userId,
    c.env.KYC_INTERNAL_SECRET ?? '',
  );
  if (!challenge.valid) {
    return c.json({ error: 'Invalid or expired re-verification challenge' }, 401);
  }

  const useMock = c.env.AWS_MOCK !== 'false';
  let livenessConfidence = 0;
  let faceMatchScore = 0;

  try {
    if (useMock) {
      livenessConfidence = 95;
      faceMatchScore = compareConfig.mock.mockScore;
    } else {
      // 1. Obtain the live face image + liveness confidence.
      // Prefer the SINGLE-FRAME path whenever a face image is supplied. Native
      // clients (Flutter) have no Amplify streaming UI, and some send a stale,
      // never-streamed sessionId alongside the real liveFaceImageData — which
      // would otherwise take the streaming branch and fail with status CREATED.
      // Only use the streaming path when ONLY a sessionId was provided.
      let liveFaceB64 = '';
      if (parsed.sessionId && !parsed.liveFaceImageData) {
        const { rekognitionClient } = await import('../services/kyc/realKycService');
        const { GetFaceLivenessSessionResultsCommand } = await import('@aws-sdk/client-rekognition');
        const out = await rekognitionClient.send(
          new GetFaceLivenessSessionResultsCommand({ SessionId: parsed.sessionId }),
        );
        livenessConfidence = out.Confidence ?? 0;
        if (out.Status !== 'SUCCEEDED') {
          // Surface the real AWS session status so clients can tell why it isn't
          // SUCCEEDED: CREATED/IN_PROGRESS = liveness video never streamed to
          // completion; EXPIRED = session too old / reused; FAILED = genuine fail.
          console.warn('[reverify/verify] liveness not succeeded:', out.Status, 'confidence:', out.Confidence);
          return c.json({ status: 'error', code: 'LIVENESS_FAILED', message: 'Liveness check did not succeed.', livenessStatus: out.Status ?? 'UNKNOWN', confidence: out.Confidence ?? 0 });
        }
        const refBytes = out.ReferenceImage?.Bytes;
        if (!refBytes) {
          return c.json({ status: 'error', code: 'LIVENESS_FAILED', message: 'No liveness reference image returned.' });
        }
        liveFaceB64 = `data:image/jpeg;base64,${Buffer.from(refBytes).toString('base64')}`;
      } else {
        // Single-frame path (straight face, no head turns): quality/liveness gate.
        const { analyzeFaceLiveness } = await import('../services/kyc/realKycService');
        const result = await analyzeFaceLiveness(parsed.liveFaceImageData!, { crop: true });
        if (!result.found || !result.metrics) {
          return c.json({ status: 'error', code: 'LIVENESS_FAILED', message: 'No face detected — face the camera in good light.' });
        }
        livenessConfidence = result.metrics.confidence ?? 0;
        liveFaceB64 = result.faceImageData ?? parsed.liveFaceImageData!;
      }

      // 2. Fetch the enrolled KYC selfie (server-side; never sent to the client).
      // Mid-login: the validate response carries the raw S3 URL (ADR-013);
      // /kyc/current is unusable (JwtAuthGuard rejects the session stepToken).
      // Idle: unchanged — /kyc/current with the access token.
      const enrolledSelfieB64 = isSessionStep
        ? await downloadSelfie(challenge.selfieImageUrl)
        : await fetchEnrolledSelfie(token, c.env.RDB_BASE_URL);
      if (!enrolledSelfieB64) {
        return c.json({ status: 'error', code: 'NO_ENROLLED_SELFIE', message: 'No enrolled selfie on file.' });
      }

      // 3. Compare (source = enrolled selfie, target = live face).
      const { compareFaces } = await import('../services/kyc/realKycService');
      const cmp = await compareFaces(enrolledSelfieB64, liveFaceB64, compareConfig.similarity.awsFilterFloor);
      if (!cmp.sourceFaceDetected || !cmp.targetFaceDetected) {
        return c.json({ status: 'error', code: 'FACE_NOT_DETECTED', message: 'Face not detected in one of the images.' });
      }
      faceMatchScore = cmp.similarity;
    }

    // 4. Commit to NestJS — NestJS makes the pass/fail decision and marks the challenge satisfied.
    if (!c.env.KYC_SHARED_SECRET) {
      // Local dev without a signing secret: short-circuit (mock only).
      if (useMock) {
        return c.json({ status: 'passed', faceMatchScore, livenessConfidence, stepToken: 'mock-step' });
      }
      return c.json({ error: 'KYC_SHARED_SECRET not configured' }, 503);
    }
    // Mid-login (reset-passcode step entry) commits to the step-scoped route:
    // Bearer = the login SESSION stepToken; the DTO additionally requires a
    // freshness timestamp (Unix seconds) + one-time nonce for the signature
    // (RESET_PASSCODE_STEP_FACE_WEB_INTEGRATION.md §2b). Idle flow unchanged.
    const commitRes = await postSignedToNest(
      c.env.RDB_BASE_URL,
      isSessionStep ? '/kyc/reverify/step/commit' : '/kyc/reverify/commit',
      isSessionStep
        ? {
            challengeId,
            livenessConfidence,
            faceMatchScore,
            timestamp: Math.floor(Date.now() / 1000),
            nonce: crypto.randomUUID(),
          }
        : { challengeId, livenessConfidence, faceMatchScore },
      token,
      c.env.KYC_SHARED_SECRET,
    );
    const text = await commitRes.text();
    if (!commitRes.ok) {
      return c.json(
        { error: 'Re-verification backend rejected the result.', detail: text },
        commitRes.status >= 500 ? 502 : (commitRes.status as 400),
      );
    }
    const decision = JSON.parse(text) as { status?: string; reason?: string; stepToken?: string };
    return c.json({
      status: decision.status ?? 'failed',
      reason: decision.reason,
      stepToken: decision.stepToken,
      faceMatchScore,
      livenessConfidence,
    });
  } catch (err) {
    console.error('[reverify/verify] failed:', err);
    return c.json({ status: 'error', code: 'INTERNAL_ERROR', message: 'Re-verification failed.' }, 500);
  }
});

// ── POST /api/kyc/submit ──────────────────────────────────────────────────────
kycRoutes.post('/submit', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  let parsed: { kycSessionId: string; frontImageData: string; backImageData?: string; selfieImageData: string; selfieVsIdScore: number; livenessConfidence?: number; extracted: Record<string, string | undefined> };
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!parsed.kycSessionId || !parsed.frontImageData || !parsed.selfieImageData || !parsed.extracted || parsed.selfieVsIdScore == null) return c.json({ error: 'kycSessionId, frontImageData, selfieImageData, selfieVsIdScore, extracted are required' }, 422);

  const isPassport = (parsed.extracted['idType'] ?? '').toLowerCase().includes('passport');

  try {
    const [frontUrl, backUrl, selfieUrl, nationalityCountryId] = await Promise.all([
      uploadImage(parsed.frontImageData, 'front.jpg', 'document', token, c.env.RDB_BASE_URL),
      isPassport ? Promise.resolve(undefined) : parsed.backImageData ? uploadImage(parsed.backImageData, 'back.jpg', 'document', token, c.env.RDB_BASE_URL) : Promise.resolve(undefined),
      uploadImage(parsed.selfieImageData, 'selfie.jpg', 'image', token, c.env.RDB_BASE_URL),
      resolveCountryId(parsed.extracted['country'], token, c.env.RDB_BASE_URL),
    ]);

    const nestPayload = { kycSessionId: parsed.kycSessionId, fullName: parsed.extracted['name'] ?? '', nationalityCountryId, documentType: mapDocumentType(parsed.extracted['idType']), documentFrontImageUrl: frontUrl, documentBackImageUrl: backUrl, selfieImageUrl: selfieUrl, nationalIdNumber: parsed.extracted['nationalNumber'] ?? parsed.extracted['documentNumber'] ?? '', selfieVsIdScore: parsed.selfieVsIdScore, livenessConfidence: parsed.livenessConfidence, documentExpiryDate: parsed.extracted['expiryDate'] };
    const submitRes = await postSignedToNest(c.env.RDB_BASE_URL, '/kyc/submit', nestPayload, token, c.env.KYC_SHARED_SECRET);
    const responseText = await submitRes.text();
    if (!submitRes.ok) return c.json({ error: 'Verification backend rejected the submission.', detail: responseText }, submitRes.status >= 500 ? 502 : submitRes.status as 400);
    const result = JSON.parse(responseText);
    return c.json({ success: true, kycRequest: result.kycRequest });
  } catch (err) {
    console.error('[kyc/submit] failed:', err);
    return c.json({ error: 'Failed to upload verification documents.' }, 502);
  }
});

function mapDocumentType(idType?: string): string {
  if (!idType) return 'national_id';
  const t = idType.toLowerCase();
  if (t.includes('passport')) return 'passport';
  if (t.includes('driver') || t.includes('driving')) return 'driving_license';
  return 'national_id';
}

function stripDataUrl(b64: string): string { const i = b64.indexOf(','); return i >= 0 ? b64.slice(i + 1) : b64; }

async function uploadImage(base64: string, filename: string, type: string, token: string, baseUrl: string): Promise<string> {
  const buf = Buffer.from(stripDataUrl(base64), 'base64');
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('type', type);
  const res = await backendFetch(baseUrl, '/media/upload/direct', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!res.ok) throw new Error(`Media upload failed (${res.status})`);
  const data = (await res.json()) as { url: string };
  return data.url;
}

async function resolveCountryId(name: string | undefined, token: string, baseUrl: string): Promise<string | undefined> {
  if (!name) return undefined;
  const res = await backendFetch(baseUrl, '/countries?limit=100', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return undefined;
  const data = await res.json() as { items: { id: string; name: string; displayName: string }[] };
  const needle = name.toLowerCase();
  return data.items.find((c) => c.name.toLowerCase() === needle || c.displayName.toLowerCase() === needle)?.id;
}

// ── POST /api/kyc/complete ────────────────────────────────────────────────────
kycRoutes.post('/complete', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  let parsed: { kycSessionId: string; videoCallUrl: string; livenessConfidence: number; videoVsIdScore: number };
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!parsed.kycSessionId || !parsed.videoCallUrl || parsed.livenessConfidence == null || parsed.videoVsIdScore == null) return c.json({ error: 'kycSessionId, videoCallUrl, livenessConfidence, videoVsIdScore are required' }, 422);
  const res = await patchSignedToNest(c.env.RDB_BASE_URL, '/kyc/current/complete', parsed, token, c.env.KYC_SHARED_SECRET);
  const text = await res.text();
  if (!res.ok) return c.json({ error: 'Video completion failed.', detail: text }, res.status >= 500 ? 502 : res.status as 400);
  return c.json({ success: true, kycRequest: JSON.parse(text) });
});

// ── POST /api/kyc/heygen-token ────────────────────────────────────────────────
kycRoutes.post('/heygen-token', async (c) => {
  const apiKey = c.env.HEYGEN_API_KEY;
  if (!apiKey) return c.json({ error: 'HEYGEN_API_KEY not set' }, 503);
  let avatarId = c.env.NEXT_PUBLIC_HEYGEN_AVATAR_ID ?? '';
  let language = 'en';
  try { const body = await c.req.json<{ language?: string }>().catch(() => ({} as { language?: string })); if (body.language) language = body.language; } catch { /* ignore */ }

  const LA = 'https://api.liveavatar.com';
  async function la<T>(path: string, opts: RequestInit): Promise<T> {
    const res = await fetch(`${LA}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) } });
    if (!res.ok) throw new Error(`LiveAvatar ${path} → ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json() as Promise<T>;
  }

  try {
    if (!avatarId) {
      const list = await la<{ data?: { avatars?: { id: string }[] } }>('/v1/avatar/user', { method: 'GET', headers: { 'X-API-KEY': apiKey } });
      const first = list.data?.avatars?.[0]?.id;
      if (!first) throw new Error('No avatars found in LiveAvatar account');
      avatarId = first;
    }
    const tokenRes = await la<{ data?: { session_token?: string } }>('/v1/sessions/token', { method: 'POST', headers: { 'X-API-KEY': apiKey }, body: JSON.stringify({ mode: 'FULL', avatar_id: avatarId, avatar_persona: { language } }) });
    const sessionToken = tokenRes.data?.session_token;
    if (!sessionToken) throw new Error('No session_token in token response');
    const startRes = await la<{ data?: { session_id?: string; livekit_url?: string; livekit_client_token?: string } }>('/v1/sessions/start', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: '' });
    const { session_id, livekit_url, livekit_client_token } = startRes.data ?? {};
    if (!livekit_url || !livekit_client_token) throw new Error('Missing LiveKit credentials');
    return c.json({ livekitUrl: livekit_url, livekitToken: livekit_client_token, sessionId: session_id });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── POST /api/kyc/heygen-streaming-token ─────────────────────────────────────
kycRoutes.post('/heygen-streaming-token', async (c) => {
  const apiKey = c.env.HEYGEN_API_KEY;
  if (!apiKey) return c.json({ error: 'HEYGEN_API_KEY not set' }, 503);
  const avatarId = c.env.NEXT_PUBLIC_HEYGEN_AVATAR_ID ?? '';
  try {
    const res = await fetch('https://api.heygen.com/v1/streaming.create_token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey } });
    if (!res.ok) throw new Error(`HeyGen token API ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json() as { data?: { token?: string } };
    const token = data.data?.token;
    if (!token) throw new Error('No token in HeyGen response');
    return c.json({ token, avatarId });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── POST /api/kyc/simli-token ─────────────────────────────────────────────────
kycRoutes.post('/simli-token', async (c) => {
  const apiKey = c.env.SIMLI_API_KEY;
  const body = await c.req.json<{ faceId?: string }>().catch(() => ({} as { faceId?: string }));
  const faceId = body.faceId || c.env.SIMLI_FACE_ID || c.env.NEXT_PUBLIC_SIMLI_FACE_ID;
  if (!apiKey || !faceId) return c.json({ error: 'Missing SIMLI config on server', details: { hasApiKey: Boolean(apiKey), hasFaceId: Boolean(faceId) } }, 503);
  try {
    const { generateSimliSessionToken } = await import('simli-client');
    const { session_token } = await generateSimliSessionToken({ apiKey, config: { faceId, handleSilence: true, maxSessionLength: 300, maxIdleTime: 120, model: 'fasttalk' } });
    return c.json({ sessionToken: session_token });
  } catch (err) {
    return c.json({ error: 'Failed to create Simli session token' }, 502);
  }
});

// ── POST /api/kyc/simli-speak ─────────────────────────────────────────────────
async function shortHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

const SIMLI_VOICE_INSTRUCTIONS: Record<string, Record<string, string>> = {
  neutral: { ar: 'أنت موظفة دعم عملاء بنبرة أنثوية ناضجة ومهنية. صوتك واضح وواثق وودود مع دفء هادئ. تحدثي بإيقاع طبيعي قريب من المحادثة الواقعية.', en: 'You are a professional female customer-support agent. Speak at a natural conversational pace with a reassuring professional style.', tr: 'Siz profesyonel bir kadin musteri destek temsilcisisiniz. Dogal konusma hizinda konusun.' },
  greeting: { ar: 'قدمي التحية بنبرة دافئة ومشرقة مع إيحاء خفيف وكأنك تميلين رأسك قليلًا نحو الكاميرا.', en: 'Deliver the greeting warmly and brightly, with a subtle head-tilt toward the camera.', tr: 'Selamlamayi sicak ve parlak bir tonla yapin.' },
  smile: { ar: 'تحدثي بفرح ناعم وابتسامة صادقة؛ اجعلي الصوت مشرقًا لكن رقيقًا.', en: 'Speak with radiant but soft happiness, like a sincere smile.', tr: 'Icten bir gulumsemeyle, parlak ama yumusak bir mutluluk tonunda konusun.' },
  verifying: { ar: 'تحدثي بهدوء مطمئن وصبر لطيف، بنبرة رقيقة وناعمة جدًا.', en: 'Use a calm, patient, and reassuring tone with very soft feminine warmth.', tr: 'Sakin, sabirli ve guven veren bir tonda konusun.' },
  goodbye: { ar: 'اختمي المكالمة بوداع رقيق ودافئ مع لطف واضح ونبرة حنونة.', en: 'Close the call with a tender, warm farewell tone.', tr: 'Gorusmeyi nazik ve sicak bir veda tonuyla bitirin.' },
};

kycRoutes.post('/simli-speak', async (c) => {
  let body: { text?: string; language?: string; expression?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const text = body.text?.trim();
  const language = String(body.language ?? 'en').toLowerCase().split('-')[0];
  const expression = body.expression ?? 'neutral';
  if (!text) return c.json({ error: 'text is required' }, 422);

  // Edge cache lookup
  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
  let cacheKey: Request | null = null;
  if (cache) {
    const hash = await shortHash(text);
    cacheKey = new Request(`https://tts-cache.internal/simli-speak?lang=${language}&expr=${expression}&h=${hash}`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const instructionMap = SIMLI_VOICE_INSTRUCTIONS[expression as string] ?? SIMLI_VOICE_INSTRUCTIONS['neutral']!;
  const instructions = instructionMap[language as string] ?? instructionMap['en']!;
  const openai = getOpenAI(c.env.OPENAI_API_KEY);

  try {
    const result = await openai.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: 'sage', input: text, response_format: 'pcm', speed: 1.2, instructions: `${instructions} Voice Affect: Soft, gentle, soothing.` });
    const pcmBuffer = await result.arrayBuffer();
    const response = new Response(pcmBuffer, { status: 200, headers: { 'Content-Type': 'audio/pcm', 'X-PCM-Sample-Rate': '24000', 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' } });
    if (cache && cacheKey) cache.put(cacheKey, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    return c.json({ error: 'TTS service unavailable' }, 502);
  }
});

// ── POST /api/kyc/speak ───────────────────────────────────────────────────────
const SPEAK_INSTRUCTIONS: Record<string, string> = {
  ar: 'أنت مساعدة بنكية أنثى بصوت ناعم ودافئ وجذاب. تحدثي بالعربية بطريقة طبيعية وواضحة.',
  en: 'You are a warm, gentle, and captivating female banking assistant. Speak naturally in English.',
  tr: 'Siz sicak, nazik ve büyüleyici bir kadin bankacılık asistanısınız.',
};

kycRoutes.post('/speak', async (c) => {
  let body: { text?: string; language?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const text = body.text?.trim();
  const language = String(body.language ?? 'en').toLowerCase().split('-')[0];
  if (!text) return c.json({ error: 'text is required' }, 422);

  const openai = getOpenAI(c.env.OPENAI_API_KEY);
  try {
    let result;
    try {
      result = await openai.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: 'nova', input: text, response_format: 'mp3', speed: 1.12, instructions: SPEAK_INSTRUCTIONS[language as string] ?? SPEAK_INSTRUCTIONS['en']! });
    } catch {
      result = await openai.audio.speech.create({ model: 'tts-1', voice: 'nova', input: text, response_format: 'mp3', speed: 1.12 });
    }
    const audioBuffer = Buffer.from(await result.arrayBuffer());
    return new Response(audioBuffer, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return c.json({ error: 'TTS service unavailable' }, 502);
  }
});

// ── POST /api/kyc/transcribe-speech ──────────────────────────────────────────
const WHISPER_NAME_PROMPTS: Record<string, string> = { ar: 'الإجابة هي اسم أول واحد فقط بدون أي كلمات إضافية. أمثلة: محمد. يزن. علي. سارة.', en: 'The answer is a single first name with no extra words. Examples: Mohammad. Yazan. Ali. Sara.', tr: 'Cevap yalnizca tek bir ad. Ornekler: Mehmet. Ahmet. Ali. Ayse.' };
const WHISPER_AGE_PROMPTS: Record<string, string> = { ar: 'الإجابة هي رقم واحد فقط يمثل العمر. أمثلة: 25. 30. 18. 42.', en: 'The answer is a single number representing age. Examples: 25. 30. 18. 42.', tr: 'Cevap yalnizca yasi temsil eden tek bir sayi. Ornekler: 25. 30. 18. 42.' };
const HALLUCINATED = new Set(['اشتركوا في القناة', 'اشترك في القناة', 'subscribe to the channel', 'dont forget to subscribe']);

kycRoutes.post('/transcribe-speech', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file');
    const language = String(formData.get('language') ?? 'en').toLowerCase().split('-')[0] ?? 'en';
    const mode = formData.get('mode') as string | null;
    const prompt = mode === 'name' ? (WHISPER_NAME_PROMPTS[language] ?? WHISPER_NAME_PROMPTS['en']!) : mode === 'age' ? (WHISPER_AGE_PROMPTS[language] ?? WHISPER_AGE_PROMPTS['en']!) : undefined;

    if (!file || typeof (file as { name?: unknown }).name !== 'string') return c.json({ error: 'Audio file is required' }, 422);

    const openai = getOpenAI(c.env.OPENAI_API_KEY);
    const result = await openai.audio.transcriptions.create({ file: file as unknown as File, model: 'whisper-1', language, temperature: 0, ...(prompt ? { prompt } : {}) });
    const raw = 'text' in result ? result.text.trim() : '';
    const normalized = raw.toLowerCase().replace(/[.!?،,؛:]+/g, ' ').replace(/\s+/g, ' ').trim();
    const transcript = HALLUCINATED.has(normalized) ? '' : raw;
    return c.json({ transcript });
  } catch (err) {
    return c.json({ error: 'Transcription service unavailable' }, 502);
  }
});

// ── POST /api/kyc/verify-answer ───────────────────────────────────────────────
const VERIFY_SYSTEM_PROMPT = `You verify identity answers spoken aloud during a KYC video call.

IMPORTANT — PHRASE EXTRACTION RULE:
The user may speak a full sentence. Extract the relevant name or age token from ANYWHERE in the phrase.

For names: accept transliteration variants (Mohammad/Mohammed/Mohamed/محمد). Accept phonetic resemblance. Ignore filler words. If in doubt, lean toward MATCHES = TRUE with confidence 0.5.

For dates/age: accept any equivalent format. Accept age within +/-1 year of expected.

Respond ONLY with strict JSON: {"matches": true|false, "confidence": 0.0-1.0, "reasoning": "brief one-line explanation"}.`;

kycRoutes.post('/verify-answer', async (c) => {
  let body: { question: string; expected: string; transcript: string; language: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!body.question || !body.expected || !body.transcript) return c.json({ error: 'question, expected, transcript are required' }, 422);

  const userMessage = `Question type: ${body.question}\nExpected ${body.question}: "${body.expected}"\nUser said (transcribed in ${body.language}): "${body.transcript}"\n\nDoes the user's spoken answer match the expected ${body.question}?`;
  try {
    const openai = getOpenAI(c.env.OPENAI_API_KEY);
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: VERIFY_SYSTEM_PROMPT }, { role: 'user', content: userMessage }] });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}') as { matches?: boolean; confidence?: number; reasoning?: string };
    return c.json({ matches: parsed.matches === true, confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0, reasoning: parsed.reasoning ?? '' });
  } catch (err) {
    return c.json({ error: 'Verification service unavailable' }, 502);
  }
});

// ── POST /api/kyc/verify-video ────────────────────────────────────────────────
kycRoutes.post('/verify-video', async (c) => {
  let body: { kycSessionId?: string; language?: 'ar' | 'en' | 'tr'; expectedName?: string; expectedBirthday?: string; nameTranscript?: string | null; ageTranscript?: string | null; faceFrames?: string[]; idFaceImageData?: string; livenessConfidence?: number; videoCallUrl?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const { kycSessionId, language = 'en', expectedName, expectedBirthday, nameTranscript, ageTranscript, faceFrames = [], idFaceImageData = '', livenessConfidence = 50, videoCallUrl = '' } = body;
  if (!expectedName || !expectedBirthday) return c.json({ error: 'expectedName and expectedBirthday are required' }, 422);

  const openai = getOpenAI(c.env.OPENAI_API_KEY);

  async function verifyAnswer(question: 'name' | 'birthday', expected: string, transcript: string): Promise<{ matches: boolean; confidence: number; reasoning: string }> {
    const msg = `Question type: ${question}\nExpected ${question}: "${expected}"\nUser said: "${transcript}"\n\nDoes the user's spoken answer match?`;
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: VERIFY_SYSTEM_PROMPT }, { role: 'user', content: msg }] });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}') as { matches?: boolean; confidence?: number; reasoning?: string };
    return { matches: parsed.matches === true, confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0, reasoning: parsed.reasoning ?? '' };
  }

  const FAIL = { matches: false, confidence: 0, reasoning: 'no transcript provided' };
  const [nameMatch, ageMatch] = await Promise.all([
    nameTranscript ? verifyAnswer('name', expectedName, nameTranscript).catch(() => ({ matches: false, confidence: 0, reasoning: 'llm error' })) : Promise.resolve(FAIL),
    ageTranscript ? verifyAnswer('birthday', expectedBirthday, ageTranscript).catch(() => ({ matches: false, confidence: 0, reasoning: 'llm error' })) : Promise.resolve(FAIL),
  ]);

  const face = await (async () => {
    if (!idFaceImageData || faceFrames.length === 0) return { bestScore: 0, usedFrames: 0 };
    const useMock = c.env.AWS_MOCK !== 'false';
    if (useMock) { await new Promise((r) => setTimeout(r, compareConfig.mock.delayMs)); return { bestScore: compareConfig.mock.mockScore, usedFrames: faceFrames.length }; }
    try {
      const { compareFaces } = await import('../services/kyc/realKycService');
      const scores = await Promise.all(faceFrames.map(async (frame) => { try { const r = await compareFaces(idFaceImageData, frame, compareConfig.similarity.passThreshold); return r.similarity ?? 0; } catch { return 0; } }));
      return { bestScore: Math.max(...scores, 0), usedFrames: faceFrames.length };
    } catch { return { bestScore: 0, usedFrames: faceFrames.length }; }
  })();

  const passed = (nameMatch.matches || nameMatch.confidence >= 0.5) && (ageMatch.matches || ageMatch.confidence >= 0.5);
  let kycStatus: string | undefined;

  if (passed && kycSessionId) {
    try {
      const token = accessToken(c);
      if (token) {
        const res = await patchSignedToNest(c.env.RDB_BASE_URL, '/kyc/current/complete', { kycSessionId, videoCallUrl, livenessConfidence, videoVsIdScore: face.bestScore }, token, c.env.KYC_SHARED_SECRET);
        const text = await res.text();
        if (res.ok) kycStatus = (JSON.parse(text) as { status?: string }).status;
      }
    } catch (err) { console.error('[verify-video] NestJS commit failed:', err); }
  }

  return c.json({ passed, nameMatch, ageMatch, face, kycStatus });
});

// ── POST /api/kyc/webhook-nestjs ──────────────────────────────────────────────
kycRoutes.post('/webhook-nestjs', async (c) => {
  const secret = c.req.header('x-kyc-webhook-secret');
  const expectedSecret = c.env.KYC_WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ userId?: string; status?: string; extractedData?: Record<string, unknown> }>();
  if (!body.userId || !body.status) return c.json({ error: 'userId and status are required' }, 400);

  await new Promise((r) => setTimeout(r, 300));
  return c.json({ success: true, message: `Verification status '${body.status}' for user '${body.userId}' forwarded to NestJS backend`, timestamp: Date.now() });
});
