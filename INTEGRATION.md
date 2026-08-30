# ramaaz-kyc — integration contract

How any Ramaaz product plugs into this Worker. One contract, one auth model, N
products.

Two audiences: **§2 is for frontend teams**, **§3 is for backend teams**. Read
§1 first — it is the rule everything else follows from.

---

## 1. What this Worker is

It measures, and it decides nothing.

It runs AWS Rekognition liveness, face comparison and ID OCR, then reports the
numbers it got — liveness 94.2, face match 91.7 — to your backend over a signed
server-to-server channel. **Your backend applies the thresholds and owns the
verdict.**

That is not a preference. KYC sits on the login path: a pass/fail computed in
the browser could be forged from devtools. A pass/fail computed here and relayed
through the browser is no better. Only a value your backend computed, from
numbers delivered over a channel the browser cannot forge, is worth anything.

### The one rule

**Every product's backend implements the SAME contract** — the same paths, the
same shapes, the same authentication (§3).

The only thing a product may vary is **the order** in which its own flow calls
these endpoints. RDB enrols after a passcode; the root dashboard enrols inside
a sign-in challenge. Neither costs this Worker anything, because it keeps no
state between requests — order lives in your backend, where the state machine
is.

This is why there are no per-product adapters. Adapters would let each backend
invent its own API, and the cost lands in exactly one place: N authentication
paths to audit instead of one.

So a *tenant* here is nothing but **where to send the request** and **which keys
to sign it with**.

---

## 2. Frontend integration

### 2.1 Never call this Worker from the browser

Your browser code calls **your own origin** (`/api/kyc/*`); your server forwards
to the Worker. The browser must never hold a backend token, and a strict
`connect-src 'self'` CSP forbids it reaching another host anyway.

### 2.2 On Cloudflare you MUST use a service binding

This is the trap that costs a day. Same-account Worker→Worker calls over a
`*.workers.dev` URL **never reach the target Worker** — Cloudflare answers its
own bare 404 page. It works in local dev and fails only once deployed.

```jsonc
// wrangler.jsonc / wrangler.toml of the CALLING app
"services": [{ "binding": "KYC_WORKER", "service": "ramaaz-kyc" }]
```

```ts
import { getCloudflareContext } from '@opennextjs/cloudflare';

const { env } = getCloudflareContext();
const kyc = (env as { KYC_WORKER?: { fetch: typeof fetch } }).KYC_WORKER;

// Binding on Cloudflare; plain fetch in local dev (wrangler dev on :8787).
const res = kyc
  ? await kyc.fetch(`https://ramaaz-kyc/api/kyc/${path}`, init)
  : await fetch(`http://localhost:8787/api/kyc/${path}`, init);
```

### 2.3 Headers your proxy attaches

| Header | When | Value |
| --- | --- | --- |
| `X-Ramaaz-Tenant` | **always**, except RDB | your tenant id, e.g. `root` |
| `Authorization: Bearer <token>` | user has a session | the access token |
| `X-Step-Token: <token>` | **mid-login, no session yet** | the login/challenge token |

`X-Step-Token` is the important one for sign-in flows. It tells the Worker there
is no access token yet, and routes the commit to the step-scoped backend
endpoint. RDB uses it for reset-passcode; the root dashboard uses it for the
whole enrolment challenge.

Omitting `X-Ramaaz-Tenant` resolves to `rdb` — RDB predates this mechanism, so
its clients need no change. **An unknown tenant is a 503, never a silent
fallback**: falling back would deliver your token to another product's backend.

Cookies are also read (the tenant's configured names), but are **deprecated** —
forwarding a whole Cookie header hands this Worker every cookie the user holds
when it needs one value. Send headers.

### 2.4 What you can use immediately

Three endpoints are **pure analysis — no auth, no backend, nothing to
configure**. A new product can build and test its entire capture UI against
these before its backend exists:

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/kyc/analyze-id` | `{ imageData, side, sessionHint }` | `{ status, code?, extractedData? }` |
| `POST /api/kyc/liveness` | `{ faceImageData, challengeStep, crop }` | `{ isLive, faceImageData?, metrics? }` |
| `POST /api/kyc/compare-face` | `{ selfieImageData, idFaceImageData }` | `{ status, matchScore?, message? }` |

Everything else needs your backend (§3).

### 2.5 Ordering — the Worker imposes none

**The Worker is stateless.** It correlates nothing between requests: there is no
session store, no cached face, no notion of "step 2 comes after step 1". The
only module-level state is a config cache and a mock-mode retry counter.

So the order is **yours**. Three things constrain it, and none of them is the
Worker:

1. **Data dependencies.** `/compare-face` needs two images, so you must have
   obtained them first — from anywhere, in any order.
2. **Your backend's state machine.** Stages, challenges, what may follow what.
3. **`/reverify/*` needs a live challenge** your backend issued.

#### The client holds the images, which is what makes reuse possible

| Endpoint | Hands you back |
| --- | --- |
| `POST /api/kyc/liveness` | `faceImageData` — the validated live frame (cropped when `crop: true`) |
| `POST /api/kyc/analyze-id` (front) | `idFaceImageData` — the photo cropped out of the document |
| `POST /api/kyc/compare-face` | a score for **whatever two images you pass it** |

`/compare-face` takes `{ selfieImageData, idFaceImageData }` as plain
parameters. It has no memory of a previous capture, so **a face captured early
in a flow can be compared against an ID scanned later** — you simply keep the
frame and pass it in.

Note `/reverify/verify` is a *different* comparison: live frame vs the
**enrolled** selfie your backend points to via `selfieImageUrl`. Use it to prove
"this is the same person we already know". Use `/compare-face` to prove "the
person here matches the document here".

#### Two real orders, same endpoints

These are **examples, not options to choose from, and nothing you register.**
A flow is not declared anywhere — not in `TENANTS`, not in code, not with this
Worker at all. It is simply whatever order your frontend calls things in. Two
products can use completely different orders on the same day without the Worker
knowing either of them exists.

**RDB enrolment — document first**

```
analyze-id (front)  → idFaceImageData, extracted fields
analyze-id (back)
liveness × N        → faceImageData
compare-face        { selfieImageData: liveness frame, idFaceImageData: from step 1 }
submit
```

**Root sign-in — face first, then enrol without recapturing**

```
liveness            → faceImageData          ← KEEP THIS
reverify/verify     { challengeId, liveFaceImageData }   → backend decides → stepToken
analyze-id (front)  → idFaceImageData
analyze-id (back)
compare-face        { selfieImageData: THE FRAME FROM STEP 1, idFaceImageData: from analyze-id }
submit
```

Step 5 reuses step 1's frame. **No second face capture, and no Worker change** —
the reuse is possible precisely because the Worker keeps nothing.

#### Where to keep the frame

It is a base64 JPEG, typically 100–500 KB, so it will not fit in a cookie (4 KB)
and must not go in the challenge state. Hold it in client memory for the
duration of the flow — the existing `KycSessionContext` is the right place.

A page reload therefore loses it and forces a recapture. That is the correct
trade: persisting a face to `localStorage` leaves biometric data on the device
long after the flow ends, to save one capture.

---

## 3. Backend contract

Implement these and you are integrated. Same paths, same shapes, every product.

### 3.1 The two secrets, and why there are two

Both are per-tenant, and they are **not interchangeable**. They protect
different operations with different blast radii.

| | `KYC_INTERNAL_SECRET` | `KYC_SHARED_SECRET` |
| --- | --- | --- |
| Sent as | `X-Internal-Secret: <secret>` | `X-KYC-Signature: sha256=<hmac>` |
| Mechanism | the secret itself, in a header | HMAC-SHA256 **over the body** |
| Used on | **reads** — "is this challenge live?" | **writes** — "this face scored 91.7" |
| User's token | not sent; `userId` is in the body | sent, as `Authorization: Bearer` |
| Replay protection | none | `timestamp` + `nonce`, inside the signed body |
| Answers | *"is the Worker asking?"* | *"did the Worker compute exactly this, just now?"* |

**`KYC_INTERNAL_SECRET` — the lookup key.** Used on the two `validate`
endpoints, before any AWS spend, to ask whether a challenge or session is real
and belongs to this user. There is no user token on these calls — the Worker is
asserting *"user X claims challenge Y"* — so the only thing the backend can
check is that the caller is the Worker. A static shared value is enough for
that, because the call changes nothing.

**`KYC_SHARED_SECRET` — the verdict key.** Used on every call that changes
identity state: the two reverify commits, `/kyc/submit`, and
`/kyc/current/complete`. Two credentials travel together here, and they answer
two different questions. The **bearer** says *who the user is*. The
**signature** says *this result came from the Worker, not from a browser
replaying a request*. Either alone is insufficient: a browser holds a valid
bearer.

```
signature = "sha256=" + hmac_sha256(shared_secret, raw_request_body).hex()
```

**You must reject:** a signature that does not verify; a `timestamp` more than
~60 seconds old; a `nonce` you have seen before. Verify against the **raw body
bytes**, not a re-serialised object — key order changes the hash.

#### Why not one secret for both?

Separation of privilege, and it is worth being concrete about what each one
costs you if it leaks:

- **`KYC_INTERNAL_SECRET` leaks** → an attacker can probe whether challenge ids
  are live, and read back `selfieImageUrl` — a presigned URL to a user's stored
  selfie. Bad, and biometric, but read-only.
- **`KYC_SHARED_SECRET` leaks** → an attacker can **forge a passing face
  check**. Combined with any valid bearer, that is an account takeover on a
  flow whose entire purpose is proving the person is real.

Collapsing them into one value would mean every routine read carries the key
that can forge verdicts. Keeping them apart also lets you rotate the dangerous
one on its own schedule.

The same reasoning makes them per-tenant: with shared values, RDB's backend
could mint a verdict the root backend would honour.

#### Known weakness

The internal calls are **not signed** — no HMAC, no timestamp, no nonce — so
they are replayable by anyone who obtains the value. That is tolerable today
because they are read-only, server-to-server, and over TLS. If you want this
airtight, sign them the same way as the commits; the Worker already has
`signKycPayload()` for exactly this shape. Worth doing before production.

### 3.2 Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/kyc/reverify/{challengeId}/validate` | internal | Is this challenge live? → `{ valid, selfieImageUrl }` |
| `POST` | `/kyc/sessions/{kycSessionId}/validate` | internal | Is this enrolment session live? |
| `POST` | `/kyc/reverify/commit` | signed | Face result, user **has** a session |
| `POST` | `/kyc/reverify/step/commit` | signed | Face result, user is **mid-login** |
| `POST` | `/kyc/submit` | signed | Full enrolment payload |
| `PATCH` | `/kyc/current/complete` | signed | Mark enrolment complete |
| `POST` | `/kyc/sessions/start` | bearer | Open an enrolment session |
| `GET` | `/kyc/status` | bearer | → `{ status }` |
| `GET` | `/kyc/current` | bearer | Current record, incl. `selfieImageUrl` |
| `POST` | `/media/upload/direct` | bearer | multipart `file` + `type` → `{ url }` |
| `GET` | `/countries?limit=100` | bearer | ⚠️ **DEPRECATED** — see below. New backends should not implement it. |

Commit request body:

```json
{ "challengeId": "…", "livenessConfidence": 94.2, "faceMatchScore": 91.7,
  "timestamp": 1787747000, "nonce": "…" }
```

#### What `challengeId` is

**Whatever your backend says it is.** The Worker treats it as an opaque
correlation id: it passes it to `validate`, echoes it in the commit, and never
interprets it.

You therefore have to decide what the caller puts there, and tell them:

- an id you issue alongside the flow state (a challenge id, a session id), which
  the caller carries and passes through; **or**
- the caller's own step/session token, if you are content for that value to
  appear in a request body as well as the `Authorization` header.

Whichever you pick, `validate` must be able to resolve it to a user and answer
whether it is still open. A caller cannot invent this value, so an integration
stalls at the first face check until you have named it.

Commit response — **this is where your decision goes**:

```json
{ "status": "passed" | "failed", "reason": "…", "stepToken": "…" }
```

`stepToken` is what the frontend presents to your *next* step as proof the face
check passed. It must be single-use, short-lived, and verifiable only by you.

### 3.3 Country: read the ISO-3 code, not the name

`/kyc/submit` carries three country fields. **Read `nationalityCountryIso3`.**

| Field | What it is |
| --- | --- |
| `nationalityCountryIso3` | ISO 3166-1 alpha-3 (`SYR`, `TUR`). What the extractor actually computed — from the passport MRZ, or a phrase match. Absent only when the country came from a Textract fallback with no code. |
| `nationalityCountry` | The display name (`"Syria"`). Fallback when no code was determined. |
| `nationalityCountryId` | ⚠️ **DEPRECATED.** RDB's foreign key, resolved by the Worker calling `GET /countries?limit=100` and matching the display name exactly. |

The deprecated path is worth understanding so nobody rebuilds it. The Worker
extracts a precise ISO-3 code, converts it to an English display name, sends
that, and the backend matches the lossy name back against its table — with
exact string equality, over a page of 100 rows. Three ways to fail: a passport
MRZ reads `SYRIAN ARAB REPUBLIC` where the row says `Syria`; there are ~195
countries, so `limit=100` cannot see them all; and every miss returns
`undefined` silently.

Resolving a country belongs in the backend, where the country table lives and
where alias, alpha-2 and Arabic-name handling can be done properly. Once every
backend reads the code, `nationalityCountryId`, `resolveCountryId()` and
`GET /countries` all get deleted.

### 3.4 The detail that silently breaks everything

**`selfieImageUrl` must be plain-fetchable** — a public or presigned URL, no
Authorization header. The Worker downloads it to compare against the live face,
and mid-login it holds a step token that cannot authenticate to a protected
media route. Return a presigned URL, not an API path.

---

## 4. Adding a product

Three things, and **a flow is not one of them.** You never describe your
sequence to this Worker — see §2.5. You register where your backend lives and
how to sign to it; the order you call things in is your own business and can
change any time without touching anything here.

You do not even need this to start: `/analyze-id`, `/liveness` and
`/compare-face` require no tenant, no secrets and no backend, so a new product
can build and test its whole capture UI first and register only when it is ready
to commit results.

No code change. One registry entry plus two secrets:

```toml
# wrangler.toml [vars] — and repeat under [env.production.vars],
# because Wrangler environments do NOT inherit the top-level [vars].
TENANTS = '''{"rdb":{…},"yourapp":{
  "baseUrl":"https://your-backend.example.com",
  "cookies":{"access":"yourapp_at","step":"yourapp_step"},
  "origins":["https://yourapp.example.com","http://localhost:3000"]
}}'''
```

```
wrangler secret put KYC_SHARED_SECRET_YOURAPP
wrangler secret put KYC_INTERNAL_SECRET_YOURAPP
```

`TENANTS` is plaintext config that ships with the Worker — **never put a secret
in it.** Secrets resolve by convention `<PREFIX>_<TENANT_ID>` (uppercased). RDB
keeps its unsuffixed `KYC_SHARED_SECRET` / `KYC_INTERNAL_SECRET`, so nothing
about that deployment needs re-provisioning.

Then confirm it:

```
GET /ready
{"status":"ok","env":"development","tenants":[
  {"id":"rdb","baseUrl":"…","sharedSecret":true,"internalSecret":true},
  {"id":"yourapp","baseUrl":"…","sharedSecret":false,"internalSecret":false}]}
```

Booleans only — never a secret's value or length. `false` means the secret is
not set, and every signed call for that tenant will answer 503.

---

## 5. Wiring-up checklist

1. `GET /ready` — your tenant listed, both secrets `true`.
2. `POST /api/kyc/liveness` with `{}` → `400 faceImageData is required`. Proves
   routing and tenant resolution without touching your backend.
3. Same call with a bogus tenant → `503 not configured`. Proves you are not
   silently being served as RDB.
4. Your backend's `/kyc/reverify/{id}/validate` returns `{valid:true}` for a
   live challenge and `{valid:false}` otherwise.
5. A commit with a deliberately wrong `X-KYC-Signature` → rejected.
6. A replayed commit (same `nonce`) → rejected.
7. A commit with a `timestamp` two minutes old → rejected.

Steps 5–7 are the ones worth being strict about. They are the whole reason the
browser cannot forge a KYC pass.

---

## 6. Known issues

**⚠️ `/liveness-credentials` and `/reverify/credentials` return permanent AWS
keys to the browser.** Both answer with `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` verbatim. `AWS_SESSION_TOKEN` is optional and is not set
in `wrangler.toml`, so despite the comment reading "vend temp AWS creds", these
are the Worker's **long-lived IAM user credentials**, handed to any client that
passes the session check.

The AWS Amplify `FaceLivenessDetector` does need credentials in the browser, but
they must be **temporary and scoped**: call STS `AssumeRole` with a short
duration and a policy permitting only `rekognition:StartFaceLivenessSession`,
then return that triple including its `sessionToken`. Fixing this needs a role
ARN, so it is flagged rather than done.

**Cookie support is deprecated** (§2.3). Once every caller sends headers, delete
`cookies` from the registry and the cookie reads in `routes/kyc.ts`.

**The video-interview routes are gone.** `/heygen-*`, `/simli-*`, `/speak`,
`/transcribe-speech`, `/verify-answer` and `/verify-video` were removed — no
caller in any product, and they held API credentials with nothing behind them.
