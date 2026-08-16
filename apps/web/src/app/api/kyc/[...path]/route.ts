import { NextRequest } from 'next/server';
import { readSessionToken } from '@/lib/session';

/**
 * Proxy for /api/kyc/* → the KYC Worker.
 *
 * Phase 1 deliberately does NOT move the Worker. It stays deployed where it is
 * and this app forwards to it, so the extraction can be verified end to end
 * without touching the backend, the AWS credentials, or NestJS.
 *
 * ─── Identity ───────────────────────────────────────────────────────────────
 * Identity comes from the httpOnly session cookie set by /verify/face/start,
 * NOT from headers the browser supplied. The Worker accepts a Bearer token and
 * reads `sub` from its payload, so the verified hand-off token is attached here.
 *
 * Client-supplied Authorization / Cookie headers are deliberately NOT forwarded.
 * Doing so would let a caller present any token they liked and have this service
 * launder it into a Worker call — the proxy would become an open relay to the
 * KYC backend. Whatever the browser sends is ignored; only the cookie counts.
 */

const WORKER_BASE = process.env.KYC_WORKER_BASE_URL ?? '';

/** Endpoints this proxy is willing to relay. Anything else is refused. */
const ALLOWED_PATHS = new Set([
    // Face re-verification (step-up)
    'reverify/start',
    'reverify/verify',
    'reverify/credentials',
    // Enrollment: document capture + liveness challenge
    'analyze-id',
    'liveness',
]);

async function forward(req: NextRequest, path: string[]) {
    // Order matters: route and session checks run BEFORE the upstream-config
    // check. Testing configuration first would make a misconfigured deployment
    // answer 503 to unauthenticated calls — masking whether the auth gate works
    // at all, and reporting "service down" where the honest answer is 401.
    const joined = path.join('/');
    // An allowlist rather than a passthrough: this app currently implements one
    // flow, so relaying arbitrary /kyc/* routes (submit, status, complete) would
    // expose surface it has no session model for yet. Extend deliberately.
    if (!ALLOWED_PATHS.has(joined)) {
        return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const session = await readSessionToken();
    if (!session) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!WORKER_BASE) {
        return Response.json({ error: 'KYC_WORKER_BASE_URL is not configured' }, { status: 503 });
    }

    // The Worker mounts its routes at /api/kyc (see packages/api/src/index.ts:
    // app.route('/api/kyc', kycRoutes)), NOT /kyc. Getting this wrong yields a
    // silent 404 that looks like a missing endpoint rather than a bad prefix.
    const target = `${WORKER_BASE.replace(/\/$/, '')}/api/kyc/${joined}${req.nextUrl.search}`;

    const headers = new Headers();
    const ct = req.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    headers.set('authorization', `Bearer ${session}`);

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();

    const upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
    });

    // Pass the Worker's status and body through untouched — the client relies on
    // structured failure bodies (status/code/message), not just HTTP status.
    const resHeaders = new Headers();
    const upstreamCt = upstream.headers.get('content-type');
    if (upstreamCt) resHeaders.set('content-type', upstreamCt);

    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
    const { path } = await ctx.params;
    return forward(req, path);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
    const { path } = await ctx.params;
    return forward(req, path);
}
