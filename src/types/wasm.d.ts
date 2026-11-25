// Wrangler bundles an imported `.wasm` file as a compiled module (see barcodeWasm.ts).
declare module '*.wasm' {
    const module: WebAssembly.Module;
    export default module;
}
