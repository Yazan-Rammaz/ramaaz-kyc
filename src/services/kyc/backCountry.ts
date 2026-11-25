/**
 * Which country issued the card whose BACK this is (2026-11-25).
 *
 * The client matches a back to its front on the ID number, the document number
 * or the surname — and a Syrian ID's back carries none of them (a registration
 * number, an issue date, a barcode). With nothing to compare it was accepted,
 * so a Lebanese front went through with a Syrian back. The back's country is
 * now returned (`countryIso3`) so the client can refuse a mismatch.
 *
 * Only what the text proves; anything unsure is left undefined, and the client
 * then falls back to what it compared before. Pure — the caller hands in the OCR.
 */
import { looksLikeLebaneseId } from './lebaneseIdParser';

/** Fields printed only on the back of a Syrian personal ID. */
const SYRIAN_BACK_CUES = [/الأمانة|الامانة/, /لون\s*العينين/, /لون\s*الوجه/, /العلامات\s*المميزة/];

export function backCountryIso3(rawText: string): string | undefined {
    const lines = rawText.split('\n').map((l) => l.trim());
    // An MRZ names its issuer: TD1 cards start "I<TUR…", "IDTUR…", passports "P<SYR…".
    for (const l of lines) {
        const m = l.replace(/\s+/g, '').match(/^[ACIP][A-Z<]([A-Z]{3})[A-Z0-9<]{5,}/);
        if (m && m[1] && /<{2,}/.test(l)) return m[1];
    }
    if (looksLikeLebaneseId(lines)) return 'LBN';
    if (SYRIAN_BACK_CUES.filter((re) => re.test(rawText)).length >= 2) return 'SYR';
    return undefined;
}

export const ISO3_COUNTRY: Record<string, string> = { SYR: 'Syria', LBN: 'Lebanon', TUR: 'Turkey' };
