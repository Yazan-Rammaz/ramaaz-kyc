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

/*
 * The labels printed on a Syrian ID, most specific first ("اسم و نسبة الأم"
 * holds "نسبة", "محل و تاريخ الولادة" holds "تاريخ"). Tatweel (ـ, the stretch
 * stroke: "النسـبة") is removed before matching.
 */
const FIELD_LABELS: { key: string; re: RegExp }[] = [
    { key: 'mother', re: /اسم\s*و?\s*نسبة\s*ال[أاإ]م/g },
    { key: 'father', re: /اسم\s*ال[أاإ]ب/g },
    { key: 'birth', re: /محل\s*و?\s*تاريخ\s*الولادة|تاريخ\s*الولادة|محل\s*الولادة/g },
    { key: 'national', re: /الرقم\s*الوطني/g },
    { key: 'last', re: /النسبة/g },
    { key: 'first', re: /الاسم/g },
];
const TATWEEL = /ـ/g;

/** The labelled fields in one OCR line, each value ending where the next label starts. */
function fieldSegments(line: string): { key: string; value: string }[] {
    const text = line.replace(TATWEEL, '');
    const hits: { key: string; start: number; end: number }[] = [];
    for (const { key, re } of FIELD_LABELS) {
        for (const m of text.matchAll(re)) {
            const start = m.index ?? 0;
            const end = start + m[0].length;
            // A shorter label inside one already found ("نسبة" in "اسم و نسبة الأم") is not another field.
            if (hits.some((h) => start < h.end && end > h.start)) continue;
            hits.push({ key, start, end });
        }
    }
    hits.sort((a, b) => a.start - b.start);
    return hits.map((h, i) => ({
        key: h.key,
        value: stripLabels(text.slice(h.end, hits[i + 1]?.start ?? text.length)),
    }));
}

/** A value with no label words, separators or stray punctuation left in it. */
function stripLabels(s: string): string {
    let v = s.replace(TATWEEL, '');
    for (const { re } of FIELD_LABELS) v = v.replace(re, ' ');
    return v.replace(/[:：\-–]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface SyrianIdFields {
    nationalNumber?: string;
    name?: string;
    /** From the الاسم cue only — never guessed from the generic fallback line. */
    firstName?: string;
    /** From the النسبة cue only. */
    lastName?: string;
    birthday?: string;
    /** True if all 3 required fields (name, nationalNumber, birthday) were extracted. */
    hasMinimumFields: boolean;
}

/** Detect whether the raw text suggests this is likely a Syrian-style ID. */
export function looksLikeSyrianId(rawLines: string[]): boolean {
    // Not a Lebanese card (2026-11-25). Any three Arabic lines matched below, and a
    // Lebanese ID has them too ("الجمهورية … وزارة الداخلية"): this check runs first,
    // so the Syrian parser took Lebanese cards, found no Syrian fields, and the person
    // was told their name and birth date could not be read — while the Lebanese
    // parser, never reached, reads them.
    if (/اللبنانية|لبنان/.test(rawLines.join(' '))) return false;
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

        // ── First name (الاسم) and family name (النسبة), by labelled segment.
        // OCR can join two fields into one line ("الاسم: يزن النسبة: ادنوف"); each
        // value now ends where the next label starts, and a value never carries a
        // label word (see fieldSegments).
        const segs = fieldSegments(originalLine);
        for (const s of segs) {
            if (s.key !== 'first' && s.key !== 'last') continue;
            if (s.key === 'first' ? firstName : lastName) continue;
            let value = s.value.length >= MIN_ARABIC_NAME_LENGTH ? s.value : undefined;
            // Label alone on its line: the value is the next line, if that line is not a label itself.
            if (!value && s === segs[segs.length - 1] && i + 1 < rawLines.length) {
                const next = stripLabels(rawLines[i + 1]);
                if (fieldSegments(rawLines[i + 1]).length === 0 && next.length >= MIN_ARABIC_NAME_LENGTH) value = next;
            }
            if (s.key === 'first') firstName = value;
            else lastName = value;
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
        firstName,
        lastName,
        birthday,
        hasMinimumFields: presentFields >= 3,
    };
}
