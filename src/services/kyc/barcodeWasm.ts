/**
 * The ID-back barcode reader: zxing-cpp compiled to WebAssembly (2026-11-25).
 *
 * The JavaScript port of ZXing (@zxing/library) never read a Syrian ID's PDF417
 * on a real capture ("no barcode decoded", every scan), so a Syrian back was never
 * compared with its front. zxing-cpp is the engine that port was translated from,
 * and reads dense or slightly blurred PDF417 that the port misses.
 *
 * The WASM is BUNDLED, not fetched: by default the library downloads it from a
 * CDN at first use, which a Worker should not depend on. Wrangler imports a
 * `.wasm` file as a compiled WebAssembly.Module, handed to Emscripten here.
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import zxingWasm from 'zxing-wasm/reader/zxing_reader.wasm';

let ready: Promise<unknown> | null = null;

function ensureModule(): Promise<unknown> {
    ready ??= Promise.resolve(
        prepareZXingModule({
            overrides: {
                instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
                    void WebAssembly.instantiate(zxingWasm, imports).then((instance) => done(instance));
                    return {};
                },
            },
            fireImmediately: true,
        }),
    );
    return ready;
}

/** The text of the first PDF417 / Data Matrix / QR code in an encoded image (JPEG, PNG), or null. */
export async function readBarcodeText(image: Uint8Array): Promise<string | null> {
    try {
        await ensureModule();
        const results = await readBarcodes(image, {
            formats: ['PDF417', 'DataMatrix', 'QRCode'],
            tryHarder: true,
            tryRotate: true,
            tryInvert: true,
            tryDownscale: true,
            maxNumberOfSymbols: 1,
        });
        const hit = results.find((r) => r.isValid && r.text);
        // Never the content — only its shape, which is what tells a readable
        // number from an encrypted payload when looking at the logs.
        console.log(
            hit
                ? `[barcodeWasm] decoded ${hit.format}: ${hit.text.length} chars, digit runs ${(hit.text.match(/\d+/g) ?? []).map((d) => d.length).join(',') || 'none'}`
                : '[barcodeWasm] no barcode decoded',
        );
        return hit?.text ?? null;
    } catch (err) {
        console.warn('[barcodeWasm] reader failed:', err instanceof Error ? err.message : String(err));
        return null;
    }
}
