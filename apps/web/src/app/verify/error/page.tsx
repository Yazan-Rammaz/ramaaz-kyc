import React from 'react';

/**
 * Terminal error page for a verification that could not start.
 *
 * Messages are intentionally vague. This endpoint is reachable by anyone with a
 * crafted link, so distinguishing "bad signature" from "wrong audience" would
 * turn it into an oracle for probing the token format. The specific reason is
 * logged server-side in /verify/face/start.
 */
const MESSAGES: Record<string, string> = {
    expired: 'This verification link has expired. Please start again from the app.',
    invalid_link: 'This verification link is not valid.',
    no_session: 'This verification session has ended. Please start again from the app.',
};

export default async function VerifyErrorPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const raw = params.code;
    const code = (Array.isArray(raw) ? raw[0] : raw) ?? 'invalid_link';
    const message = MESSAGES[code] ?? MESSAGES.invalid_link;

    return (
        <main className="flex h-dvh items-center justify-center px-8">
            <p className="max-w-xs text-center text-sm text-[#8D8D8D]">{message}</p>
        </main>
    );
}
