/**
 * Image operations for the KYC pipeline, backed by @cf-wasm/photon.
 *
 * Replaces `sharp` (a native libvips binding that cannot run on the Cloudflare
 * Workers runtime). Photon is a Rust→WASM library that bundles cleanly on workerd.
 * This module is the single place that touches the image library, so swapping it
 * again later only means editing here.
 *
 * Covers the three sharp operations the KYC code used:
 *   - dimensions      (was `sharp(buf).metadata()`)
 *   - crop → JPEG     (was `sharp(buf).extract(r).jpeg({quality}).toBuffer()`)
 *   - raw RGBA pixels (was `sharp(buf).extract(r).ensureAlpha().raw().toBuffer()`)
 *
 * Every PhotonImage is freed explicitly — WASM memory is not garbage-collected.
 */
import { PhotonImage, crop } from '@cf-wasm/photon';

export interface PixelRegion {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Decode and return image dimensions. */
export function getImageSize(buffer: Buffer): { width: number; height: number } {
    const img = PhotonImage.new_from_byteslice(new Uint8Array(buffer));
    try {
        return { width: img.get_width(), height: img.get_height() };
    } finally {
        img.free();
    }
}

/** Crop a region and encode it as a JPEG buffer (quality 0–100). */
export function cropToJpeg(buffer: Buffer, region: PixelRegion, quality = 90): Buffer {
    const img = PhotonImage.new_from_byteslice(new Uint8Array(buffer));
    let cropped: PhotonImage | undefined;
    try {
        cropped = crop(
            img,
            region.left,
            region.top,
            region.left + region.width,
            region.top + region.height,
        );
        return Buffer.from(cropped.get_bytes_jpeg(quality));
    } finally {
        cropped?.free();
        img.free();
    }
}

/**
 * Return raw RGBA pixels for the full image or a sub-region.
 * `data` is a tightly-packed RGBA byte array (4 bytes per pixel).
 */
export function getRawRgba(
    buffer: Buffer,
    region?: PixelRegion,
): { data: Uint8Array; width: number; height: number } {
    const img = PhotonImage.new_from_byteslice(new Uint8Array(buffer));
    let cropped: PhotonImage | undefined;
    try {
        const target =
            region &&
            (cropped = crop(
                img,
                region.left,
                region.top,
                region.left + region.width,
                region.top + region.height,
            ))
                ? cropped
                : img;
        return {
            data: target.get_raw_pixels(),
            width: target.get_width(),
            height: target.get_height(),
        };
    } finally {
        cropped?.free();
        img.free();
    }
}
