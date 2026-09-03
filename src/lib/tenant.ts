import type { Env } from '../index';

/**
 * Which product a request belongs to.
 *
 * ── The one rule this Worker is built on ────────────────────────────────────
 * EVERY tenant backend speaks the SAME contract: the same paths, the same
 * request and response shapes, the same authentication. What may differ
 * between products is only the ORDER in which their own flow calls these
 * endpoints — and order is the backend's business, because this Worker holds
 * no state between requests.
 *
 * That rule is why there are no per-tenant adapters here. Adapters would let
 * each backend invent its own API, and the cost lands in one place: N auth
 * paths to audit instead of one. A single mandated contract is both smaller
 * and safer.
 *
 * So a tenant is nothing but WHERE to send the request and WHICH keys to sign
 * it with.
 *
 * ── Why config and not code ─────────────────────────────────────────────────
 * Tenants are read from the `TENANTS` var, so adding a product is one JSON
 * entry plus two secrets — no code change, no new deployment logic, nothing to
 * review. That is the whole point of this module.
 */

/** One product's entry in the `TENANTS` registry. */
export type TenantConfig = {
  id: string;
  /** Base URL of this tenant's backend. */
  baseUrl: string;
  /** HMAC key for signed Worker→backend commits (`X-KYC-Signature`). */
  sharedSecret: string;
  /** Key for internal Worker→backend calls (`X-Internal-Secret`). */
  internalSecret: string;
  /**
   * Cookie names this tenant's browser session uses.
   *
   * ⚠️ DEPRECATED, and present only so existing clients keep working. Callers
   * should send `Authorization: Bearer` or `X-Step-Token` instead: a proxy that
   * forwards its whole Cookie header hands this Worker every cookie the user
   * holds, when it needs exactly one value. Once every caller sends headers,
   * delete this and the cookie reads in routes/kyc.ts.
   */
  cookies: { access: string; step: string };
  /** Browser origins allowed to call the Worker on this tenant's behalf. */
  origins: string[];
  /**
   * May this tenant post a face IMAGE to `/reverify/verify` instead of a
   * liveness `sessionId`?
   *
   * ── Why this exists ─────────────────────────────────────────────────────
   * The single-frame path runs CompareFaces on a picture the CLIENT chose.
   * CompareFaces answers "same face" and nothing about whether a person was
   * there, so a photograph of the enrolled admin held up on a second phone
   * passes it — demonstrated, not theorised. The streaming path exists because
   * of that: the client sends a session id, and the Worker fetches the image
   * from AWS itself, so nothing the client sends can decide who is compared.
   *
   * With both paths open on the same route, the streaming one is advisory —
   * an attacker skips the liveness check by posting an image instead. This
   * flag is what closes that.
   *
   * ── Default false, on purpose ───────────────────────────────────────────
   * A tenant added tomorrow gets the strong path with nobody remembering to
   * ask for it, and allowing the weak one is an explicit, greppable grant in
   * the config rather than an omission. RDB sets it because its Flutter client
   * has no Amplify streaming UI and single-frame is all it can send.
   */
  allowSingleFrameFace: boolean;
};

/** The shape of one entry in the `TENANTS` JSON var. Secrets are NOT in here. */
type TenantVar = {
  baseUrl: string;
  cookies?: { access?: string; step?: string };
  origins?: string[];
  /** See `allowSingleFrameFace` on TenantConfig. Absent means NOT allowed. */
  allowSingleFrameFace?: boolean;
};

/**
 * The header a caller uses to pick a tenant.
 *
 * ⚠️ It selects a KEY IN A REGISTRY — never a URL. Accepting a base URL from
 * the request would be a straight SSRF: anyone able to reach this Worker could
 * point it at a host they control and harvest the bearer token and the HMAC
 * signature that go out with every backend call.
 */
export const TENANT_HEADER = 'X-Ramaaz-Tenant';

/**
 * Default when no header is sent.
 *
 * RDB predates this mechanism and its clients send no tenant header, so
 * defaulting to it makes the whole thing invisible to them — no client change,
 * no coordinated deploy. New products opt in by sending the header.
 */
const DEFAULT_TENANT = 'rdb';

/** Raised when a tenant is named but this deployment has no backend for it. */
export class TenantNotConfiguredError extends Error {
  constructor(
    readonly tenant: string,
    readonly reason: string,
  ) {
    super(`Tenant "${tenant}" is not configured on this Worker (${reason})`);
    this.name = 'TenantNotConfiguredError';
  }
}

/**
 * Parsed registries, keyed by the raw JSON.
 *
 * A Worker isolate is reused across requests, so this parses once per
 * deployment rather than once per request — and every CORS preflight needs the
 * origin list too. Keyed by the string itself, so a config change can never be
 * served from a stale entry.
 */
const registryCache = new Map<string, Record<string, TenantVar>>();

function parseRegistry(env: Env): Record<string, TenantVar> {
  if (!env.TENANTS) return {};
  const cached = registryCache.get(env.TENANTS);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(env.TENANTS) as Record<string, TenantVar>;
    const registry = parsed && typeof parsed === 'object' ? parsed : {};
    registryCache.set(env.TENANTS, registry);
    return registry;
  } catch {
    // Malformed config must not read as "no such tenant" — that would send a
    // caller to the default backend with the wrong credentials.
    throw new TenantNotConfiguredError('*', 'TENANTS is not valid JSON');
  }
}

/**
 * Secrets pinned IN CODE, keyed `<PREFIX>_<TENANT_ID>` exactly like the env
 * lookup below.
 *
 * ⚠️ This is a deliberate exception to "secrets live in `wrangler secret`", and
 * it exists for one reason: the deployed `KYC_INTERNAL_SECRET_ROOT` had DRIFTED
 * from the value the root backend actually holds. `/ready` reports a secret as
 * set, not as correct, so the drift was invisible there and surfaced only as
 * "Invalid or expired re-verification challenge" in the browser while the
 * backend logged `401 UNAUTHENTICATED` on `/v1/kyc/reverify/{id}/validate` —
 * two messages that name neither the secret nor each other.
 *
 * Pinned entries WIN over the Cloudflare secret of the same name, on purpose: a
 * fallback would have been shadowed by the very wrong value it is here to
 * replace.
 *
 * The cost is real and worth stating plainly: these two strings now ship in the
 * Worker bundle and in git history, so anyone with repo access holds root's
 * verdict key. To undo it, rotate both keys on the root backend, set the new
 * values with `wrangler secret put KYC_{INTERNAL,SHARED}_SECRET_ROOT`, and
 * delete this table — `secretFor` keeps working unchanged.
 */
const PINNED_SECRETS: Record<string, string> = {
  KYC_INTERNAL_SECRET_ROOT: 'xb5sWUQaUD3rCwBwrI3vliMzZvrTDRQOym8YeNG8W7euWkOJvoKH2CXjvQU5idCf',
  KYC_SHARED_SECRET_ROOT: 'I3SsSNtl5glPzB6s956XumkP9qTVdBuldjDf2zX-W0g9fKk72JuDPT3C3znKk1eT',
};

/**
 * Secrets are looked up by convention, `<PREFIX>_<TENANT_ID>`, because
 * Cloudflare secrets are flat strings and cannot be nested inside the registry
 * JSON — and must not be, since `TENANTS` is plaintext config that ships with
 * the Worker.
 *
 * RDB keeps the unsuffixed names it already has set, so nothing about its
 * deployment needs re-provisioning.
 */
function secretFor(env: Env, prefix: string, id: string): string {
  const bag = env as unknown as Record<string, string | undefined>;
  const key = `${prefix}_${id.toUpperCase()}`;
  const pinned = PINNED_SECRETS[key];
  if (pinned) return pinned;
  const suffixed = bag[key];
  if (suffixed) return suffixed;
  return id === DEFAULT_TENANT ? (bag[prefix] ?? '') : '';
}

/** Every origin any configured tenant may be called from. */
export function allowedOrigins(env: Env): string[] {
  const registry = (() => {
    try {
      return parseRegistry(env);
    } catch {
      return {};
    }
  })();
  return Object.values(registry).flatMap((t) => t.origins ?? []);
}

/**
 * Only the two things resolution actually needs. Typed structurally rather than
 * as a Hono `Context` so that adding `Variables` to the route's generic — which
 * is exactly what this function makes necessary — does not make the context
 * unassignable to its own resolver.
 */
type TenantSource = {
  req: { header(name: string): string | undefined };
  env: Env;
};

/**
 * Resolve the tenant for this request.
 *
 * ── What is fatal here, and what is not ─────────────────────────────────────
 * An UNKNOWN TENANT or a MISSING BASE URL is fatal: there is no such product on
 * this deployment, and the only alternative — falling back to the default —
 * would hand one product's token to another product's backend. It would be
 * rejected, but only after the token had already left.
 *
 * MISSING SECRETS are not fatal here, deliberately. Three routes
 * (`/analyze-id`, `/liveness`, `/compare-face`) are pure analysis: they call no
 * backend and sign nothing, so refusing them for an absent signing key would
 * make the useful half of this Worker unusable before the secrets exist. The
 * routes that do sign check for themselves and answer 503.
 */
export function resolveTenant(c: TenantSource): TenantConfig {
  const raw = (c.req.header(TENANT_HEADER) ?? '').trim().toLowerCase();
  const registry = parseRegistry(c.env);

  // A NAMED tenant that is not in the registry must FAIL, never fall back.
  // Falling back is the one thing this module exists to prevent: a caller that
  // asked for "root" and silently got the default would have its token, and its
  // signed request, delivered to another product's backend. That backend would
  // reject it — but only after the credential had already left.
  //
  // A MISSING header is a different case and does fall back, because RDB
  // predates this mechanism and its clients send nothing.
  const id = raw || DEFAULT_TENANT;

  const entry = registry[id];
  if (!entry) {
    throw new TenantNotConfiguredError(
      id,
      raw ? 'no such tenant in TENANTS' : 'the default tenant has no entry in TENANTS',
    );
  }
  if (!entry.baseUrl) throw new TenantNotConfiguredError(id, 'no baseUrl');

  return {
    id,
    baseUrl: entry.baseUrl,
    sharedSecret: secretFor(c.env, 'KYC_SHARED_SECRET', id),
    internalSecret: secretFor(c.env, 'KYC_INTERNAL_SECRET', id),
    cookies: {
      access: entry.cookies?.access ?? `${id}_at`,
      step: entry.cookies?.step ?? `${id}_step`,
    },
    origins: entry.origins ?? [],
    // `=== true`, not `??` — a missing, null or truthy-but-not-true value must
    // read as "no", never as "yes". This is a security grant.
    allowSingleFrameFace: entry.allowSingleFrameFace === true,
  };
}

/**
 * Every configured tenant, and whether its secrets are actually set — the
 * answer to "why is my integration 503-ing", without anyone reading logs or
 * guessing. Booleans only: never a secret's value, and never its length.
 */
export function tenantReport(
  env: Env,
): Array<{ id: string; baseUrl: string; sharedSecret: boolean; internalSecret: boolean }> {
  let registry: Record<string, TenantVar>;
  try {
    registry = parseRegistry(env);
  } catch {
    return [];
  }
  return Object.entries(registry).map(([id, t]) => ({
    id,
    baseUrl: t.baseUrl,
    sharedSecret: Boolean(secretFor(env, 'KYC_SHARED_SECRET', id)),
    internalSecret: Boolean(secretFor(env, 'KYC_INTERNAL_SECRET', id)),
  }));
}
