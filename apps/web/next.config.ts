import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    async headers() {
        // The KYC flow is embedded in a Flutter webview and reached by redirect
        // from consumer apps, so it must NOT be frameable by arbitrary origins.
        // frame-ancestors is left restrictive here; add explicit consumer origins
        // when/if an in-page iframe embed is required.
        const csp = [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            // 'unsafe-eval' is required by the OpenCV wasm/asm build used during
            // ID capture. blob: covers the document-scanner Web Worker.
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "media-src 'self' blob:",
            // `data:` is required by opencv.js, which fetches its own WASM from an
            // embedded data: URI. Omitting it cost hours in rdb: OpenCV silently
            // fails to initialise, the document scanner never emits corners, and ID
            // capture sits on "Card detected — scanning…" forever because a
            // *different* (Sobel) detector drives that status text and keeps working.
            "connect-src 'self' data: https:",
            "worker-src 'self' blob:",
            "child-src 'self' blob:",
            'upgrade-insecure-requests',
        ].join('; ');

        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'Content-Security-Policy', value: csp },
                    {
                        key: 'Strict-Transport-Security',
                        value: 'max-age=31536000; includeSubDomains',
                    },
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                    {
                        // This origin exists to use the camera; microphone is not needed.
                        key: 'Permissions-Policy',
                        value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
                    },
                ],
            },
        ];
    },
};

export default nextConfig;
