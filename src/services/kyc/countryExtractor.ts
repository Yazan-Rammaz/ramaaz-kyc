// @ts-nocheck


/**
 * Country extraction from raw OCR text.
 *
 * AWS Textract `AnalyzeID` exposes a `COUNTY` field (US-specific column on
 * driver licences) which is rarely populated for international IDs and never
 * carries an actual country name. Real ID cards print the country either as
 * a header phrase (`REPUBLIC OF TURKEY`, `KINGDOM OF THE NETHERLANDS`,
 * `الجمهورية العربية السورية`), as a `T.C./TUR` marker, or as an ISO-3 code
 * embedded in the MRZ (Machine Readable Zone). This module recovers the
 * country from any of those signals.
 *
 * Stage order (first hit wins):
 *   1. Known country phrases / synonyms — most reliable.
 *   2. `T.C./XXX` Turkey-style country marker.
 *   3. MRZ country code at positions 2–4 of an `IDD<XXX...` or `I<XXX...` line.
 *
 * Pure function — no AWS calls. Caller passes us the rawText.
 */

export interface CountryHit {
    name: string;
    iso3: string;
    /** Which stage matched — useful for logs / diagnostics. */
    via: 'phrase' | 'tc_marker' | 'mrz';
}

/**
 * Common KYC origin countries with the phrases / synonyms we expect to see
 * on the front of a national ID, residence permit, or passport. Order
 * matters — longer / more specific phrases come first so they win over
 * shorter substrings.
 */
const COUNTRY_PHRASES: Array<{ name: string; iso3: string; phrases: RegExp[] }> = [
    {
        name: 'Turkey',
        iso3: 'TUR',
        phrases: [
            /republic\s+of\s+t[uü]rkiye/i,
            /republic\s+of\s+turkey/i,
            /t[uü]rkiye\s+cumhuriyeti/i,
            /kimlik\s+kart[ıi]/i,
            /\bT[ÜUO]RKIYE\b/,
            /\bTURKIYE\b/,
        ],
    },
    {
        name: 'Syria',
        iso3: 'SYR',
        phrases: [
            /syrian\s+arab\s+republic/i,
            /\u0627\u0644\u062c\u0645\u0647\u0648\u0631\u064a\u0629\s+\u0627\u0644\u0639\u0631\u0628\u064a\u0629\s+\u0627\u0644\u0633\u0648\u0631\u064a\u0629/, // الجمهورية العربية السورية
        ],
    },
    {
        name: 'Netherlands',
        iso3: 'NLD',
        phrases: [
            /kingdom\s+of\s+the\s+netherlands/i,
            /koninkrijk\s+der\s+nederlanden/i,
            /royaume\s+des\s+pays-bas/i,
            /\bNEDERLAND(?:SE|EN)?\b/i,
        ],
    },
    {
        name: 'United States',
        iso3: 'USA',
        phrases: [
            /united\s+states\s+of\s+america/i,
            /\bU\.?S\.?A\.?\b/,
        ],
    },
    {
        name: 'United Kingdom',
        iso3: 'GBR',
        phrases: [
            /united\s+kingdom/i,
            /great\s+britain/i,
        ],
    },
    { name: 'Germany', iso3: 'DEU', phrases: [/bundesrepublik\s+deutschland/i, /\bDEUTSCHLAND\b/i] },
    { name: 'France', iso3: 'FRA', phrases: [/r[ée]publique\s+fran[çc]aise/i] },
    { name: 'Spain', iso3: 'ESP', phrases: [/reino\s+de\s+espa[ñn]a/i, /\bESPA[ÑN]A\b/i] },
    { name: 'Italy', iso3: 'ITA', phrases: [/repubblica\s+italiana/i] },
    { name: 'Saudi Arabia', iso3: 'SAU', phrases: [/kingdom\s+of\s+saudi\s+arabia/i] },
    { name: 'United Arab Emirates', iso3: 'ARE', phrases: [/united\s+arab\s+emirates/i, /\bU\.?A\.?E\.?\b/] },
    { name: 'Egypt', iso3: 'EGY', phrases: [/arab\s+republic\s+of\s+egypt/i] },
    { name: 'Jordan', iso3: 'JOR', phrases: [/hashemite\s+kingdom\s+of\s+jordan/i] },
    { name: 'Lebanon', iso3: 'LBN', phrases: [/lebanese\s+republic/i] },
    { name: 'Iraq', iso3: 'IRQ', phrases: [/republic\s+of\s+iraq/i] },
    { name: 'Iran', iso3: 'IRN', phrases: [/islamic\s+republic\s+of\s+iran/i] },
];

/**
 * ISO-3 → country name lookup, used by stages 2 and 3 (T.C. marker / MRZ).
 * Built from COUNTRY_PHRASES above so we have a single source of truth.
 */
const ISO3_TO_NAME: Record<string, string> = COUNTRY_PHRASES.reduce(
    (acc, c) => {
        acc[c.iso3] = c.name;
        return acc;
    },
    {} as Record<string, string>,
);

const TC_MARKER = /T\.?\s*C\.?\s*\/\s*([A-Z]{3})\b/;
// MRZ first line on a TD1/TD2 ID: starts with `I` (or `P` for passports)
// then a filler char (`<` or country prefix) then ISO-3.
const MRZ_COUNTRY = /^[IP][<DA-Z]([A-Z]{3})/m;

/**
 * Resolve the country from raw OCR text. Returns `undefined` when none of
 * the three stages produced a hit.
 */
export function extractCountry(rawText: string | undefined): CountryHit | undefined {
    if (!rawText) return undefined;

    // Stage 1 — known phrases.
    for (const c of COUNTRY_PHRASES) {
        for (const p of c.phrases) {
            if (p.test(rawText)) {
                return { name: c.name, iso3: c.iso3, via: 'phrase' };
            }
        }
    }

    // Stage 2 — `T.C./TUR` Turkey marker. Even though we'd usually catch
    // Turkey via the phrase, this also catches scans where only the marker
    // is legible.
    const tc = rawText.match(TC_MARKER);
    if (tc) {
        const iso3 = tc[1];
        return { name: ISO3_TO_NAME[iso3] ?? iso3, iso3, via: 'tc_marker' };
    }

    // Stage 3 — MRZ country code. Must be a known ISO-3 in our dictionary;
    // an unknown 3-letter code on a non-MRZ line would otherwise produce
    // false positives.
    const mrz = rawText.match(MRZ_COUNTRY);
    if (mrz) {
        const iso3 = mrz[1];
        const name = ISO3_TO_NAME[iso3];
        if (name) return { name, iso3, via: 'mrz' };
    }

    return undefined;
}
