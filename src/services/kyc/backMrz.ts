/**
 * Back-side MRZ fields, parsed here so the OCR text never has to leave the
 * Worker.
 *
 * RDB's front/back consistency check (`verifyBackMatchesFront`) used to parse
 * the MRZ itself out of the back side's `rawText`. That meant shipping every
 * OCR'd line to the browser. It reads the structured `nationalNumber` /
 * `documentNumber` / `lastName` first and the MRZ only as a fallback, so filling
 * those fields here keeps the check identical without the raw text.
 *
 * Ported as-is from RDB's `parseMrzFromRawText` — keep the two in step until
 * the client copy is deleted.
 *
 * Turkish national ID back MRZ layout (TD1):
 *   Line 1: I<TUR<docNo(9)><checkDigit><nationalNo(11)><<<
 *   Line 2: YYMMDD<checkDigit><sex><expiryYYMMDD><checkDigit><nationality><<<...
 *   Line 3: LASTNAME<<FIRSTNAME<<<...
 *
 * Intentionally permissive — OCR may corrupt individual characters, so it
 * extracts by position where it can.
 */
export interface BackMrzFields {
    nationalNumber?: string;
    documentNumber?: string;
    lastName?: string;
}

export function parseBackMrz(rawText: string | undefined): BackMrzFields {
    if (!rawText) return {};

    // MRZ lines contain many '<' characters.
    const mrzLines = rawText
        .split('\n')
        .map((l) => l.trim().toUpperCase())
        .filter((l) => (l.match(/</g) ?? []).length >= 3);

    const result: BackMrzFields = {};

    for (const line of mrzLines) {
        // Line 1: document + national number.
        if (/^I[<A-Z]/.test(line) && line.includes('TUR')) {
            // The national number is the 11-digit run after the document
            // number field (position ≥ 14); fall back to the first one.
            const elevenDigit = [...line.matchAll(/\d{11}/g)];
            const candidate = elevenDigit.find((m) => (m.index ?? 0) >= 14) ?? elevenDigit[0];
            if (candidate) result.nationalNumber = candidate[0];

            const docMatch = line.match(/^I[<A-Z]TUR([A-Z0-9]{9})/);
            if (docMatch) result.documentNumber = docMatch[1];
        }

        // Line 3: LASTNAME<<FIRSTNAME<<<…
        if (line.includes('<<') && !/^I[<A-Z]/.test(line) && !/^\d{6}/.test(line)) {
            const [surname, given] = line.split('<<');
            if (surname && given !== undefined && /^[A-Z]+$/.test(surname)) result.lastName = surname;
        }
    }

    return result;
}
