#!/usr/bin/env node
/**
 * Refreshes the MediaPipe WASM runtime in apps/web/public/vendor/mediapipe from
 * the installed @mediapipe/tasks-vision package.
 *
 * Unlike rdb — where public/vendor is gitignored because the KYC code is on its
 * way out — these files ARE committed here. This repo is the KYC service's
 * permanent home, and an identity flow should not depend on cdn.jsdelivr.net
 * being reachable at runtime. Our CSP is `script-src 'self' …` precisely so no
 * third-party origin can serve code into this flow.
 *
 * Run after bumping @mediapipe/tasks-vision, then commit the result:
 *   npm run sync:vendor
 *
 * public/vendor/opencv.js is NOT managed here — OpenCV ships no usable npm
 * browser build, so it is vendored manually from
 * https://docs.opencv.org/4.x/opencv.js
 */
import { mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'apps', 'web', 'public', 'vendor', 'mediapipe');

if (!existsSync(src)) {
    console.error(`[sync-vendor] not found: ${src}\nRun npm install first.`);
    process.exit(1);
}

mkdirSync(dest, { recursive: true });

let copied = 0;
let bytes = 0;
for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(dest, name));
    bytes += statSync(from).size;
    copied++;
}

console.log(
    `[sync-vendor] ${copied} files → apps/web/public/vendor/mediapipe (${(bytes / 1048576).toFixed(1)} MB)`,
);
console.log('[sync-vendor] these files are committed — remember to commit changes.');
