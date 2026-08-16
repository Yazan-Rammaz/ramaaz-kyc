// @ts-nocheck


/**
 * Syrian-ID fallback parser.
 *
 * AWS Textract `AnalyzeID` is trained primarily on US/EU documents and often
 * returns `idType` UNKNOWN / no fields for Syrian national IDs (Arabic
 * script, 11-digit national number, non-standard layout). Rekognition
 * `DetectText` does a much better job on Arabic — but it returns raw lines
 * with no field mapping. This module turns those raw lines into the
 * structured fields the rest of the pipeline expects.
 *
 * Layout we target (front + back of a Syrian Arab Republic personal ID):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  الجمهورية العربية السورية      photo                     │
 *   │  وزارة الداخلية                                            │
 *   │  بطاقة شخصية                                              │
 *   │  الاسم: <first name>                                      │
 *   │  النسبة: <family name>                                    │
 *   │  اسم الأب: <father's name>                                │
 *   │  اسم و نسبة الأم: <mother's name>                         │
 *   │  محل و تاريخ الولادة: <city> <DD-MM-YYYY>                  │
 *   │  الرقم الوطني: <11-digit national number>                  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Numbers are printed in Arabic-Indic glyphs (٠–٩); we ASCII-fold them
 * before regex-matching.
 *
 * Pure function — no AWS SDK calls inside. The caller hands us the lines.
 */

const ARABIC_RANGE = /[\u0600-\u06FF]/;
const SYRIAN_NATIONAL_NUMBER = /(\d{11})/;
// Accept ., /, or - as separators (Syrian cards use - between day/month/year).
const DATE_FORMAT = /(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})/;

// Arabic field cues we recognise on Syrian IDs. Each entry yields one
// extracted value. The order matters — earlier patterns win.
const ARABIC_FIRST_NAME_CUE = /الاسم/;
const ARABIC_LAST_NAME_CUE = /النسبة/;
const ARABIC_BIRTH_CUE = /الولادة|الميلاد|تاريخ\s*الولادة/;
const ARABIC_NATIONAL_NUMBER_CUE = /الرقم\s*الوطني|الرقم\s*القومي/;
const LATIN_NAME_CUE = /\bname\b/i;

const MIN_ARABIC_NAME_LENGTH = 3; // Arabic words are short — معتز = 4 glyphs
const MIN_LATIN_NAME_LENGTH = 4;

/**
 * Convert Arabic-Indic (٠–٩) and Eastern Arabic-Indic (۰–۹) digits to ASCII.
 * Syrian IDs print the national number and date in Arabic-Indic digits, but
 * our regexes only match \d (ASCII). Without this step the parser sees no
 * numbers at all on a real Syrian card.
 */
function normalizeDigits(s: string): string {
    return s
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Fix common OCR substitutions in date fields.
 * Rekognition misreads ٦ (6) as `:` — "1-:-1983" → "1-6-1983".
 */
function fixOcrDateChars(s: string): string {
    return s
        .replace(/(\d)-:-([\d]{4})/g, '$1-6-$2')
        .replace(/(\d)-:-(\d)/g, '$1-6-$2');
}

/** Returns the substring after the first `:` or `-` separator, trimmed. */
function valueAfterSeparator(line: string): string {
    const sepIdx = line.search(/[:\-]/);
    if (sepIdx < 0) return '';
    return line.slice(sepIdx + 1).trim();
}

export interface SyrianIdFields {
    nationalNumber?: string;
    name?: string;
    birthday?: string;
    /** True if all 3 required fields (name, nationalNumber, birthday) were extracted. */
    hasMinimumFields: boolean;
}

/** Detect whether the raw text suggests this is likely a Syrian-style ID. */
export function looksLikeSyrianId(rawLines: string[]): boolean {
    const normalized = rawLines.map(normalizeDigits);
    const arabicLines = normalized.filter((l) => ARABIC_RANGE.test(l));
    if (arabicLines.length >= 3) return true;
    const has11Digit = normalized.some((l) => SYRIAN_NATIONAL_NUMBER.test(l));
    return arabicLines.length >= 1 && has11Digit;
}

export function parseSyrianId(rawLines: string[]): SyrianIdFields {
    let nationalNumber: string | undefined;
    let birthday: string | undefined;
    let firstName: string | undefined;
    let lastName: string | undefined;
    /** Generic Arabic line we'll keep as a name-of-last-resort. */
    let arabicFallbackName: string | undefined;

    const currentYear = new Date().getFullYear();
    // Pre-normalize each line so digit-extraction works on Arabic-Indic
    // numerals, but keep the original line for name extraction (Arabic
    // script must remain intact).
    const normalizedLines = rawLines.map(normalizeDigits);

    const extractValueOrNext = (i: number, original: string): string | undefined => {
        const after = valueAfterSeparator(original);
        if (after.length >= MIN_ARABIC_NAME_LENGTH) return after;
        if (i + 1 < rawLines.length) {
            const next = rawLines[i + 1].trim();
            if (next.length >= MIN_ARABIC_NAME_LENGTH) return next;
        }
        return undefined;
    };

    for (let i = 0; i < rawLines.length; i++) {
        const originalLine = rawLines[i].trim();
        const line = normalizedLines[i].trim();
        if (!line) continue;

        // ── National number — match BEFORE first/last cues, since the cue
        // line itself ("الرقم الوطني: ٠٩٠٧٠٠٦٠٣٩٩") contains the digits.
        if (!nationalNumber) {
            const digitsOnly = line.replace(/\D+/g, '');
            const numMatch = digitsOnly.match(SYRIAN_NATIONAL_NUMBER);
            if (numMatch) nationalNumber = numMatch[1];
        }

        // ── Date of birth — same line cues OR any line with DD-MM-YYYY.
        if (!birthday) {
            const dateMatch = fixOcrDateChars(line).match(DATE_FORMAT);
            if (dateMatch) {
                let year = parseInt(dateMatch[3], 10);
                // OCR frequently confuses ٩ (9) with ٦ (6) in Arabic-Indic script.
                // A year like 1683 or 1763 is implausible — attempt 6→9 substitution
                // in the year string to recover e.g. 1983, 1973, 1969.
                if ((year < 1900 || year > currentYear) && dateMatch[3].includes('6')) {
                    const corrected = parseInt(dateMatch[3].replace(/6/g, '9'), 10);
                    if (corrected >= 1900 && corrected <= currentYear) year = corrected;
                }
                if (year >= 1900 && year <= currentYear) {
                    birthday = `${dateMatch[1].padStart(2, '0')}.${dateMatch[2].padStart(2, '0')}.${year}`;
                }
            }
        }

        // ── First name (الاسم) — must NOT also match النسبة on the same line.
        if (
            !firstName &&
            ARABIC_FIRST_NAME_CUE.test(originalLine) &&
            !ARABIC_LAST_NAME_CUE.test(originalLine)
        ) {
            firstName = extractValueOrNext(i, originalLine);
        }

        // ── Family name (النسبة).
        if (!lastName && ARABIC_LAST_NAME_CUE.test(originalLine)) {
            lastName = extractValueOrNext(i, originalLine);
        }

        // ── Latin "Name:" cue (rare on Syrian IDs, kept for mixed-script scans).
        if (!firstName && LATIN_NAME_CUE.test(originalLine)) {
            const after = valueAfterSeparator(originalLine);
            if (after.length >= MIN_LATIN_NAME_LENGTH) firstName = after;
        }

        // ── Generic Arabic fallback — first reasonably long Arabic line that
        // isn't a header / cue line. Captures the name even if Rekognition
        // splits "الاسم:" and "معتز" onto separate lines and never reattaches.
        // IMPORTANT: reject strings that are pure digits (Arabic-Indic
        // numerals fall in U+0660–U+0669 which is inside the ARABIC_RANGE,
        // so a registration number like ٠١٧٥٨٤٥٦ would otherwise be
        // mistaken for a name on the back side).
        const isAllDigitsOrPunct = /^[\d\s./\-#]+$/.test(line);
        if (
            !arabicFallbackName &&
            ARABIC_RANGE.test(originalLine) &&
            originalLine.length >= MIN_ARABIC_NAME_LENGTH &&
            !isAllDigitsOrPunct &&
            !ARABIC_FIRST_NAME_CUE.test(originalLine) &&
            !ARABIC_LAST_NAME_CUE.test(originalLine) &&
            !ARABIC_BIRTH_CUE.test(originalLine) &&
            !ARABIC_NATIONAL_NUMBER_CUE.test(originalLine) &&
            // Skip the standard header phrases.
            !/الجمهورية|وزارة|بطاقة\s*شخصية/.test(originalLine)
        ) {
            arabicFallbackName = originalLine;
        }
    }

    // Compose the best-available name: "<first> <last>" if we have both,
    // else whichever cue-matched piece we found, else the first generic
    // Arabic line.
    const name =
        [firstName, lastName].filter(Boolean).join(' ').trim() || arabicFallbackName || undefined;

    const presentFields = [nationalNumber, name, birthday].filter(Boolean).length;
    return {
        nationalNumber,
        name,
        birthday,
        hasMinimumFields: presentFields >= 3,
    };
}
