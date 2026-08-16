// @ts-nocheck


/**
 * Turkish-ID fallback parser.
 *
 * AWS Textract `AnalyzeID` is trained primarily on US/EU documents and
 * routinely misclassifies Turkish national IDs as `DRIVER LICENSE FRONT`.
 * It also OCRs the printed Turkish labels (`TÜRKİYE`, `Soyadı/Surname`,
 * `Adı/Given Name(s)`) and pushes them into name fields, producing values
 * like `firstName: 'TORKIYE'`, `lastName: 'NOYADA'`. This module turns the
 * raw OCR lines into the structured fields the rest of the pipeline expects.
 *
 * Layout we target (front + back of a TR national ID):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  TÜRKİYE CUMHURİYETİ                       photo          │
 *   │  T.C. Kimlik No                                           │
 *   │  <11-digit national number>                                │
 *   │  Soyadı / Surname                                         │
 *   │  <last name>                                              │
 *   │  Adı / Given Name(s)                                      │
 *   │  <first name>                                             │
 *   │  Doğum Tarihi / Date of Birth                             │
 *   │  <DD.MM.YYYY>                                             │
 *   │  Cinsiyet / Gender   Uyruğu / Nationality                 │
 *   │  <E/K>               <T.C./TUR>                           │
 *   │  Belge No / Document No   Geçerlilik Süresi / Valid Until │
 *   │  <8-10 alphanumerics>     <DD.MM.YYYY>                    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Pure function — no AWS SDK calls inside. The caller hands us the lines.
 */

const DATE_FORMAT = /(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})/;
const TR_NATIONAL_NUMBER = /(\d{11})/;
// 🚀 خففنا تعقيد رقم الوثيقة ليلتقط أي أحرف وأرقام بين 8 و 11 خانة
const TR_DOCUMENT_NUMBER = /\b([A-Z0-9]{8,11})\b/i;

const TR_HEADER_HINTS = [
    /\bT[ÜUİI]RK[İI]YE\b/i,
    /T\.?\s*C\.?\s*KIMLIK/i,
    /T\.?\s*C\.?\s*\/\s*TUR\b/i,
    /republic\s+of\s+t[uü]rkiye/i,
    /republic\s+of\s+turkey/i,
    /kimlik\s+kart[ıi]/i,
    /identity\s*card/i,
];

// 🚀 التركيز على الكلمات الإنكليزية لأن Textract يقرأها بشكل ممتاز
const CUE_LAST_NAME = /surname|soyad|simes/i;
const CUE_FIRST_NAME = /given\s*name|ad[ıi]|name\s*\([s\)]/i;
const CUE_BIRTH = /do[ğg]um|birth/i;
const CUE_NATIONAL_NUMBER = /t\.?\s*c\.?\s*kimlik|identity\s*no|kimlik\s*no/i;
const CUE_DOCUMENT_NUMBER = /seri\s*no|belge\s*no|doc.*no/i;
const CUE_EXPIRY = /valid\s*until|ge[çc]erlilik|son\s*ge[çc]erlilik/i;
const CUE_GENDER = /cinsiyet|gender/i;
const CUE_NATIONALITY = /uyru[ğg]u|nationality/i;
const CUE_SIGNATURE = /imza|signature/i;
const MRZ_TUR = /^I[DI<][<I]TUR|^I<TUR/m;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 40;

/** Reject lines that are obviously labels, not values. */
function looksLikeLabel(line: string): boolean {
    return (
        CUE_LAST_NAME.test(line) ||
        CUE_FIRST_NAME.test(line) ||
        CUE_BIRTH.test(line) ||
        CUE_NATIONAL_NUMBER.test(line) ||
        CUE_DOCUMENT_NUMBER.test(line) ||
        CUE_EXPIRY.test(line) ||
        CUE_GENDER.test(line) ||
        CUE_NATIONALITY.test(line) ||
        CUE_SIGNATURE.test(line) ||
        TR_HEADER_HINTS.some((r) => r.test(line))
    );
}

/** Returns the substring after the first `:` separator if present. */
function valueAfterColon(line: string): string {
    const i = line.indexOf(':');
    if (i < 0) return '';
    return line.slice(i + 1).trim();
}

/** Walk forward from line `i` to the next non-label, non-empty line. */
function nextValueLine(lines: string[], i: number): string | undefined {
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (looksLikeLabel(candidate)) continue;
        return candidate;
    }
    return undefined;
}

/** Normalise a date string to `DD.MM.YYYY` if it matches our format. */
function normalizeDate(s: string): string | undefined {
    const m = s.match(DATE_FORMAT);
    if (!m) return undefined;
    const year = parseInt(m[3], 10);
    const currentYear = new Date().getFullYear();
    if (year < 1900 || year > currentYear + 30) return undefined;
    return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
}

export interface TurkishIdFields {
    firstName?: string;
    lastName?: string;
    name?: string;
    birthday?: string;
    nationalNumber?: string;
    documentNumber?: string;
    expiryDate?: string;
    gender?: string;
    /** Number of populated fields out of the seven above. */
    recovered: number;
    hasMinimumFields: boolean;
}

/** Detect whether the raw text suggests this is likely a Turkish ID. */
export function looksLikeTurkishId(rawLines: string[]): boolean {
    if (!rawLines || rawLines.length === 0) return false;
    for (const line of rawLines) {
        for (const hint of TR_HEADER_HINTS) {
            if (hint.test(line)) return true;
        }
        if (MRZ_TUR.test(line)) return true;
    }
    return false;
}
function extractInlineValue(line: string, cueRegex: RegExp): string | undefined {
    const i = line.indexOf(':');
    if (i >= 0) {
        const after = line.slice(i + 1).trim();
        if (after && !looksLikeLabel(after)) return after;
    }
    // Strip the cue label to see if the value is printed next to it
    const stripped = line.replace(cueRegex, '').trim();
    const cleaned = stripped.replace(/^[\/\-\s]+/, '').trim();
    if (cleaned && !looksLikeLabel(cleaned)) return cleaned;

    return undefined;
}
export function parseTurkishId(rawLines: string[]): TurkishIdFields {
    let firstName: string | undefined;
    let lastName: string | undefined;
    let birthday: string | undefined;
    let nationalNumber: string | undefined;
    let documentNumber: string | undefined;
    let expiryDate: string | undefined;
    let gender: string | undefined;

    // ── 1. البحث الكلاسيكي عبر الكلمات المفتاحية ──
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i].trim();
        if (!line) continue;

        // ── National number
        if (!nationalNumber) {
            if (CUE_NATIONAL_NUMBER.test(line)) {
                const inline = line.match(TR_NATIONAL_NUMBER);
                if (inline) nationalNumber = inline[1];
                else {
                    const next = nextValueLine(rawLines, i);
                    const m = next?.match(TR_NATIONAL_NUMBER);
                    if (m) nationalNumber = m[1];
                }
            } else if (!CUE_DOCUMENT_NUMBER.test(line)) {
                const m = line.match(TR_NATIONAL_NUMBER);
                if (m && line.replace(/\D+/g, '').length === 11) {
                    nationalNumber = m[1];
                }
            }
        }

        // ── Last name
        if (!lastName && CUE_LAST_NAME.test(line)) {
            const after = extractInlineValue(line, CUE_LAST_NAME);
            const candidate = after ?? nextValueLine(rawLines, i);
            if (
                candidate &&
                candidate.length >= MIN_NAME_LENGTH &&
                candidate.length <= MAX_NAME_LENGTH
            ) {
                lastName = candidate;
            }
        }

        // ── First name
        if (!firstName && CUE_FIRST_NAME.test(line) && !CUE_LAST_NAME.test(line)) {
            const after = extractInlineValue(line, CUE_FIRST_NAME);
            const candidate = after ?? nextValueLine(rawLines, i);
            if (
                candidate &&
                candidate.length >= MIN_NAME_LENGTH &&
                candidate.length <= MAX_NAME_LENGTH
            ) {
                firstName = candidate;
            }
        }

        // ── Date of birth
        if (!birthday && CUE_BIRTH.test(line)) {
            const inline = normalizeDate(line);
            if (inline) birthday = inline;
            else {
                const next = nextValueLine(rawLines, i);
                if (next) {
                    const norm = normalizeDate(next);
                    if (norm) birthday = norm;
                }
            }
        }

        // ── Document number
        if (!documentNumber && CUE_DOCUMENT_NUMBER.test(line)) {
            const after = extractInlineValue(line, CUE_DOCUMENT_NUMBER);
            const candidates = [after, nextValueLine(rawLines, i)].filter(
                (s): s is string => !!s && s.length > 0,
            );
            for (const c of candidates) {
                const m = c.match(TR_DOCUMENT_NUMBER);
                if (m) {
                    documentNumber = m[1];
                    break;
                }
            }
        }

        // ── Expiry
        if (!expiryDate && CUE_EXPIRY.test(line)) {
            const inline = normalizeDate(line);
            if (inline) expiryDate = inline;
            else {
                const next = nextValueLine(rawLines, i);
                if (next) {
                    const norm = normalizeDate(next);
                    if (norm) expiryDate = norm;
                }
            }
        }

        // ── Gender
        if (!gender && CUE_GENDER.test(line)) {
            const inline = extractInlineValue(line, CUE_GENDER);
            let candidate = inline ?? '';
            if (!candidate.match(/\b([EKMF])\b/i)) {
                for (let j = i + 1; j <= i + 3 && j < rawLines.length; j++) {
                    if (rawLines[j].match(/^\s*([EKMF])\s*(?:\/\s*[EKMF])?\s*$/i)) {
                        candidate = rawLines[j];
                        break;
                    }
                }
            }
            const m = candidate.match(/\b([EKMF])\b/i);
            if (m) gender = m[1].toUpperCase();
        }
    }

    // ── 2. الاعتماد على الهيكل (السحر لجمع الاسمين معاً) ──
    // إذا لم يجد الاسم، أو نريد ضمان دمج الاسمين الأول والثاني، نستخدم الرقم الوطني كنقطة بداية (Anchor)
    let anchorIndex = -1;
    for (let i = 0; i < rawLines.length; i++) {
        if (/^\d{11}$/.test(rawLines[i].replace(/\D/g, '')) && rawLines[i].length < 15) {
            anchorIndex = i;
            if (!nationalNumber) nationalNumber = rawLines[i].match(/\d{11}/)?.[0];
            break;
        }
    }

    // Matches gender value lines: "E", "K", "E / M", "K/F", etc. — never a name.
    const GENDER_VALUE = /^\s*[EKMF]\s*(\/\s*[EKMF])?\s*$/i;

    if (anchorIndex >= 0) {
        // جمع كل الأسطر النصية الصافية (التي لا تحتوي أرقاماً وليست عناوين) تحت الرقم الوطني
        const pureTextLines: string[] = [];
        for (let i = anchorIndex + 1; i < rawLines.length && pureTextLines.length < 3; i++) {
            const val = rawLines[i]
                .trim()
                .replace(/^[-\s—]+|[-\s—]+$/g, '') // تنظيف الشحطات من البداية والنهاية
                .replace(/--+/g, '');
            if (!val || /\d/.test(val) || looksLikeLabel(val) || GENDER_VALUE.test(val)) continue;
            pureTextLines.push(val);
        }
        console.log('Pure text lines under national number:', pureTextLines);
        // pureTextLines[0] = surname, pureTextLines[1] = given name
        if (pureTextLines.length > 0) {
            lastName = pureTextLines[0];
        }
        if (pureTextLines.length > 1) {
            firstName = pureTextLines[1];
        }
    }

    // Birthday fallback
    if (!birthday) {
        for (const line of rawLines) {
            if (CUE_EXPIRY.test(line)) continue;
            const norm = normalizeDate(line);
            if (norm) {
                birthday = norm;
                break;
            }
        }
    }

    const name = [firstName, lastName].filter(Boolean).join(' ').trim() || undefined;

    const recovered = [
        firstName,
        lastName,
        birthday,
        nationalNumber,
        documentNumber,
        expiryDate,
        gender,
    ].filter(Boolean).length;

    return {
        firstName,
        lastName,
        name,
        birthday,
        nationalNumber,
        documentNumber,
        expiryDate,
        gender,
        recovered,
        hasMinimumFields: !!(firstName && lastName && birthday && nationalNumber),
    };
}
