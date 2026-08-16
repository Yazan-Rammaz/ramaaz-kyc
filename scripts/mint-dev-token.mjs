#!/usr/bin/env node
/**
 * Mints a hand-off token for local development.
 *
 * This is a stand-in for what NestJS does in production — see README
 * "Hand-off contract". It exists so the flow can be exercised locally without a
 * backend, and so the exact token shape is executable rather than prose.
 *
 * There is deliberately NO dev bypass in the app itself: a "skip verification
 * when NODE_ENV=development" flag is one misconfiguration away from disabling
 * auth in production. Minting a real token is just as easy and cannot leak.
 *
 * Usage:
 *   node scripts/mint-dev-token.mjs <userId> <challengeId> [ttlSeconds]
 *
 * Reads KYC_HANDOFF_SECRET from the environment or apps/web/.env.local.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', 'apps', 'web', '.env.local');

function secretFromEnvFile() {
    if (!existsSync(envPath)) return undefined;
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*KYC_HANDOFF_SECRET\s*=\s*(.*)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, '');
    }
    return undefined;
}

const secret = process.env.KYC_HANDOFF_SECRET || secretFromEnvFile();
if (!secret) {
    console.error('KYC_HANDOFF_SECRET is not set (env or apps/web/.env.local).');
    process.exit(1);
}

const [userId, challengeId, ttlRaw] = process.argv.slice(2);
if (!userId || !challengeId) {
    console.error('Usage: node scripts/mint-dev-token.mjs <userId> <challengeId> [ttlSeconds]');
    process.exit(1);
}
const ttl = Number(ttlRaw ?? 180);

const b64url = (buf) =>
    Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(
    JSON.stringify({
        sub: userId,
        cid: challengeId,
        aud: 'ramaaz-kyc',
        iss: 'dev-mint',
        exp: Math.floor(Date.now() / 1000) + ttl,
        jti: `dev-${Date.now()}`,
    }),
);
const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());

console.log(`${header}.${payload}.${sig}`);
