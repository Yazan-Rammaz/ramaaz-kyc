import { Hono } from 'hono';
import { kycRoutes } from './routes/kyc';

export type Env = {
    ENVIRONMENT: string;
    RDB_BASE_URL: string;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_SESSION_TOKEN?: string;
    AWS_MOCK: string;
    OPENAI_API_KEY: string;
    HEYGEN_API_KEY: string;
    NEXT_PUBLIC_HEYGEN_AVATAR_ID: string;
    SIMLI_API_KEY: string;
    SIMLI_FACE_ID: string;
    NEXT_PUBLIC_SIMLI_FACE_ID: string;
    KYC_WEBHOOK_SECRET: string;
    KYC_SHARED_SECRET: string;
    KYC_INTERNAL_SECRET: string;
    KYC_TRANSLATE_ARABIC_NAMES: string;
    OPENAI_TRANSLATION_MODEL: string;
};

const ALLOWED_ORIGINS = [
    'https://ramaaz-digital-bank.online',
    'https://dev.ramaaz-digital-bank.online',
    'https://new.ramaaz-digital-bank.online',
    'https://api.ramaaz-digital-bank.online',
    'http://localhost:3000',
    'https://localhost:3000',
];

function isAllowedOrigin(origin: string | null): boolean {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.pages\.dev$/.test(origin)) return true;
    if (/^https:\/\/[a-z0-9-]+\.ramaaz-digital-bank\.pages\.dev$/.test(origin)) return true;
    return false;
}

const app = new Hono<{ Bindings: Env }>();

if (typeof process !== 'undefined' && process.env) {
    console.log('[worker] process.env:', process.env);
}

app.use('*', async (c, next) => {
    const origin = c.req.header('Origin') ?? null;
    const allowed = isAllowedOrigin(origin);

    if (c.req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': allowed && origin ? origin : '',
                'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers':
                    'Content-Type, Authorization, X-KYC-Webhook-Secret, X-Step-Token',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    await next();

    if (allowed && origin) {
        c.res.headers.set('Access-Control-Allow-Origin', origin);
        c.res.headers.set('Access-Control-Allow-Credentials', 'true');
        c.res.headers.set('Vary', 'Origin');
    }
});

// Debug logger: Cloudflare observability captures request metadata + console output
// only — NOT request/response bodies. This logs each /api/kyc/* response body
// (truncated) and timing so failures are visible in the dashboard ("View invocation"
// or filter level=error). Remove or gate behind ENVIRONMENT once debugging is done.
app.use('/api/kyc/*', async (c, next) => {
    const started = Date.now();
    const path = new URL(c.req.url).pathname;
    await next();
    try {
        const clone = c.res.clone();
        const ct = clone.headers.get('content-type') ?? '';
        let preview: string;
        if (ct.includes('json') || ct.includes('text')) {
            const text = await clone.text();
            preview = text.length > 2000 ? `${text.slice(0, 2000)}…(+${text.length - 2000})` : text;
        } else {
            preview = `<${ct || 'binary'} ${clone.headers.get('content-length') ?? '?'}b>`;
        }
        console.log(
            `[kyc] ${c.req.method} ${path} → ${c.res.status} (${Date.now() - started}ms) ${preview}`,
        );
    } catch (err) {
        console.log(`[kyc] ${c.req.method} ${path} → ${c.res.status} (response log failed: ${String(err)})`);
    }
});

// KYC is the only domain that must run on the Cloudflare Worker (signing secrets,
// CF runtime). All other /api/* is served by the Next.js Pages app, which talks to
// NestJS directly. See apps/frontend/src/app/api/**.
app.route('/api/kyc', kycRoutes);

app.get('/health', (c) =>
    c.json({ status: 'ok', env: c.env.ENVIRONMENT ?? 'unknown', ts: Date.now() }),
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
    console.error('[worker] unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
});

export default app;
