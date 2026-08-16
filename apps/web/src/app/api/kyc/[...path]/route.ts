import { NextRequest } from 'next/server';

/**
 * Proxy for /api/kyc/* → the KYC Worker.
 *
 * Phase 1 deliberately does NOT move the Worker. It stays deployed where it is
 * and this app forwards to it, so the extraction can be verified end to end
 * without touching the backend, the AWS credentials, or NestJS. Moving the
 * Worker into this repo is a later, independent step.
 *
 * Keeping the browser same-origin (rather than calling the Worker directly from
 * the client) means no CORS preflight on every capture, and the Worker's origin
 * stays out of the client bundle.
 */

const WORKER_BASE = process.env.KYC_WORKER_BASE_URL ?? '';

async function forward(req: NextRequest, path: string[]) {
    if (!WORKER_BASE) {
        return Response.json(
            { error: 'KYC_WORKER_BASE_URL is not configured' },
            { status: 503 },
        );
    }

    const target = `${WORKER_BASE.replace(/\/$/, '')}/kyc/${path.join('/')}${req.nextUrl.search}`;

    const headers = new Headers();
    const ct = req.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    // Forward the caller's credentials so the Worker can authorise the challenge.
    const auth = req.headers.get('authorization');
    if (auth) headers.set('authorization', auth);
    const cookie = req.headers.get('cookie');
    if (cookie) headers.set('cookie', cookie);

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
