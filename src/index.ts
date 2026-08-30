import { Hono } from 'hono';
import { kycRoutes } from './routes/kyc';
import { allowedOrigins, tenantReport } from './lib/tenant';

export type Env = {
    ENVIRONMENT: string;

    /**
     * ── The tenant registry ─────────────────────────────────────────────────
     * JSON: `{ "<id>": { baseUrl, cookies?, origins? }, … }`. Plaintext config,
     * so it holds NO secrets — those are looked up by convention as
     * `KYC_SHARED_SECRET_<ID>` / `KYC_INTERNAL_SECRET_<ID>`, with RDB keeping
     * its existing unsuffixed names.
     *
     * Adding a product is one entry here plus two secrets. Never read a base
     * URL or a secret directly in a route — resolve them together through
     * `lib/tenant.ts`, which is what stops one tenant's URL being paired with
     * another's signing key.
     */
    TENANTS: string;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_SESSION_TOKEN?: string;
    AWS_MOCK: string;
    OPENAI_API_KEY: string;
    // HeyGen / Simli bindings were dropped with the video-interview routes.
    KYC_WEBHOOK_SECRET: string;
    KYC_SHARED_SECRET: string;
    KYC_INTERNAL_SECRET: string;
    KYC_TRANSLATE_ARABIC_NAMES: string;
    OPENAI_TRANSLATION_MODEL: string;
};

/**
 * Allowed browser origins, per tenant, from the registry.
 *
 * A preflight carries `Origin` but NOT our tenant header — custom headers are
 * what it is asking permission for — so the check has to be against the union
 * of every tenant's origins rather than one tenant's. That is not a weakening:
 * CORS decides which page may read a response, and the tenant still decides
 * which backend and which keys are used.
 */
function isAllowedOrigin(origin: string | null, env: Env): boolean {
    if (!origin) return false;
    if (allowedOrigins(env).includes(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.pages\.dev$/.test(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.ramaaz-digital-bank\.pages\.dev$/.test(origin)) return true;
    return false;
}

const app = new Hono<{ Bindings: Env }>();

// ⚠️ REMOVED: `console.log('[worker] process.env:', process.env)`.
//
// With nodejs_compat and a modern compatibility_date, `process.env` carries the
// Worker's SECRETS — AWS keys, the OpenAI key, KYC_WEBHOOK_SECRET,
// KYC_SHARED_SECRET, KYC_INTERNAL_SECRET. This line printed all of them in
// full, on every isolate start, into Cloudflare observability logs (enabled
// above in wrangler.toml). Never log `process.env` or `c.env` wholesale.

app.use('*', async (c, next) => {
    const origin = c.req.header('Origin') ?? null;
    const allowed = isAllowedOrigin(origin, c.env);

    if (c.req.method === 'OPTIONS') {
        const preflight: Record<string, string> = {
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers':
                'Content-Type, Authorization, X-KYC-Webhook-Secret, X-Step-Token, X-Ramaaz-Tenant',
            'Access-Control-Max-Age': '86400',
        };
        // Omit the origin headers entirely when the origin is not allowed. An
        // empty `Access-Control-Allow-Origin: ''` is a malformed value rather
        // than a denial, so the browser reports a confusing CORS parse error
        // instead of the plain "this origin is not allowed" the developer needs.
        if (allowed && origin) {
            preflight['Access-Control-Allow-Origin'] = origin;
            preflight['Access-Control-Allow-Credentials'] = 'true';
            preflight['Vary'] = 'Origin';
        }
        return new Response(null, { status: 204, headers: preflight });
    }

    await next();

    if (allowed && origin) {
        c.res.headers.set('Access-Control-Allow-Origin', origin);
        c.res.headers.set('Access-Control-Allow-Credentials', 'true');
        c.res.headers.set('Vary', 'Origin');
    }
});

// Request logger. Cloudflare observability captures console output, so this is
// what makes a failing call visible in the dashboard ("View invocation", or
// filter level=error).
app.use('/api/kyc/*', async (c, next) => {
    const started = Date.now();
    const path = new URL(c.req.url).pathname;
    await next();
    // Size and status only — NEVER the body. Liveness and face-compare
    // responses carry `faceImageData`, so logging bodies wrote biometric data
    // into Cloudflare observability on every request.
    const len = c.res.headers.get('content-length') ?? '?';
    console.log(
        `[kyc] ${c.req.method} ${path} → ${c.res.status} (${Date.now() - started}ms, ${len}b)`,
    );
});

// This Worker serves ONLY /api/kyc/*. Each product's own app proxies to it and
// handles everything else against its own backend directly — the Worker exists
// because the KYC pipeline needs the Cloudflare runtime and holds the signing
// secrets, not because it is a general API gateway.
app.route('/api/kyc', kycRoutes);

app.get('/health', (c) =>
    c.json({ status: 'ok', env: c.env.ENVIRONMENT ?? 'unknown', ts: Date.now() }),
);

/**
 * Integration diagnostic: which tenants exist, and are their secrets set?
 *
 * The first thing to hit when wiring up a new product. Without it, a missing
 * secret surfaces as a 503 from deep inside a signed commit and the integrator
 * cannot tell a config problem from a code problem.
 *
 * Booleans only — never a secret, its value, or its length. Base URLs are
 * already public config that ships with the Worker.
 */
app.get('/ready', (c) =>
    c.json({ status: 'ok', env: c.env.ENVIRONMENT ?? 'unknown', tenants: tenantReport(c.env) }),
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
    console.error('[worker] unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
});

export default app;
