# NestJS: accept KYC hand-off tokens

**Status:** required before hosted enrollment can go live
**Owner:** NestJS backend
**Blocks:** `ramaaz-kyc` `/verify/enroll` — capture works, submit fails

---

## Why this is needed

KYC has moved out of the rdb frontend into a standalone hosted service
(`ramaaz-kyc`). Consumer apps no longer render verification screens; they
redirect the user to the KYC origin, which runs the flow and hands them back.

That service is a **different origin**, so it never receives the user's
`rdb_at` session cookie. Identity has to cross the boundary explicitly.

Face re-verification already works, because it uses a server-to-server path:
`POST /kyc/reverify/:challengeId/validate` with `X-Internal-Secret`, carrying
`userId` in the body. NestJS never needs a user token there.

**Enrollment has no equivalent.** The Worker's `/submit` takes the caller's token
and forwards it to NestJS as a real access token in three places:

| Worker call | NestJS endpoint | Auth used |
|---|---|---|
| `uploadImage()` ×3 (front, back, selfie) | `POST /media/upload/direct` | `Bearer <token>` |
| `resolveCountryId()` | `GET /countries` | `Bearer <token>` |
| `postSignedToNest()` | `POST /kyc/submit` | `Bearer <token>` + `X-KYC-Signature` |

The hosted service holds a **hand-off token**, not an access token, so all three
are rejected today. The user completes document capture, liveness and face
matching, then the submit 502s.

### Why not just forward the user's access token

It was considered and rejected. It is long-lived, grants the full API surface,
and would have to reach another origin through a URL or a cross-domain cookie —
both leak (Referer, history, access logs). The hand-off token is deliberately
scoped to one user, one challenge, one audience, and a few minutes.

---

## What to implement

Accept a **second token type** on the endpoints above: alongside the normal
access token, allow an HS256 hand-off token signed with a shared secret. When one
is presented, treat the request as the user named in `sub`.

### Token format

`Authorization: Bearer <jwt>`, HS256, signed with `KYC_HANDOFF_SECRET`.

```jsonc
{
  "sub": "<userId>",        // subject — who is being verified
  "cid": "<challengeId>",   // binds the token to ONE verification attempt
  "aud": "ramaaz-kyc",      // audience — must match exactly
  "iss": "rdb-nestjs",      // issuer
  "exp": 1786879515,        // seconds since epoch; issue with ~3 minutes
  "jti": "<uuid>",          // unique id, for single-use enforcement
  "steps": ["id", "liveness"] // capture stages the client must run
}
```

`steps` is consumed by the KYC frontend, not by NestJS — it decides which capture
stages run. It lives in the signed token so a client cannot drop a compliance
check by editing a URL.

A working reference implementation is
[`scripts/mint-dev-token.mjs`](../scripts/mint-dev-token.mjs).

### Validation rules

Reject unless **all** hold:

1. Signature verifies against `KYC_HANDOFF_SECRET` (HS256).
2. `aud === "ramaaz-kyc"`.
3. `exp` is in the future.
4. `sub` resolves to an existing, active user.
5. `alg` in the header is exactly `HS256`. **Reject `none` and any RS/ES
   algorithm.** Accepting the header's `alg` blindly is the classic JWT forgery:
   `alg: none` makes any payload valid, and an RS256 header can trick a library
   into verifying with the public key as an HMAC secret.

Use a constant-time comparison for the signature.

### Scope

A hand-off token must authorise **only** what the KYC flow needs:

```
POST /media/upload/direct
GET  /countries
POST /kyc/submit
```

Everything else must reject it, even with a valid signature. If it is accepted
wherever an access token is accepted, a leaked hand-off token becomes a general
account credential — which removes the point of scoping it.

Recommended: a dedicated guard on those three routes rather than extending the
global auth guard, so the default stays closed.

### Single use

`jti` should be recorded on first use and rejected thereafter (Redis with a TTL
matching `exp` is enough). Not strictly required for a first release — `exp` is
short — but without it a token captured in transit is replayable for its full
lifetime.

`cid` should also be checked against the challenge/session it was issued for, so
a token minted for one verification cannot be used to submit another.

---

## Who mints the token

**NestJS**, when a consumer app starts a verification. rdb calls an authenticated
endpoint; NestJS verifies the session it already trusts and returns the token.

Suggested:

```
POST /kyc/handoff
  Auth: normal user session (Bearer rdb_at)
  Body: { "flow": "enroll" | "face", "steps"?: string[] }
  →    { "token": "<jwt>", "challengeId": "<id>", "expiresAt": "<iso>" }
```

The consumer then redirects:

```
https://kyc.ramaaz.com/verify/enroll/start
  ?t=<token>
  &challengeId=<challengeId>
  &returnTo=https://app.example.com/verification-done
```

**The frontend must never mint this token** — that would require shipping
`KYC_HANDOFF_SECRET` to the browser, and anyone could then assert any `sub`.

---

## Returning the result

When the flow settles, the KYC service redirects back with an outcome only:

```
https://app.example.com/verification-done?kyc=passed&kycChallenge=<id>
```

The step token and the verification decision are **deliberately absent**. URLs
leak, and the consumer must not trust a query parameter as proof. It calls NestJS
with the `challengeId` to learn the real outcome:

```
GET /kyc/challenge/:challengeId/result
  Auth: normal user session
  →    { "status": "passed" | "failed" | "pending", "stepToken"?: "<proof>" }
```

Must verify the challenge belongs to the calling user — otherwise anyone who
learns a `challengeId` can read someone else's verification result.

---

## Per-consumer verification rules

Different projects need different checks. rdb compares the live face to the
document photo; another project already stores an enrolled face and wants a
three-way comparison.

That is **server-side policy** and belongs here, not in the token or the client:

| Consumer | Comparisons |
|---|---|
| rdb | `live ↔ id` |
| root | `live ↔ id` **and** `live ↔ enrolled` |

The client submits artifacts (`selfieImageData`, `selfieVsIdScore`,
`livenessConfidence`) and NestJS decides. Adding a consumer with stricter rules
should require no frontend change at all.

Deliberately **not** in the token: comparison pairs and thresholds. The client
never acts on them, and signing them would mean re-issuing tokens to change a
policy.

---

## Configuration

| Name | Where | Purpose |
|---|---|---|
| `KYC_HANDOFF_SECRET` | NestJS + KYC service | HMAC secret for hand-off tokens |
| `KYC_INTERNAL_SECRET` | NestJS + Worker | existing — `reverify/validate` |
| `KYC_SHARED_SECRET` | NestJS + Worker | existing — `X-KYC-Signature` on submit |

Use a long random value, distinct from the other two, and rotate independently.
Unset must mean **reject everything**, never "skip verification".

---

## Test cases

Auth:

- [ ] valid hand-off token on the three scoped endpoints → accepted as `sub`
- [ ] valid hand-off token on any other endpoint → 401/403
- [ ] tampered payload → rejected
- [ ] `alg: none` → rejected
- [ ] `alg: RS256` with the secret as public key → rejected
- [ ] expired `exp` → rejected
- [ ] `aud` other than `ramaaz-kyc` → rejected
- [ ] `sub` for a deleted/disabled user → rejected
- [ ] unset `KYC_HANDOFF_SECRET` → every token rejected

Flow:

- [ ] mint → redirect → capture → submit completes and creates a KYC request
- [ ] result endpoint returns the decision to the owning user
- [ ] result endpoint refuses a challenge belonging to another user
- [ ] replayed `jti` rejected (if single-use is implemented)
- [ ] `cid` mismatched to the submitted session rejected

---

## Rollout

The two token types can coexist, so this is additive and safe to ship ahead of
the frontend switch:

1. Add the guard and `/kyc/handoff`. Existing access-token traffic is unaffected.
2. Test hosted enrollment end to end against staging (needs a real device — a
   laptop webcam cannot hold a document quad reliably).
3. Point rdb's `/verification` at the hosted flow.
4. Delete rdb's KYC screens. `ramaaz-kyc` already holds them; rdb's copy is a
   duplicate from that point on.

Step 4 was attempted early and reverted — the hosted flow renders correctly but
cannot complete a submit until this spec is implemented. Do not repeat it until
step 2 passes on a real device.
