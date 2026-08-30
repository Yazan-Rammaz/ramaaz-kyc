# Design note — the signed result token

**Status: proposed, not built.** Recorded now so the reasoning survives; the
migration is deliberately deferred (§6).

The goal: make `ramaaz-kyc` an **isolated service** that anything can integrate —
a Cloudflare Worker, a Vercel app, a plain Node server, a Flutter client —
without that consumer's backend having to implement an API this service dictates.

---

## 1. What is wrong with the current design

`ramaaz-kyc` is not a service. It is a **participant in a workflow** that happens
to be deployed separately.

A service takes input and returns output. This one takes input, then **calls back
into the consumer's backend**, and requires that backend to implement specific
endpoints at specific paths with specific shapes:

```
POST /kyc/reverify/{challengeId}/validate     X-Internal-Secret
POST /kyc/reverify/step/commit                signed
POST /kyc/reverify/commit                     signed
POST /kyc/submit                              signed
PATCH /kyc/current/complete                   signed
POST /media/upload/direct                     bearer
GET  /countries?limit=100                     bearer
GET  /kyc/current                             bearer
```

So integrating is not "call an API" — it is "implement our reverse-API". Every
consequence follows from that inversion:

| Coupling | What it forces on a new consumer |
| --- | --- |
| Calls back into the backend | Build 4–8 endpoints with exact paths and shapes |
| `jwtSub()` decodes the caller's token | Issue JWTs with `sub`; opaque sessions cannot integrate |
| Expects `/media/upload/direct` | Host media upload at that path |
| Expects `/countries` | Keep a countries table (already being removed) |
| Reads cookies | Consumer-specific cookie names in the registry |

Three endpoints are already perfect isolated services and prove the point:
`analyze-id`, `liveness` and `compare-face` need no auth, no backend and no
state. Anything can call them today.

---

## 2. Why the coupling exists

It is not accidental. KYC sits on the login path, so a verdict the browser could
forge is worthless. The current design guarantees non-forgeability by never
letting the verdict pass through the browser at all: the Worker computes it and
delivers it to the backend over an HMAC-signed server-to-server channel.

Any replacement has to keep that property. That is the whole constraint.

---

## 3. The proposal

**The Worker returns a signed result to the caller. The caller relays it to its
own backend. The backend verifies the signature and decides.**

```
browser ──frames──► consumer's server ──► ramaaz-kyc
                          │                    │  AWS Rekognition
                          │◄──signed result────┘
                          │
                          ▼
                   consumer's backend  ── verifies signature, applies thresholds
```

The Worker never learns the consumer's API. It has one output: a signed
statement of what it measured.

### The token

A JWS (compact JWT), signed HS256 with that tenant's `KYC_SHARED_SECRET`:

```json
{
  "iss":  "ramaaz-kyc",
  "aud":  "root",                  // the tenant it was issued for
  "sub":  "<challengeId>",         // whatever correlation id the caller passed
  "op":   "face-verify",           // face-verify | id-analyze | face-compare
  "livenessConfidence": 94.2,
  "faceMatchScore": 91.7,
  "iat":  1787747000,
  "exp":  1787747300,              // short — this is a receipt, not a session
  "jti":  "01M0Z…"                 // one-time; the backend rejects reuse
}
```

The backend must reject: a bad signature; `aud` that is not itself; an expired
`exp`; a `jti` it has seen. Same discipline as the current HMAC commits — the
rules move, they do not weaken.

**Non-forgeability is preserved.** The browser never holds
`KYC_SHARED_SECRET`, so it cannot mint or alter a result. It can only pass along
a token the Worker signed, which is exactly what a signed receipt is for.

### What it deletes

For **every** consumer, permanently:

- `/kyc/reverify/{id}/validate` and the whole `X-Internal-Secret` channel
- `/kyc/reverify/commit` and `/kyc/reverify/step/commit`
- `/kyc/submit`, `/kyc/current`, `/kyc/current/complete`
- `/media/upload/direct`, `/countries`
- `jwtSub()` and the JWT requirement on the caller's token
- cookie reading, and `cookies` from the tenant registry
- `KYC_INTERNAL_SECRET` entirely — there is no unsigned channel left

Root's backend endpoint count goes from **4 to 0**. Its only obligation becomes
verifying a signature.

---

## 4. What is lost, and how it is covered

**The pre-flight validity check.** Today `validate` runs before any AWS spend, so
a dead challenge costs nothing. Removing it means the Worker will occasionally
analyse a frame for a challenge the backend would have rejected.

Covered by: the caller checks its own challenge before calling — it is the
caller's challenge, and it already knows. Cheaper than a round trip, and it puts
the decision where the state is.

**Fetching the enrolled selfie.** Today the Worker pulls `selfieImageUrl` from
the backend. Instead the caller passes the reference — a URL or the image —
in the request. It already has it, and this removes the awkward requirement that
the URL be plain-fetchable by a third party.

**Storage.** Today the Worker uploads images and writes the enrolment record.
Under this design it returns them and the caller stores them. That is correct:
where a product keeps its documents is not this service's business.

---

## 5. What the service becomes

Six endpoints, no auth beyond a per-tenant API key, no backend knowledge:

| Endpoint | In | Out |
| --- | --- | --- |
| `POST /v1/analyze-id` | image, side | fields, `idFaceImageData`, `countryIso3` |
| `POST /v1/liveness` | frame | `isLive`, `faceImageData` |
| `POST /v1/compare-face` | two images | score |
| `POST /v1/face-verify` | live frame, reference image, correlation id | **signed result** |
| `POST /v1/face-compare` | two images, correlation id | **signed result** |
| `GET /v1/ready` | — | tenants and key status |

The first three stay unsigned — they measure and assert nothing, so there is
nothing to forge. The signed pair exist only where a *verdict* is at stake.

A tenant then needs one thing: an API key. No base URL, no callback secrets, no
cookie names, no origins beyond CORS.

---

## 6. Migration — deliberately deferred

Not now. The root backend developer has just been handed the current contract,
and changing it means he builds twice. The right order:

1. Build the current 4 endpoints; get root working end to end. **← we are here**
2. Add `POST /v1/face-verify` returning a signed result, **alongside** the
   existing commit path. Both work; nothing breaks.
3. Root moves first — it is the newer consumer and has less to unpick.
4. RDB follows.
5. Delete the commit path, `KYC_INTERNAL_SECRET`, `jwtSub`, and the cookie reads.

Steps 2–5 are independent and can each ship on their own.

**In the meantime, stop deepening the coupling.** Every new callback into a
consumer's backend is something step 5 has to remove. The country change already
moved in the right direction by handing resolution back to the backend rather
than teaching the Worker another of its tables.

---

## 7. Open questions

1. **Signing algorithm.** HS256 with the shared secret is simplest and matches
   today. RS256/EdDSA with a published JWKS would let a backend verify without
   holding a secret that can also *mint* results — worth it if consumers are
   ever outside your control.
2. **Correlation id.** The token's `sub` is whatever the caller passes. Should
   the service require it to be opaque, or is a challenge id acceptable? It ends
   up in logs.
3. **Result retention.** Should the Worker keep a record of what it signed, for
   dispute resolution? That reintroduces state, which is why it is a question
   rather than a proposal.
