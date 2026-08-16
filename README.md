# ramaaz-kyc

Hosted KYC service. Identity verification — ID capture, liveness, face matching,
and step-up re-verification — served from its own origin.

Consumer apps **do not install anything**. They redirect the user here, the flow
runs, and the user is sent back with a result. Web apps redirect; Flutter loads
the same URL in a webview. One implementation, one deployment.

Extracted from the `rdb` banking app, where this ran as ~7,500 lines embedded in
the frontend.

---

## Why a service and not a library

An npm package would have served web consumers only. There is already a Flutter
consumer, which would have meant rebuilding the entire camera/CV stack in Dart.

It also keeps two problems contained to one deployment instead of every
consumer's build:

- the document scanner is a Web Worker loaded via `new URL(..., import.meta.url)`,
  whose resolution is bundler-dependent once it ships inside `node_modules`
- OpenCV is fetched at runtime from a third-party URL

Here, both stay exactly where they already work.

---

## Status

Phase 1 — face re-verification only.

| Flow | State |
|---|---|
| Face re-verification (step-up) | ✅ implemented |
| ID capture + OCR | ⏳ still in rdb |
| Liveness challenge | ⏳ still in rdb |
| Face ↔ ID match | ⏳ still in rdb |
| Worker API | ⏳ still in the rdb monorepo; proxied from here |

The Worker (`packages/kyc-server` in rdb) is deliberately **not** moved yet. This
app forwards `/api/kyc/*` to it, so the extraction is verifiable end to end
without touching the backend, AWS credentials, or NestJS.

---

## Layout

```
apps/web/                     Next.js app — the hosted flow
  src/app/verify/face/        the face re-verification route
  src/app/api/kyc/[...path]/  proxy → KYC Worker
  src/components/face/        FaceVerifyFlow, FaceScanOverlay
  src/hooks/useCamera.ts      camera access + frame capture
  src/lib/kycApi.ts           Worker client
  src/lib/returnTo.ts         return-URL allowlist
```

---

## Running it

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # then fill it in
npm run dev        # http://localhost:3000
npm run build
npm run typecheck
```

| Env var | Purpose |
|---|---|
| `KYC_WORKER_BASE_URL` | Base URL of the deployed KYC Worker. No trailing slash. |
| `NEXT_PUBLIC_KYC_ALLOWED_RETURN_ORIGINS` | Comma-separated absolute origins permitted as `?returnTo=`. |

Camera access requires a secure context: `localhost` works over plain HTTP;
every other host needs HTTPS.

---

## Integrating a consumer app

Redirect the user to:

```
https://kyc.example.com/verify/face
  ?challengeId=<from your backend>
  &reason=<optional, shown to the user>
  &returnTo=https://your-app.example/settings
```

They come back to `returnTo` with:

```
?kyc=passed&kycChallenge=<id>
?kyc=failed&kycChallenge=<id>&kycReason=mismatch|liveness|cancelled|expired|error
```

Then **your backend** exchanges the challenge for the step token with NestJS.

### The step token is never in the URL

`?kyc=passed` is an assertion, not a credential. The step token is a bearer proof
authorising whatever action the user was stopped on, and URLs leak — via the
`Referer` header, browser history, and server access logs. The client is told
only that the challenge passed; the secret moves backend-to-backend.

Treat the redirect as a hint to go ask your backend, never as proof by itself.

### `returnTo` is allowlisted

Every `returnTo` is checked against `NEXT_PUBLIC_KYC_ALLOWED_RETURN_ORIGINS`.
Unknown origin, non-http(s) scheme, or unconfigured allowlist → the flow refuses
to start rather than running and discarding the result. An unchecked `returnTo`
is an open redirect that hands verification outcomes to whoever crafted the link.

---

## Open decisions

**How does this app authenticate the user?** Currently it forwards the incoming
`Authorization` header and cookies to the Worker, which works when the consumer
and this app share a cookie domain. For a genuinely separate origin it should be
a short-lived signed token minted by NestJS and verified here. **This is not yet
implemented and blocks cross-domain production use.**

**Theming.** The flow currently carries rdb's visual design (the `xd-*` scale
utilities from its 430×932 canvas). Multi-tenant branding — logo, colours,
locale — needs a config mechanism before a second project onboards.

---

## Design constraints

**Pass/fail is never decided here.** This app captures frames and renders
results. Every accept/reject decision comes from NestJS. Client-side checks exist
only to avoid wasting server calls on unusable frames.

**No AWS credentials in the browser.** All Textract/Rekognition work happens in
the Worker.

**The flow owns the viewport.** No document scroll, no pinch-zoom — a zoom
mid-capture breaks the alignment guides.

---

## License

Private — Ramaaz internal.
