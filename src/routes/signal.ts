import { Hono } from 'hono';
import type { Env } from '../index';

/**
 * Camera hand-off signaling — the ONLY thing this Worker does for the phone.
 *
 * ── What problem this solves ────────────────────────────────────────────────
 * A desktop with no camera (or a denied permission, which is sticky per origin
 * and cannot be re-prompted) cannot complete a KYC step. The user scans a QR,
 * their phone opens its camera, and the phone's live video appears in the
 * desktop's camera frame. The desktop then runs the SAME check it always runs —
 * nothing downstream knows the pixels came from another device.
 *
 * That video travels PEER TO PEER over WebRTC. It does not pass through here,
 * it is not stored here, and no image ever reaches this Worker on this path.
 *
 * ── Why a server is needed at all, given the QR ─────────────────────────────
 * WebRTC cannot connect without both sides exchanging an SDP — a DTLS
 * fingerprint and ICE credentials. Without the peer's fingerprint, DTLS never
 * completes and there is no connection. That is protocol, not preference.
 *
 * The QR carries the room id one way, desktop → phone. The phone's ANSWER has
 * to come back, and a desktop with no camera cannot scan a QR in return — which
 * is the whole premise. So the answer needs a place to be left. That place is
 * here, and it is the entire job: two short text blobs, a few seconds apart.
 *
 * ── Why it is safe to leave unauthenticated ─────────────────────────────────
 * Deliberately no auth, because the phone has no session and issuing it one
 * would be a far larger surface than this.
 *
 * What a room holds is an SDP: a DTLS fingerprint, ICE credentials and network
 * candidates. It is not a credential for anything in this system — it cannot
 * open a challenge, read a face, or commit a step. Guessing a room id is
 * guessing 128 bits inside a two-minute window, and the prize is the ability to
 * offer your own camera to a stranger's enrolment — which then has to pass
 * liveness and match the enrolled face.
 *
 * The room id is the capability, it is single-use, and it dies with the step.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * Mounted at /api/kyc/signal/*, ahead of nothing and behind only the request
 * logger. It reads no tenant, no secret, no bearer and no cookie, and shares no
 * code with the KYC pipeline. Deleting this file and its two lines in index.ts
 * and wrangler.toml returns the Worker exactly to what it was.
 */

/** Long enough that a room id cannot be guessed; short enough for a small QR. */
const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * An SDP is a few kilobytes. The cap is there so a room cannot be used as free
 * storage, not because any real offer approaches it.
 */
const MAX_SDP_BYTES = 16 * 1024;

/** Rooms live for one hand-off. A scan that takes longer has gone wrong. */
export const ROOM_TTL_MS = 2 * 60 * 1000;

type Role = 'offer' | 'answer';

function isRole(v: string): v is Role {
    return v === 'offer' || v === 'answer';
}

/**
 * One room, one hand-off.
 *
 * A Durable Object rather than KV because this is a handshake: the phone writes
 * an answer and the desktop reads it about a second later. KV is eventually
 * consistent and may serve a stale miss for that read, which would look like a
 * phone that scanned and then did nothing. A DO is strongly consistent and is
 * the primitive Cloudflare provides for exactly this.
 *
 * State never outlives the hand-off: every read checks the deadline, and the DO
 * sets an alarm to delete itself so an abandoned scan leaves nothing behind.
 */
export class SignalRoom {
    constructor(
        private state: DurableObjectState,
        _env: Env,
    ) {}

    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const role = url.searchParams.get('role') ?? '';
        if (!isRole(role)) {
            return Response.json({ error: 'role must be offer or answer' }, { status: 400 });
        }

        const expiresAt = (await this.state.storage.get<number>('expiresAt')) ?? 0;
        const now = Date.now();

        if (req.method === 'PUT') {
            const sdp = await req.text();
            if (!sdp || sdp.length > MAX_SDP_BYTES) {
                return Response.json({ error: 'bad sdp' }, { status: 400 });
            }

            // The FIRST write opens the room and starts its clock. A later write
            // cannot extend it — otherwise a room could be kept alive forever by
            // rewriting it, which is the one way this could become storage.
            if (!expiresAt) {
                const deadline = now + ROOM_TTL_MS;
                await this.state.storage.put('expiresAt', deadline);
                await this.state.storage.setAlarm(deadline);
            } else if (now > expiresAt) {
                return Response.json({ error: 'expired' }, { status: 410 });
            }

            // Write-once per role. A second offer or a second answer means
            // something is confused — a stale tab, a re-scan, or a third party —
            // and silently overwriting would point the desktop at whichever peer
            // wrote last.
            if (await this.state.storage.get<string>(role)) {
                return Response.json({ error: 'already set' }, { status: 409 });
            }

            await this.state.storage.put(role, sdp);
            return Response.json({ ok: true });
        }

        if (req.method === 'GET') {
            if (expiresAt && now > expiresAt) {
                await this.state.storage.deleteAll();
                return Response.json({ error: 'expired' }, { status: 410 });
            }

            const sdp = await this.state.storage.get<string>(role);
            // 204, not 404: "not yet" is the normal answer while the other side
            // is still scanning, and the poller must not treat it as an error.
            if (!sdp) return new Response(null, { status: 204 });

            // Reading the ANSWER completes the hand-off — the desktop has what
            // it needs and the room has no further purpose. Dropped immediately
            // rather than left to the alarm, so an SDP lives for seconds.
            if (role === 'answer') await this.state.storage.deleteAll();

            return new Response(sdp, {
                status: 200,
                headers: { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store' },
            });
        }

        return Response.json({ error: 'method not allowed' }, { status: 405 });
    }

    /** Nothing survives an abandoned scan. */
    async alarm() {
        await this.state.storage.deleteAll();
    }
}

export const signalRoutes = new Hono<{ Bindings: Env }>();

/**
 * PUT /api/kyc/signal/:room?role=offer|answer — leave an SDP.
 * GET /api/kyc/signal/:room?role=offer|answer — collect one (204 = not yet).
 *
 * The room id is chosen by the DESKTOP, from `crypto.randomUUID()`, and is what
 * the QR encodes. `idFromName` maps it to the object, so no id is minted here
 * and the two peers need no round trip to agree on one.
 */
signalRoutes.all('/:room', async (c) => {
    const room = c.req.param('room');
    if (!ROOM_ID.test(room)) {
        return c.json({ error: 'bad room' }, 400);
    }

    const stub = c.env.SIGNAL_ROOM.get(c.env.SIGNAL_ROOM.idFromName(room));
    return stub.fetch(new Request(c.req.url, c.req.raw));
});
