/**
 * Characters OCR puts in a NAME that no name has (2026-11-25).
 *
 * "Barış Gürbüş" came back as "Bari$ Gurbu$": the cedilla under Ş reads as the
 * stroke of a dollar sign. A name never holds `$`, a digit, or a pipe, so each is
 * mapped to the letter OCR mistook it for. Applied once to every document's result
 * (see analyzeIdDocument), whichever parser produced it. Arabic names are untouched:
 * only these Latin look-alikes are replaced.
 */

/** Ş on a Turkish document, plain S anywhere else (a non-Turkish Latin name has no Ş). */
function dollarAs(countryIso3?: string): string {
    return countryIso3 === 'TUR' ? 'Ş' : 'S';
}

export function fixNameOcr(value: string | undefined, countryIso3?: string): string | undefined {
    if (!value) return value;
    const s = dollarAs(countryIso3);
    const fixed = value
        // Upper case in an upper-case word ("BARI$" → "BARIŞ"), lower case after a lower-case letter ("Bari$" → "Bariş").
        .replace(/\$/g, (_, at: number) => (/[a-zà-ÿ]/.test(value[at - 1] ?? '') ? s.toLowerCase() : s))
        // A digit or pipe INSIDE a Latin word is a letter misread (0→O, 1/|→I, 5→S, 8→B).
        .replace(/(?<=[A-Za-zÀ-ÖØ-öø-ſ])[0158|]|[0158|](?=[A-Za-zÀ-ÖØ-öø-ſ])/g, (c) => ({ '0': 'O', '1': 'I', '|': 'I', '5': 'S', '8': 'B' })[c] ?? c)
        .replace(/\s+/g, ' ')
        .trim();
    return fixed;
}

/**
 * A Latin name in normal case — "BILAL OMRAN" → "Bilal Omran" (2026-11-25): documents
 * print names in capitals, the MRZ always does, and the result mixed them ("Bilal
 * OMRAN"). Each word, and each part of a hyphenated or apostrophed one ("Anna-Maria",
 * "O'Neil"), starts upper case. A Turkish document lowers in Turkish, so "BARIŞ" is
 * "Barış" and "İLHAN" is "İlhan". Arabic, which has no case, is left as it is.
 */
export function nameCase(value: string | undefined, countryIso3?: string): string | undefined {
    if (!value) return value;
    const locale = countryIso3 === 'TUR' ? 'tr' : 'en';
    return value.replace(/\p{L}+/gu, (word) =>
        /[A-Za-zÀ-ɏ]/.test(word)
            ? word.charAt(0).toLocaleUpperCase(locale) + word.slice(1).toLocaleLowerCase(locale)
            : word,
    );
}

/** The name fields of an extracted document, corrected; every other field as it was. */
export function fixExtractedNames<T extends { name?: string; firstName?: string; lastName?: string; countryIso3?: string }>(
    extracted: T,
): T {
    const iso = extracted.countryIso3;
    const name = nameCase(fixNameOcr(extracted.name, iso), iso);
    const firstName = nameCase(fixNameOcr(extracted.firstName, iso), iso);
    const lastName = nameCase(fixNameOcr(extracted.lastName, iso), iso);
    if (name !== extracted.name || firstName !== extracted.firstName || lastName !== extracted.lastName) {
        console.log(`[nameOcr] corrected "${extracted.name ?? ''}" → "${name ?? ''}"`);
    }
    return { ...extracted, name, firstName, lastName };
}
