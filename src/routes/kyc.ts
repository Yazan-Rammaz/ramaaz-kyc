import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../index';
import { backendFetch } from '../lib/backendFetch';
import { getOpenAI } from '../lib/openai';
import { postSignedToNest, patchSignedToNest } from '../lib/kycSigning';
import { compareConfig, faceConfig, idConfig } from '../config/kycConfig';
import type { AnalyzeIdResult, AnalyzeIdCode } from '../services/kyc/kycService.interface';
import { resolveTenant, TenantNotConfiguredError, type TenantConfig } from '../lib/tenant';

export const kycRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant: TenantConfig };
}>();

/**
 * Resolve the tenant once, before any route runs.
 *
 * Every route below reads `c.get('tenant')` rather than any `c.env` binding, so
 * a base URL can never be paired with another tenant's signing secret — see
 * lib/tenant.ts. A request with no tenant header resolves to RDB, which is what
 * every existing client sends.
 */
kycRoutes.use('*', async (c, next) => {
  try {
    c.set('tenant', resolveTenant(c));
  } catch (err) {
    if (err instanceof TenantNotConfiguredError) {
      // A deployment problem, not a caller problem — say so plainly instead of
      // falling through to the other tenant's backend with these credentials.
      console.error('[tenant]', err.message);
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }
  await next();
});

/**
 * Access token for the onboarding routes. Web sends it as the tenant's access
 * cookie; native clients (Flutter) without a cookie jar send
 * `Authorization: Bearer`. Bearer wins so a stale copied cookie can never
 * shadow a fresh native token.
 */
function accessToken(c: Context<{ Bindings: Env; Variables: { tenant: TenantConfig } }>): string {
  const h = c.req.header('Authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return getCookie(c, c.get('tenant').cookies.access) ?? '';
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
        const extractedData: AnalyzeIdResult['extractedData'] = { idType: ext.idType ?? '', idName: ext.idType ?? '', country: ext.country ?? '', countryIso3: ext.countryIso3, name: ext.name ?? '', nationalNumber: ext.nationalNumber ?? '', birthday: ext.birthday ?? '', firstName: ext.firstName, lastName: ext.lastName, documentNumber: isPassport ? ext.passportNumber : ext.documentNumber, expiryDate: ext.expiryDate, rawText: ext.rawText };
        return c.json({ status: 'success', nextStep: isPassport ? 'COMPLETE' : 'REQUIRE_BACK', croppedImageData: cropped, idFaceImageData: result.idFaceImageData, side: 'front', extracted: ext, extractedData, found: true } satisfies AnalyzeIdResult);
      }

      const rawBack = ext.rawText ?? '';
      const hasContent = /<{5,}/.test(rawBack) || !!ext.address || !!ext.documentNumber || !!ext.nationalNumber || rawBack.length >= 30;
      if (!hasContent) return c.json({ status: 'error', code: 'MISSING_CRITICAL_DATA', message: 'ID not clearly readable. Hold the card flat, well-lit, and try again.', side: 'back', found: false } satisfies AnalyzeIdResult);
      return c.json({ status: 'success', nextStep: 'COMPLETE', croppedImageData: cropped, side: 'back', extracted: ext, extractedData: { idType: ext.idType ?? '', idName: ext.idType ?? '', country: ext.country ?? '', countryIso3: ext.countryIso3, name: ext.name ?? '', nationalNumber: ext.nationalNumber ?? '', birthday: ext.birthday ?? '', firstName: ext.firstName, lastName: ext.lastName, documentNumber: ext.documentNumber, expiryDate: ext.expiryDate, rawText: ext.rawText }, found: true } satisfies AnalyzeIdResult);
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
  const mockExtracted = { idType: 'Personal Identity ID', idName: 'Personal Identity ID', country: 'Syria', countryIso3: 'SYR', name: 'Mohammad De Bruijn', firstName: 'Mohammad', lastName: 'De Bruijn', nationalNumber: '09982111123332', documentNumber: '09982111123332', birthday: '01.01.1999', expiryDate: '01.01.2030' };
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

// ── The liveness bench: /api/kyc/liveness-lab/* ──────────────────────────────
//
// Runs Rekognition Face Liveness on its own so the check can be attacked
// repeatedly — printed photo, phone screen, video replay, mask — without
// walking a whole sign-in between attempts. Testing anti-spoofing means dozens
// of tries, and a bench that costs a full login per try does not get used.
//
// ── Why this cannot become a way in ─────────────────────────────────────────
// It is not a bypass of the real endpoints; it is a parallel set that stops
// short of everything that matters. It NEVER:
//
//   · looks at a challenge, a session, a cookie or a token
//   · returns the reference image, or any image
//   · calls CompareFaces, or reads the enrolled selfie
//   · commits anything to NestJS, or mints a stepToken
//
// All it can produce is a status and a number. There is no code path from here
// to being signed in, because nothing here touches the thing that signs people
// in. Compare `/reverify/verify`, which does all four.
//
// Locked behind `LIVENESS_LAB_SECRET`. Unset — which is the default, and the
// production default — and every route below 404s. Not 401: a 401 confirms
// there is something here to unlock.
//
// ⚠️ It does spend money. Each run is one Face Liveness check ($0.015).
function labUnlocked(c: Context<{ Bindings: Env; Variables: { tenant: TenantConfig } }>) {
  const expected = c.env.LIVENESS_LAB_SECRET;
  if (!expected) return false;
  return c.req.header('X-Liveness-Lab') === expected;
}

kycRoutes.post('/liveness-lab/session', async (c) => {
  if (!labUnlocked(c)) return c.json({ error: 'Not found' }, 404);
  try {
    const { awsRegion, rekognitionClient } = await import('../services/kyc/realKycService');
    const { CreateFaceLivenessSessionCommand } = await import('@aws-sdk/client-rekognition');
    const out = await rekognitionClient.send(new CreateFaceLivenessSessionCommand({}));
    if (!out.SessionId) throw new Error('AWS did not return a liveness session ID');
    return c.json({ sessionId: out.SessionId, region: awsRegion });
  } catch (err) {
    console.error('[liveness-lab] session failed', err);
    return c.json({ error: 'Session creation failed' }, 500);
  }
});

kycRoutes.get('/liveness-lab/credentials', async (c) => {
  if (!labUnlocked(c)) return c.json({ error: 'Not found' }, 404);
  // The same scoped, fifteen-minute credentials the real flow gets. The bench
  // is not a reason to hand out anything wider.
  return livenessCredentials(c);
});

kycRoutes.get('/liveness-lab/result', async (c) => {
  if (!labUnlocked(c)) return c.json({ error: 'Not found' }, 404);
  const sessionId = c.req.query('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
  try {
    const { rekognitionClient } = await import('../services/kyc/realKycService');
    const { GetFaceLivenessSessionResultsCommand } = await import('@aws-sdk/client-rekognition');
    const out = await rekognitionClient.send(
      new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }),
    );
    // Status and confidence ONLY.
    //
    // The reference image is deliberately withheld even here. Returning it
    // would make this endpoint a way to obtain a photograph of whoever last
    // stood in front of the camera, and the bench has no need of it: the
    // question being asked is "did AWS think that was a live person", and the
    // number answers it.
    //
    // Note what a spoof usually looks like: SUCCEEDED with a LOW confidence.
    // The session completed; the verdict is simply "not live". A gate that only
    // checks Status will let it through — which is exactly what the real
    // Worker path does today, and what this bench exists to expose.
    return c.json({
      status: out.Status ?? 'UNKNOWN',
      confidence: out.Confidence ?? 0,
      hasReferenceImage: Boolean(out.ReferenceImage?.Bytes),
      auditImages: out.AuditImages?.length ?? 0,
    });
  } catch (err) {
    console.error('[liveness-lab] result failed', err);
    return c.json({ error: 'Results fetch failed' }, 500);
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

  const validateRes = await backendFetch(c.get('tenant').baseUrl, `/kyc/sessions/${kycSessionId}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': c.get('tenant').internalSecret },
    body: JSON.stringify({ userId: currentUserId }),
  });
  if (!validateRes.ok) return c.json({ error: 'Invalid or expired KYC session' }, 401);

  return livenessCredentials(c);
});

/**
 * Browser credentials for the Amplify FaceLivenessDetector — scoped to one
 * action and fifteen minutes.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * Both credential endpoints used to return `c.env.AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` verbatim: the worker's own long-lived IAM user keys,
 * the same pair realKycService signs Textract and Rekognition with. Handing
 * those to a browser gives whoever holds them everything that identity can do,
 * from anywhere, until somebody rotates the key. The liveness component does
 * need credentials in the browser. It does not need THOSE credentials.
 *
 * ── Why GetFederationToken ──────────────────────────────────────────────────
 * It re-signs the same identity down to an inline session policy, and such a
 * policy can only ever grant a SUBSET of what the caller already holds — so
 * this cannot widen access even if the policy below is wrong. What comes back
 * can open one liveness stream and nothing else: no Textract, no S3, no other
 * Rekognition call. It expires in fifteen minutes, the floor this API allows.
 *
 * AssumeRole would be the alternative, but it needs a role to exist first;
 * GetFederationToken works directly from the IAM user keys already configured,
 * so this is a code change rather than an AWS change.
 *
 * ⚠️ ROTATE `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. They were returned
 * by a deployed endpoint, so treat them as disclosed even though no caller is
 * known.
 */
async function livenessCredentials(
    c: Context<{ Bindings: Env; Variables: { tenant: TenantConfig } }>,
) {
  const region = c.env.AWS_REGION || 'us-east-1';
  const accessKeyId = c.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = c.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return c.json({ error: 'AWS credentials are not configured' }, 500);
  }

  try {
    // ── Signed by hand, because STS speaks XML and workerd has no DOM ───────
    //
    // `@aws-sdk/client-sts` cannot run here. Rekognition is a JSON protocol and
    // deserialises fine; STS is a query protocol that answers in XML, and in a
    // Worker the bundler resolves the SDK's *browser* build, whose XML
    // deserialiser wants DOM globals. Polyfilling them is a losing game — it
    // asked for `DOMParser`, then for `Node`, and each round costs a deploy to
    // discover the next one. The failure also disguises itself: a
    // `ReferenceError` wrapped in "Deserialization error", arriving as a plain
    // 500 AFTER AWS has already issued the credentials, which reads exactly
    // like a permissions problem and is not one.
    //
    // So this signs the request itself. `aws4fetch` is SigV4 built for Workers
    // — WebCrypto, no Node shims, a few KB — and the response is small enough
    // that four regexes beat pulling in an XML parser.
    const { AwsClient } = await import('aws4fetch');
    const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: 'sts' });

    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['rekognition:StartFaceLivenessSession'],
          // The streaming API carries its session id in the request, not in an
          // ARN, so there is no narrower resource to name. The session id is
          // the second lock: minted server-side, and single use.
          Resource: '*',
        },
      ],
    });

    const body = new URLSearchParams({
      Action: 'GetFederationToken',
      Version: '2011-06-15',
      // 2–32 chars. Appears in CloudTrail as the federated principal, so it is
      // worth being recognisable.
      Name: 'kyc-face-liveness',
      DurationSeconds: '900',
      Policy: policy,
    });

    const res = await aws.fetch(`https://sts.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const xml = await res.text();

    if (!res.ok) {
      // STS puts a machine-readable <Code> in its error body. Surfacing that
      // beats a bare 500 — AccessDenied and InvalidClientTokenId call for
      // completely different fixes.
      const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? `HTTP ${res.status}`;
      console.error('[liveness] STS refused:', code);

      // ── On AccessDenied, say WHO was denied ──────────────────────────────
      //
      // "AccessDenied" alone does not tell you which IAM identity to attach a
      // policy to, and a worker's credentials are not something you can read
      // off the console — they are a secret. GetCallerIdentity needs no
      // permissions at all, by design, so it answers that even while everything
      // else is refused. The reply is the account and the caller ARN, both of
      // which the operator already knows they own; it grants nothing.
      let identity: Record<string, string> | undefined;
      if (code === 'AccessDenied') {
        try {
          const who = await aws.fetch(`https://sts.${region}.amazonaws.com/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'Action=GetCallerIdentity&Version=2011-06-15',
          });
          const idXml = await who.text();
          const grab = (tag: string) =>
            new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(idXml)?.[1];
          const account = grab('Account');
          identity = {
            arn: grab('Arn') ?? 'unknown',
            account: account ?? 'unknown',
            // The exact resource the policy must name. It has to match the
            // `Name` sent above, and a mismatch here denies just like a missing
            // policy does.
            needs: account
              ? `sts:GetFederationToken on arn:aws:sts::${account}:federated-user/kyc-face-liveness`
              : 'sts:GetFederationToken on the federated-user ARN',
          };
        } catch {
          // Best effort. The code alone is still worth returning.
        }
      }

      // The <Message> for AccessDenied, and only for AccessDenied.
      //
      // STS spells out WHY in a way the code alone cannot: "no identity-based
      // policy allows the sts:GetFederationToken action" means the policy is
      // absent or on the wrong principal, while "with an explicit deny in a
      // service control policy" or "…in a permissions boundary" means the
      // policy is there and something above it is overriding — completely
      // different fixes, indistinguishable from `AccessDenied` on its own.
      //
      // Safe to return here: this message describes the caller's own IAM
      // configuration and the action attempted. Other service errors keep their
      // messages hidden, because those can quote request contents.
      const why = code === 'AccessDenied' ? /<Message>([^<]+)<\/Message>/.exec(xml)?.[1] : undefined;

      return c.json({ error: 'Could not issue liveness credentials', code, identity, why }, 500);
    }

    const pick = (tag: string) =>
      new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1];
    const accessKey = pick('AccessKeyId');
    const secret = pick('SecretAccessKey');
    const sessionToken = pick('SessionToken');
    const expiration = pick('Expiration');

    if (!accessKey || !secret || !sessionToken) {
      console.error('[liveness] STS response missing credentials');
      return c.json({ error: 'STS did not return credentials' }, 500);
    }

    return c.json({
      accessKeyId: accessKey,
      secretAccessKey: secret,
      sessionToken,
      expiration,
    });
  } catch (err) {
    console.error('[liveness] STS federation failed', err);
    // The AWS error NAME comes back with the 500 — `AccessDenied`,
    // `InvalidClientTokenId`, `ValidationError`. A name is a fact about
    // configuration, not a secret, and without it this endpoint fails
    // identically for a missing IAM permission, a wrong key and a deserialiser
    // that cannot run in workerd. That ambiguity already cost two deploys.
    // The message is deliberately not included: it can quote request contents.
    const code = err instanceof Error ? err.name : 'UnknownError';
    // For a ReferenceError or TypeError the message is "X is not defined" —
    // a fact about this runtime, not about the request — so it is safe to
    // return and is the only thing that identifies which global is missing.
    // AWS service errors keep their message hidden: those can quote request
    // contents.
    const detail =
      err instanceof ReferenceError || err instanceof TypeError ? err.message : undefined;
    return c.json({ error: 'Could not issue liveness credentials', code, detail }, 500);
  }
}

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
    const res = await backendFetch(c.get('tenant').baseUrl, '/kyc/sessions/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
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
    const res = await backendFetch(c.get('tenant').baseUrl, '/kyc/status', { headers: { Authorization: `Bearer ${token}` } });
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
    const res = await backendFetch(c.get('tenant').baseUrl, '/kyc/current', { headers: { Authorization: `Bearer ${token}` } });
    const kycRequest = res.status === 404 ? null : await res.json().catch(() => null);
    const isProduction = c.env.ENVIRONMENT === 'production';
    const existing = getCookie(c, `${c.get('tenant').id}_user`);
    if (existing) {
      try {
        const user = JSON.parse(existing);
        setCookie(c, `${c.get('tenant').id}_user`, JSON.stringify({ ...user, kycRequest: kycRequest ?? null }), { httpOnly: true, secure: isProduction, sameSite: 'Strict', expires: new Date(Date.now() + 24 * 60 * 60 * 1000), path: '/' });
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
function reverifyAuth(
  c: Context<{ Bindings: Env; Variables: { tenant: TenantConfig } }>,
): { token: string; isSessionStep: boolean } {
  // Native mid-login (reset-passcode): Flutter has no cookie jar, so the login
  // SESSION stepToken rides an explicit header. Checked first — sending it as a
  // plain Bearer would be mistaken for an access token, and the enrolled-selfie
  // fetch via GET /kyc/current would 401 → NO_ENROLLED_SELFIE.
  const step = c.req.header('X-Step-Token');
  if (step) return { token: step, isSessionStep: true };
  const h = c.req.header('Authorization');
  if (h && h.startsWith('Bearer ')) return { token: h.slice(7), isSessionStep: false };
  const at = getCookie(c, c.get('tenant').cookies.access);
  if (at) return { token: at, isSessionStep: false };
  const stepCookie = getCookie(c, c.get('tenant').cookies.step);
  if (stepCookie) return { token: stepCookie, isSessionStep: true };
  return { token: '', isSessionStep: false };
}

function reverifyToken(
  c: Context<{ Bindings: Env; Variables: { tenant: TenantConfig } }>,
): string {
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
  // ── Every failure below collapses into the same `{valid:false}` ──────────
  // …which the caller reports as "Invalid or expired re-verification
  // challenge". That single message therefore covers: the endpoint not
  // existing, a rejected internal secret, an unreachable backend, and a
  // genuine refusal — the commonest being a challenge that has not reached
  // FACE_REQUIRED yet.
  //
  // Collapsing them for the CLIENT is right: distinguishing them would let a
  // caller learn whether a challenge id is real. Collapsing them SILENTLY is
  // not — it left an integration with one indistinguishable message and no way
  // to tell a missing endpoint from a working one saying no. So each cause is
  // named here, in logs only operators can read.
  try {
    const res = await backendFetch(baseUrl, `/kyc/reverify/${challengeId}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
      console.warn(
        `[reverify] validate → ${res.status} for challenge ${challengeId}` +
          (res.status === 404
            ? ' (endpoint not implemented on this backend?)'
            : res.status === 401 || res.status === 403
              ? ' (X-Internal-Secret rejected — does it match the backend?)'
              : ''),
      );
      return { valid: false, selfieImageUrl: null };
    }
    // `valid !== false` keeps pre-ADR-013 backends (empty/`ok`-only bodies) valid.
    const body = (await res.json().catch(() => ({}))) as {
      valid?: boolean;
      selfieImageUrl?: string | null;
    };
    if (body.valid === false) {
      console.warn(
        `[reverify] validate refused challenge ${challengeId}` +
          ' (wrong stage, expired, or already spent)',
      );
    } else if (!body.selfieImageUrl) {
      // Valid, but nothing to compare against. The Worker then falls back to
      // GET /kyc/current, which cannot work mid-login — and that surfaces much
      // later as NO_ENROLLED_SELFIE, far from the cause.
      console.warn(
        `[reverify] validate passed challenge ${challengeId} but returned no selfieImageUrl`,
      );
    }
    return { valid: body.valid !== false, selfieImageUrl: body.selfieImageUrl ?? null };
  } catch (err) {
    console.warn(`[reverify] validate could not reach ${baseUrl}:`, err);
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

  const challenge = await validateReverifyChallenge(c.get('tenant').baseUrl, challengeId, userId, c.get('tenant').internalSecret);
  if (!challenge.valid) return c.json({ error: 'Invalid or expired re-verification challenge' }, 401);

  try {
    const { awsRegion, rekognitionClient } = await import('../services/kyc/realKycService');
    const { CreateFaceLivenessSessionCommand } = await import('@aws-sdk/client-rekognition');
    const out = await rekognitionClient.send(new CreateFaceLivenessSessionCommand({
        /**
         * Ask AWS to keep a few frames besides the reference image.
         *
         * ⚠️ `AuditImages` is EMPTY unless this is set — it is not a thing you
         * can start reading after the fact, it has to be requested when the
         * session is created. Without it there is exactly one image in the
         * result, and a session that comes back SUCCEEDED with no
         * `ReferenceImage.Bytes` has nothing left to fall back on and dead-ends
         * the whole sign-in. That happened.
         *
         * The fallback matters more than it sounds: an audit frame is still
         * FETCHED SERVER-SIDE FROM AWS, never uploaded by the browser, so the
         * property that actually carries the security — a tampered client
         * cannot choose which face gets compared — survives using one. It is a
         * sampled frame rather than the one AWS judged best, so it is second
         * choice for the stored record and far better than no record.
         *
         * Scoped to THIS route deliberately. /liveness-lab/session never
         * returns an image by design, and /liveness-aws is RDB's.
         */
        Settings: { AuditImagesLimit: 4 },
      }));
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

  const challenge = await validateReverifyChallenge(c.get('tenant').baseUrl, challengeId, userId, c.get('tenant').internalSecret);
  if (!challenge.valid) return c.json({ error: 'Invalid or expired re-verification challenge' }, 401);

  // Same short-lived, single-action credentials as the other path — see
  // livenessCredentials(). This endpoint returned the worker's raw IAM keys too.
  return livenessCredentials(c);
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

  // ── The single-frame path is a privilege, not a fallback ───────────────────
  //
  // Below, an image WINS over a sessionId whenever both are present. That is
  // deliberate for RDB's Flutter client, and it means a tenant that can send an
  // image never has to pass the liveness check at all: post
  // `{challengeId, liveFaceImageData: <photo of the admin>}` and the request
  // takes the CompareFaces branch, which a photograph on a second phone is
  // known to pass. Every part of the streaming path is bypassed by one field.
  //
  // So the field is refused outright for tenants that did not ask for it —
  // before the challenge is validated, so a probe cannot use this route to
  // learn whether a challenge id is live.
  //
  // 422, and it names the field: the only callers that can hit this are our
  // own, and a client sending the wrong field needs to know which one.
  if (parsed.liveFaceImageData && !c.get('tenant').allowSingleFrameFace) {
    console.warn(
      `[reverify/verify] refused liveFaceImageData from tenant "${c.get('tenant').id}"` +
        ` (allowSingleFrameFace is off) — challenge ${challengeId}`,
    );
    return c.json(
      {
        error:
          'This tenant must complete a Face Liveness session; liveFaceImageData is not accepted.',
        code: 'LIVENESS_SESSION_REQUIRED',
      },
      422,
    );
  }

  // Validate the challenge (and get the enrolled selfie URL, ADR-013) BEFORE
  // burning AWS liveness/compare spend on a dead challenge. Mid-login this is
  // the only selfie source — the session stepToken 401s on GET /kyc/current.
  const challenge = await validateReverifyChallenge(
    c.get('tenant').baseUrl,
    challengeId,
    userId,
    c.get('tenant').internalSecret,
  );
  if (!challenge.valid) {
    return c.json({ error: 'Invalid or expired re-verification challenge' }, 401);
  }

  const useMock = c.env.AWS_MOCK !== 'false';
  let livenessConfidence = 0;
  let faceMatchScore = 0;
  /**
   * The face this verdict was reached on. Declared beside the two scores
   * because it is committed with them — it lived inside the non-mock branch,
   * out of scope by the time the commit payload is built.
   */
  let liveFaceB64 = '';

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
        /**
         * The face AWS judged — the reference image, or an audit frame.
         *
         * ⚠️ Both, because the reference image is not guaranteed. A session can
         * come back SUCCEEDED with `ReferenceImage.Bytes` absent, and when it
         * did the sign-in dead-ended here on a check that had PASSED. The audit
         * frames exist for exactly this (see AuditImagesLimit at /reverify/start).
         *
         * Order matters: the reference image is the one AWS selected as best,
         * so it is preferred whenever it is there. An audit frame is a fallback,
         * not an equal.
         *
         * Both come from AWS server-side, so neither weakens the property that
         * the browser cannot choose which face is compared.
         */
        const refBytes =
          out.ReferenceImage?.Bytes ??
          out.AuditImages?.find((img) => img.Bytes?.length)?.Bytes;

        if (!refBytes) {
          // Nothing usable at all. AWS said SUCCEEDED — the branch above
          // returned for every other status — and then handed back no image in
          // either place. Logged field by field because the alternative is
          // guessing at somebody else's API from one sentence on a screen.
          // NEVER the bytes themselves: this is a photograph of a face.
          console.warn('[reverify/verify] SUCCEEDED but no usable image', {
            status: out.Status,
            confidence: out.Confidence,
            hasReferenceImage: Boolean(out.ReferenceImage),
            referenceImageKeys: out.ReferenceImage
              ? Object.keys(out.ReferenceImage)
              : [],
            // S3Object set instead of Bytes would mean an OutputConfig is in
            // play somewhere and the image went to a bucket. Nothing sets one
            // today, so this should always be false.
            hasS3Object: Boolean(out.ReferenceImage?.S3Object),
            auditImages: out.AuditImages?.length ?? 0,
            auditImagesWithBytes:
              out.AuditImages?.filter((img) => img.Bytes?.length).length ?? 0,
          });
          return c.json({ status: 'error', code: 'LIVENESS_FAILED', message: 'No liveness reference image returned.' });
        }

        if (!out.ReferenceImage?.Bytes) {
          console.warn(
            '[reverify/verify] no reference image — using an audit frame',
            { confidence: out.Confidence, auditImages: out.AuditImages?.length ?? 0 },
          );
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
        : await fetchEnrolledSelfie(token, c.get('tenant').baseUrl);
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
    if (!c.get('tenant').sharedSecret) {
      // Local dev without a signing secret: short-circuit (mock only).
      if (useMock) {
        return c.json({ status: 'passed', faceMatchScore, livenessConfidence, stepToken: 'mock-step' });
      }
      return c.json(
        { error: `No signing secret configured for tenant "${c.get('tenant').id}"` },
        503,
      );
    }
    // Mid-login (reset-passcode step entry) commits to the step-scoped route:
    // Bearer = the login SESSION stepToken; the DTO additionally requires a
    // freshness timestamp (Unix seconds) + one-time nonce for the signature
    // (RESET_PASSCODE_STEP_FACE_WEB_INTEGRATION.md §2b). Idle flow unchanged.
    const commitRes = await postSignedToNest(
      c.get('tenant').baseUrl,
      isSessionStep ? '/kyc/reverify/step/commit' : '/kyc/reverify/commit',
      isSessionStep
        ? {
            challengeId,
            livenessConfidence,
            faceMatchScore,
            /**
             * The face this verdict was reached ON, so the backend can store it
             * and hand it back as `face_capture_url`.
             *
             * ⚠️ It comes from HERE and not from the browser, and that
             * distinction is the point. This is the reference image
             * Rekognition returned for the session and the one CompareFaces
             * scored — fetched server-side from AWS, never uploaded. The
             * browser's copy is a presentational still it chose itself; storing
             * that as the record of an identity check would mean the record and
             * the decision are two different pictures, and only one of them was
             * ever verified.
             *
             * A `data:image/jpeg;base64,…` URL, matching how images already
             * travel through this Worker (see `enroll`). Adds ~200-400KB to a
             * request that was 78 bytes.
             */
            faceCapturedPhoto: liveFaceB64 || undefined,
            timestamp: Math.floor(Date.now() / 1000),
            nonce: crypto.randomUUID(),
          }
        : { challengeId, livenessConfidence, faceMatchScore },
      token,
      c.get('tenant').sharedSecret,
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
      uploadImage(parsed.frontImageData, 'front.jpg', 'document', token, c.get('tenant').baseUrl),
      isPassport ? Promise.resolve(undefined) : parsed.backImageData ? uploadImage(parsed.backImageData, 'back.jpg', 'document', token, c.get('tenant').baseUrl) : Promise.resolve(undefined),
      uploadImage(parsed.selfieImageData, 'selfie.jpg', 'image', token, c.get('tenant').baseUrl),
      resolveCountryId(parsed.extracted['country'], token, c.get('tenant').baseUrl),
    ]);

    // `nationalityCountryId` is RDB's foreign key, resolved by a fragile
    // name lookup against GET /countries. It is kept so RDB is unaffected, but
    // it is DEPRECATED: send-and-resolve belongs in the backend, where the
    // country table actually lives. New backends should read
    // `nationalityCountryIso3` (unambiguous, and what the extractor computed)
    // and fall back to `nationalityCountry` when no code was determined.
    const nestPayload = { kycSessionId: parsed.kycSessionId, fullName: parsed.extracted['name'] ?? '', nationalityCountryId, nationalityCountryIso3: parsed.extracted['countryIso3'], nationalityCountry: parsed.extracted['country'], documentType: mapDocumentType(parsed.extracted['idType']), documentFrontImageUrl: frontUrl, documentBackImageUrl: backUrl, selfieImageUrl: selfieUrl, nationalIdNumber: parsed.extracted['nationalNumber'] ?? parsed.extracted['documentNumber'] ?? '', selfieVsIdScore: parsed.selfieVsIdScore, livenessConfidence: parsed.livenessConfidence, documentExpiryDate: parsed.extracted['expiryDate'] };
    const submitRes = await postSignedToNest(c.get('tenant').baseUrl, '/kyc/submit', nestPayload, token, c.get('tenant').sharedSecret);
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

// ── POST /api/kyc/enroll ──────────────────────────────────────────────────────
//
// First-login document enrolment, committed to the backend over the SIGNED
// channel — the document-step twin of /reverify/verify.
//
// ── Why this is not /submit ─────────────────────────────────────────────────
// /submit above is RDB's: it needs a KYC session, uploads three images to
// /media/upload/direct, resolves a country id against /countries, then posts
// URLs to /kyc/submit. Root has none of those — no session concept at all, and
// all three routes answer 404 — so this sends the images inline in one signed
// call instead. See kyc-submit-contract.md in the root dashboard workspace.
//
// ── Everything the backend trusts, THIS route measures ──────────────────────
// The browser sends images and nothing else that matters. It does NOT get to
// send the match score or the extracted fields, even though it already holds
// both from /compare-face and /analyze-id, because a number a client can
// choose is a number an attacker can choose — and this Worker then SIGNS it.
// A signature over a client-supplied score would launder a forgery into
// something the backend has every reason to trust.
//
// So the OCR is re-run here and the comparison is redone here, on the exact
// bytes being committed. It costs one extra Textract call and one extra
// CompareFaces on a request that happens once in an administrator's life.
kycRoutes.post('/enroll', async (c) => {
  // Mid sign-in there is no access token — only the challenge, arriving as
  // X-Step-Token. Same resolution as the reverify routes.
  const { token } = reverifyAuth(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  let parsed: {
    challengeId?: string;
    documentType?: string;
    frontImage?: string;
    backImage?: string;
    selfieImage?: string;
  };
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { challengeId, frontImage, selfieImage, backImage } = parsed;
  if (!challengeId) return c.json({ error: 'challengeId is required' }, 422);
  if (!frontImage) return c.json({ error: 'frontImage is required' }, 422);
  if (!selfieImage) return c.json({ error: 'selfieImage is required' }, 422);

  const tenant = c.get('tenant');
  if (!tenant.sharedSecret) {
    // Nothing can be committed unsigned. Failing here beats sending an
    // unsigned enrolment the backend would be right to reject.
    return c.json(
      { error: `No signing secret configured for tenant "${tenant.id}"` },
      503,
    );
  }

  try {
    const { analyzeIdDocument, compareFaces } = await import(
      '../services/kyc/realKycService'
    );

    // 1. Re-read the document. The client's extraction is discarded — this is
    //    the copy that gets stored and it must describe the image beside it.
    const doc = await analyzeIdDocument(frontImage, 'front');
    if (!doc.found) {
      return c.json({
        status: 'error',
        code: 'ID_NOT_READABLE',
        message: 'The document could not be read. Capture it again in better light.',
      });
    }

    // 2. Compare the photo ON the document against the captured face.
    //    Prefer the tight crop this Worker just made; fall back to the whole
    //    front image, which Rekognition handles — a document is a photograph
    //    with a face in it. Threshold 0 so the ACTUAL similarity comes back:
    //    a floor here would report every near-miss as a flat 0 and the backend
    //    could not tell "different person" from "poor lighting".
    const cmp = await compareFaces(doc.idFaceImageData ?? frontImage, selfieImage, 0);
    if (!cmp.sourceFaceDetected) {
      return c.json({
        status: 'error',
        code: 'ID_FACE_NOT_DETECTED',
        message: 'No face found on the document. Capture the photo side.',
      });
    }
    if (!cmp.targetFaceDetected) {
      return c.json({
        status: 'error',
        code: 'FACE_NOT_DETECTED',
        message: 'No face found in the captured photo.',
      });
    }

    // The number the backend's threshold is about to be applied to. Logged
    // because without it a rejection reads as "below threshold" with no way to
    // tell a different person (single digits) from a poor capture of the right
    // one (60s–70s) — and those have opposite fixes. `usedIdFaceCrop` matters
    // too: comparing against the whole document page rather than the photo on
    // it is a measurably weaker signal.
    console.log(
      '[enroll] compare:',
      JSON.stringify({
        challengeId,
        selfieVsIdScore: cmp.similarity,
        verdict: cmp.verdict,
        usedIdFaceCrop: Boolean(doc.idFaceImageData),
        unmatchedTargetFaces: cmp.unmatchedTargetFaces,
      }),
    );

    // 3. Commit. The backend applies the thresholds and owns the verdict —
    //    this route reports what it measured and decides nothing, exactly as
    //    the face step does.
    //
    //    `livenessConfidence` is deliberately NOT sent. The only trustworthy
    //    liveness in this flow was measured at the face step and already
    //    committed there; the browser's copy of it is just a number it holds,
    //    and signing it would dress it up as a measurement.
    const e = doc.extracted;
    const commitRes = await postSignedToNest(
      tenant.baseUrl,
      '/kyc/submit',
      {
        challengeId,
        documentType: mapEnrolDocumentType(e.idType ?? parsed.documentType),
        frontImage,
        backImage,
        selfieImage,
        extracted: {
          fullName: e.name,
          documentNumber: e.documentNumber ?? e.passportNumber,
          nationalNumber: e.nationalNumber,
          birthDate: e.birthday,
          expiryDate: e.expiryDate ?? e.expirationDate,
          country: e.country,
          countryIso3: e.countryIso3,
        },
        selfieVsIdScore: cmp.similarity,
      },
      token,
      tenant.sharedSecret,
    );

    const text = await commitRes.text();

    // 404 means the backend has not built /kyc/submit yet — a DIFFERENT thing
    // from it refusing this document, and the caller needs to tell them apart:
    // one is "the contract does not exist", the other is "this person did not
    // match". Named explicitly so a client can fall back to the interim path
    // without pattern-matching on prose, and so the fallback disappears by
    // itself the moment the endpoint ships and stops answering 404.
    if (commitRes.status === 404) {
      console.warn(
        `[enroll] /kyc/submit is not implemented on ${tenant.baseUrl} — challenge ${challengeId}`,
      );
      return c.json({
        status: 'error',
        code: 'ENROLL_NOT_IMPLEMENTED',
        message: 'The enrolment endpoint does not exist on this backend yet.',
      });
    }

    if (!commitRes.ok) {
      console.warn(`[enroll] commit → ${commitRes.status} for challenge ${challengeId}`);
      return c.json(
        { error: 'The enrolment backend rejected the document.', detail: text },
        commitRes.status >= 500 ? 502 : (commitRes.status as 400),
      );
    }

    // Passed through as the backend gave it. `stepToken` is what the browser
    // posts to /auth/identity-document; a 'failed' verdict carries no token
    // and the flow stops there, which is the whole outcome set: device, or
    // failed.
    const decision = JSON.parse(text) as {
      status?: string;
      reason?: string;
      stepToken?: string;
    };

    // The verdict, and whether a token came with it. Without this the tail
    // shows a 200 for both outcomes — the commit succeeding and the backend
    // refusing look identical from outside, and the only place the difference
    // appears is a fixed error line on the client that names nothing.
    console.log(
      '[enroll] decision:',
      JSON.stringify({
        challengeId,
        status: decision.status ?? 'missing',
        reason: decision.reason,
        hasStepToken: Boolean(decision.stepToken),
      }),
    );

    return c.json({
      status: decision.status ?? 'failed',
      reason: decision.reason,
      stepToken: decision.stepToken,
      selfieVsIdScore: cmp.similarity,
    });
  } catch (err) {
    console.error('[enroll] failed:', err);
    return c.json(
      { status: 'error', code: 'INTERNAL_ERROR', message: 'Enrolment failed.' },
      500,
    );
  }
});

/** Textract's document-type string → the three values the backend accepts. */
function mapEnrolDocumentType(idType?: string): string {
  const t = (idType ?? '').toLowerCase();
  if (t.includes('passport')) return 'PASSPORT';
  if (t.includes('driver') || t.includes('driving')) return 'DRIVING_LICENSE';
  return 'NATIONAL_ID';
}

// ── POST /api/kyc/complete ────────────────────────────────────────────────────
kycRoutes.post('/complete', async (c) => {
  const token = accessToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  let parsed: { kycSessionId: string; videoCallUrl: string; livenessConfidence: number; videoVsIdScore: number };
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!parsed.kycSessionId || !parsed.videoCallUrl || parsed.livenessConfidence == null || parsed.videoVsIdScore == null) return c.json({ error: 'kycSessionId, videoCallUrl, livenessConfidence, videoVsIdScore are required' }, 422);
  const res = await patchSignedToNest(c.get('tenant').baseUrl, '/kyc/current/complete', parsed, token, c.get('tenant').sharedSecret);
  const text = await res.text();
  if (!res.ok) return c.json({ error: 'Video completion failed.', detail: text }, res.status >= 500 ? 502 : res.status as 400);
  return c.json({ success: true, kycRequest: JSON.parse(text) });
});

// ── REMOVED: the video-interview KYC routes ─────────────────────────────────
//
// /heygen-token, /heygen-streaming-token, /simli-token, /simli-speak, /speak,
// /transcribe-speech, /verify-answer and /verify-video configured an avatar-led
// video interview whose frontend was deleted from rdb. They had no caller in any
// project and wrangler.toml already recorded them as inert, so they were surface
// area with credentials attached and nothing behind them.

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
