# ramaaz-kyc

KYC verification API. Document OCR, liveness scoring, and face matching, running
as a Cloudflare Worker in front of AWS and NestJS.

**This is an API, not a UI.** Consuming projects build their own capture screens
and call these endpoints. rdb has its own; a Flutter app uses native camera
screens.

Extracted from the rdb monorepo, where it lived as `packages/kyc-server`.

---

## Why API-only

A hosted UI was built and then removed. It would have meant one set of screens
every project redirects to — attractive, but it required NestJS to accept a new
token type, because the Worker forwards the caller's token to NestJS as a real
access token when uploading media and submitting.

Keeping this API-only removes that dependency entirely: each project calls these
endpoints with its own user's access token, which already works. The cost is that
the camera and computer-vision layer is rebuilt per project rather than shared.

If that trade stops making sense — a third or fourth consumer, say — the hosted
flow and the spec for the backend work it needed are both recoverable from git
history.

---

## Endpoints

All mounted under `/api/kyc`.

| Route | Purpose |
|---|---|
| `POST /analyze-id` | OCR + validate one side of a document |
| `POST /liveness` | Score one frame of a liveness challenge |
| `POST /face-match` | Compare a live face to the photo on the document |
| `POST /session` | Open a KYC session (single-use) |
| `GET  /status` | Current verification status |
| `POST /submit` | Submit captured artifacts for a decision |
| `POST /reverify/start` | Open a face step-up challenge |
| `POST /reverify/verify` | Settle a face step-up challenge |
| `GET  /reverify/credentials` | Temporary AWS creds for streaming liveness |

Auth is the caller's NestJS access token, as `Authorization: Bearer`, the
`X-Step-Token` header, or the `rdb_at` / `rdb_step` cookies.

**No decision is made here.** The Worker runs AWS, computes scores, and forwards
a signed payload to NestJS, which decides approve / review / reject. Client-side
and Worker-side thresholds exist only to avoid wasting AWS calls on unusable
frames.

---

## Running it

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill it in
npm run dev          # http://localhost:8787
npm run build        # wrangler dry-run
npm run typecheck
npm run deploy
```

`AWS_MOCK=true` returns fixtures and skips AWS entirely — the whole flow runs
with no AWS account and no spend.

### Configuration

`[vars]` in `wrangler.toml` is plaintext config that ships with the Worker and
lands in git. Anything secret belongs in `wrangler secret`:

```bash
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put KYC_SHARED_SECRET      # signs payloads to NestJS
wrangler secret put KYC_INTERNAL_SECRET    # server-to-server challenge validation
```

---

## Supported documents

| Country | Front | Back | Notes |
|---|---|---|---|
| Syria | ✅ | ✅ | barcode decode on back |
| Türkiye | ✅ | ✅ | MRZ |
| Lebanon | ✅ | ✅ | barcode decode on back |
| Generic passport | ✅ | — | MRZ; single-sided |

Adding a country means one parser in `src/services/kyc/` exporting
`looksLike<X>Id()` and `parse<X>Id()`, registered in `realKycService`.

---

## What a consumer has to build

Because this is API-only, the browser-side work lives in each project:

- camera access and frame capture
- local quality gates (brightness, sharpness, glare, motion) so unusable frames
  never reach AWS
- document edge detection, if you want auto-capture
- the capture screens themselves

rdb has a working implementation of all of it under
`src/components/verification` and `src/hooks`, including a self-hosted OpenCV
worker — worth copying rather than rewriting.

Two things that cost real time there, worth knowing up front:

- **OpenCV and MediaPipe must be self-hosted.** A restrictive `script-src` CSP
  blocks the usual CDN loads, and OpenCV additionally fetches its own WASM from a
  `data:` URI, which needs `connect-src data:`. When OpenCV silently fails to
  load, document detection produces no corners and capture appears to hang
  forever on "scanning".
- **Camera previews are usually mirrored.** Detection runs on the raw frame, so
  any overlay drawn from those coordinates must be mirrored to match, or the
  guide box lands on the opposite side of the screen.

---

## Design constraints

**The decision is NestJS's.** This Worker scores and forwards; it never approves.

**No AWS credentials leave the Worker**, except the short-lived STS credentials
vended by `/reverify/credentials` for streaming liveness.

**Thresholds are calibrated for real physical documents**, not IDs displayed on a
screen. Screen-displayed documents have 3–5× higher edge contrast; tuning to them
causes false `too_blurry` rejections on real cards.

---

## License

Private — Ramaaz internal.
