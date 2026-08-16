// @ts-nocheck


/**
 * Lebanese national ID fallback parser.
 *
 * Layout targeted (front of Lebanese Republic identity card):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  الجمهورية اللبنانية   وزارة الداخلية    photo            │
 *   │  بطاقة هوية                                               │
 *   │  الاسم: <first name>                                      │
 *   │  الشهرة: <family name>                                    │
 *   │  اسم الأب: <father's name>                                │
 *   │  اسم الأم وشهرتها: <mother's name>                        │
 *   │  محل الولادة: <place>                                     │
 *   │  تاريخ الولادة: YYYY/MM/DD (Arabic-Indic)                 │
 *   │  <11-digit national registration number>                  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Back of Lebanese ID:
 *   - Issue date, blood type, record number, address
 *   - PDF417 barcode (contains national number — decoded separately)
 *
 * Numbers are printed in Arabic-Indic glyphs (٠–٩); we ASCII-fold them.
 * Pure function — no AWS SDK calls. Caller supplies the raw Rekognition lines.
 */

const ARABIC_RANGE = /[\u0600-\u06FF]/;
const ELEVEN_DIGITS = /(\d{11})/;
// Lebanese dates are YYYY/MM/DD or DD/MM/YYYY in Arabic-Indic
const DATE_FORMAT = /(\d{1,4})[./\-](\d{1,2})[./\-](\d{1,4})/;

const FIRST_NAME_CUE  = /الاسم/;
const LAST_NAME_CUE   = /الشهرة/;
const BIRTH_DATE_CUE  = /تاريخ\s*الولادة/;

function normalizeDigits(s: string): string {
    return s
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function valueAfterSeparator(line: string): string {
    const idx = line.search(/[:\-]/);
    return idx < 0 ? '' : line.slice(idx + 1).trim();
}

export interface LebaneseIdFields {
    nationalNumber?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    birthday?: string;
    hasMinimumFields: boolean;
}

/** Detect whether the raw Rekognition lines look like a Lebanese national ID. */
export function looksLikeLebaneseId(rawLines: string[]): boolean {
    const joined = rawLines.join(' ');
    // Header markers unique to Lebanese IDs
    if (/اللبنانية|لبنان/.test(joined)) return true;
    if (/وزارة\s*الداخلية/.test(joined) && /بطاقة\s*هوية/.test(joined)) return true;
    return false;
}

export function parseLebaneseId(rawLines: string[]): LebaneseIdFields {
    let nationalNumber: string | undefined;
    let firstName: string | undefined;
    let lastName: string | undefined;
    let birthday: string | undefined;

    const normalizedLines = rawLines.map(normalizeDigits);
    const currentYear = new Date().getFullYear();

    const extractValueOrNext = (i: number, original: string): string | undefined => {
        const after = valueAfterSeparator(original);
        if (after.length >= 2) return after;
        if (i + 1 < rawLines.length) {
            const next = rawLines[i + 1].trim();
            if (next.length >= 2 && !FIRST_NAME_CUE.test(next) && !LAST_NAME_CUE.test(next))
                return next;
        }
        return undefined;
    };

    for (let i = 0; i < rawLines.length; i++) {
        const original = rawLines[i].trim();
        const line = normalizedLines[i].trim();
        if (!line) continue;

        // ── 11-digit national registration number ─────────────────────────
        if (!nationalNumber) {
            const digits = line.replace(/\D+/g, '');
            const m = digits.match(ELEVEN_DIGITS);
            if (m) nationalNumber = m[1];
        }

        // ── Date of birth ─────────────────────────────────────────────────
        if (!birthday) {
            const m = line.match(DATE_FORMAT);
            if (m) {
                let [, a, b, c] = m;
                // YYYY/MM/DD → a=year, b=month, c=day
                // DD/MM/YYYY → a=day, b=month, c=year
                let day: string, month: string, year: string;
                if (a.length === 4) {
                    year = a; month = b; day = c;
                } else {
                    day = a; month = b; year = c;
                }
                const y = parseInt(year, 10);
                if (y >= 1900 && y <= currentYear) {
                    birthday = `${day.padStart(2, '0')}.${month.padStart(2, '0')}.${year}`;
                }
            }
        }

        // ── First name (الاسم) ─────────────────────────────────────────────
        if (!firstName && FIRST_NAME_CUE.test(original) && !LAST_NAME_CUE.test(original)) {
            firstName = extractValueOrNext(i, original);
        }

        // ── Family name (الشهرة) ───────────────────────────────────────────
        if (!lastName && LAST_NAME_CUE.test(original)) {
            lastName = extractValueOrNext(i, original);
        }
    }

    const name = [firstName, lastName].filter(Boolean).join(' ').trim() || undefined;
    const presentFields = [nationalNumber, name, birthday].filter(Boolean).length;

    return {
        nationalNumber,
        firstName,
        lastName,
        name,
        birthday,
        hasMinimumFields: presentFields >= 3,
    };
}
