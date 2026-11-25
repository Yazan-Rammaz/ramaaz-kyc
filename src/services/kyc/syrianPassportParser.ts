/**
 * Syrian passport — the printed (visual) fields, which win over the MRZ.
 *
 * ⚠️ Why (2026-11-25). On a Syrian passport the MRZ is NOT the holder's name:
 *
 *   PNSYROMRAN<<ALI<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
 *
 * reads surname OMRAN and given name ALI — and ALI is the FATHER's name. The
 * holder, Bilal, appears only in the printed fields above it. Textract, for
 * its part, put the father in FIRST_NAME and the mother (Ameera) in
 * MIDDLE_NAME, so the result was "ALI AMEERA OMRAN". And its EXPIRATION_DATE
 * was the Date of Issue (04/10/2023) — the real expiry is 15/10/2028.
 *
 * The printed page labels every field in English and Arabic:
 *
 *   Name Bilal                 الاسم بلال
 *   Surname Omran              النسبة عمران
 *   Father Name Ali            اسم الأب علي
 *   Mother Name Ameera         اسم الأم اميرة
 *   Date of Expiry  15/10/2028 تاريخ انتهاء الصلاحية
 *   Date of Issue   04/10/2023 تاريخ الإصدار
 *
 * OCR returns each as one line ("Name Bilal") or as the label and the value on
 * separate lines; both are read. Pure — the caller hands in the OCR lines.
 */

export interface SyrianPassportFields {
    givenName?: string;
    surname?: string;
    fatherName?: string;
    motherName?: string;
    /** DD/MM/YYYY, as printed. */
    expiryDate?: string;
    issueDate?: string;
}

/** True when the OCR looks like a Syrian passport photo page. */
export function looksLikeSyrianPassport(lines: string[], countryIso3?: string): boolean {
    const text = lines.join('\n');
    const syrian = countryIso3 === 'SYR' || /SYRIAN\s*ARAB\s*REPUBLIC|الجمهورية العربية السورية|P[<A-Z]SYR/i.test(text);
    const passport = /PASSPORT|جواز\s*سفر|^P[<A-Z]SYR/im.test(text);
    return syrian && passport;
}

const DATE = /(\d{1,2})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{4})/;

/** A Latin name value: letters only, one to three words, and not a label. */
function asName(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.replace(/[^A-Za-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
    if (v.length < 2 || v.split(' ').length > 3) return undefined;
    if (LABEL_WORDS.test(v)) return undefined;
    return v;
}
const LABEL_WORDS =
    /\b(name|surname|father|mother|date|birth|place|sex|type|code|country|passport|national|expiry|issue|syrian|arab|republic)\b/i;

/** Edit distance — OCR misspells the labels ("Sumame", "Date of Esper", "Father Nam"). */
function distance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
}
const near = (word: string | undefined, label: string, max: number) => !!word && distance(word.toLowerCase(), label) <= max;

/**
 * Which field a line is labelled with, and how many words the label takes. Matched
 * loosely (2026-11-25): an exact "Surname" missed the scan where OCR read it
 * otherwise, the surname fell back to Textract's LAST_NAME — the given name again —
 * and the result was "Bilal BILAL".
 */
function labelOf(words: string[]): { key: 'givenName' | 'surname' | 'fatherName' | 'motherName'; take: number } | null {
    const [a, b] = words;
    // "Father Name" / "Mother Name": the second word is "Name" misread, or a stray letter.
    const second = near(b, 'name', 2) || (b !== undefined && b.length <= 2) ? 2 : 1;
    if (near(a, 'father', 2)) return { key: 'fatherName', take: second };
    if (near(a, 'mother', 2)) return { key: 'motherName', take: second };
    if (near(a, 'surname', 2)) return { key: 'surname', take: 1 };
    if (a && b && near(a + b, 'surname', 2)) return { key: 'surname', take: 2 };
    if (near(a, 'given', 1) && near(b, 'names', 2)) return { key: 'givenName', take: 2 };
    // "Name", or misread ("Narne") — but starting with N, so "Date" is never taken for it.
    if (a && a.length >= 3 && (near(a, 'name', 1) || (/^n/i.test(a) && near(a, 'name', 2)))) return { key: 'givenName', take: 1 };
    return null;
}

export function parseSyrianPassport(lines: string[]): SyrianPassportFields {
    const out: SyrianPassportFields = {};
    const clean = lines.map((l) => l.trim()).filter(Boolean);
    // The Latin part of a line (OCR often appends the Arabic label to it).
    const latin = (s: string) => s.replace(/[\u0600-\u06FF]+/g, ' ').replace(/[:.]/g, ' ').replace(/\s+/g, ' ').trim();

    clean.forEach((line, i) => {
        const l = latin(line);
        const words = l.split(' ');
        const label = labelOf(words);
        if (label && !out[label.key]) {
            const next = latin(clean[i + 1] ?? '');
            const value = asName(words.slice(label.take).join(' ')) ?? (labelOf(next.split(' ')) ? undefined : asName(next));
            if (value) out[label.key] = value;
        }
        // "Date of Expiry" / "Date of Issue", however OCR spells the last word ("Esper", "Impo").
        if (!/birth/i.test(l)) {
            if (!out.expiryDate && (/expir/i.test(l) || /\bdate\s*of\s*e/i.test(l))) out.expiryDate = dateNear(clean, i);
            if (!out.issueDate && (/\bissue\b/i.test(l) || /\bdate\s*of\s*i/i.test(l)) && !/place/i.test(l)) out.issueDate = dateNear(clean, i);
        }
    });
    return out;
}

/** The date on this line, else on one of the next two. */
function dateNear(lines: string[], i: number): string | undefined {
    for (let j = i; j <= i + 2 && j < lines.length; j++) {
        const m = lines[j]?.match(DATE);
        if (m && m[1] && m[2] && m[3]) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
    }
    return undefined;
}

/** The surname from MRZ line 1 ("PNSYROMRAN<<ALI…" → OMRAN), even when OCR cut the line short. */
function mrzSurname(lines: string[]): string | undefined {
    for (const raw of lines) {
        const m = raw.replace(/\s+/g, '').match(/^P[<A-Z]SYR([A-Z]+(?:<[A-Z]+)*)<</);
        if (m && m[1]) return m[1].replace(/</g, ' ');
    }
    return undefined;
}

/** The latest date printed on the page — on a passport, the expiry. */
function latestDate(lines: string[]): string | undefined {
    let best: { key: number; text: string } | undefined;
    for (const l of lines)
        for (const m of l.matchAll(new RegExp(DATE.source, 'g'))) {
            const [, d, mo, y] = m;
            if (!d || !mo || !y) continue;
            const key = Number(y) * 10000 + Number(mo) * 100 + Number(d);
            if (!best || key > best.key) best = { key, text: `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${y}` };
        }
    return best?.text;
}

/**
 * Correct a Syrian passport's extracted name and expiry from its printed fields.
 * Fields that could not be read are left as they were — except a name built from
 * the father's or mother's name, which is never kept.
 */
export function fixSyrianPassport<
    T extends {
        name?: string;
        firstName?: string;
        lastName?: string;
        expirationDate?: string;
        expiryDate?: string;
        country?: string;
        countryIso3?: string;
    },
>(extracted: T, lines: string[]): T {
    const p = parseSyrianPassport(lines);
    const same = (a?: string, b?: string) => !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
    // The parents' names, kept out of the holder's: printed, plus Textract's first name
    // when it is not the printed given name — on these passports AWS puts the FATHER
    // there (FIRST_NAME "ALI" on the "Bilal" scans).
    const parents = [
        p.fatherName,
        p.motherName,
        p.givenName && extracted.firstName && !same(extracted.firstName, p.givenName) ? extracted.firstName : undefined,
    ].filter(Boolean) as string[];
    // Loosely: OCR read the father's ALI as "ALD" in the MRZ (2026-11-25).
    const isParent = (w: string) =>
        parents.some((x) => same(x, w) || (w.length >= 3 && x.length >= 3 && distance(w.toUpperCase(), x.toUpperCase()) <= 1));
    const notParent = (w: string) => !isParent(w);
    // A surname's first word is always kept; a further word that is a parent's name is the
    // MRZ's given-name field run on — "OMRAN<ALD" when OCR read the "<<" as one "<".
    const surnameOnly = (s?: string) => {
        if (!s) return s;
        const [head, ...rest] = s.split(/\s+/);
        return [head, ...rest.filter(notParent)].join(' ');
    };

    let firstName = p.givenName ?? extracted.firstName;
    // The MRZ / Textract "first name" is the father's when the printed one was not read.
    if (!p.givenName && parents.some((x) => same(x, firstName))) firstName = undefined;
    // Surname: printed, else the MRZ's (reliable here), else Textract's — and never the
    // given name again (Textract's LAST_NAME was "BILAL" on the "Bilal BILAL" scan).
    const fromMrz = surnameOnly(mrzSurname(lines));
    let lastName = p.surname ?? fromMrz ?? surnameOnly(extracted.lastName);
    if (same(lastName, firstName)) lastName = fromMrz && !same(fromMrz, firstName) ? fromMrz : undefined;
    const name = firstName
        ? [firstName, lastName].filter(Boolean).join(' ')
        : (extracted.name ?? '').split(/\s+/).filter((w) => w && notParent(w)).join(' ') || undefined;

    // Expiry: the LATEST date printed — on a passport it always is (birth < issue < expiry).
    // Ahead of the labels: OCR misreads them ("Date of Esper") and lines them up with the
    // wrong date, which made the issue date 15/10/2028 on the "Bilal" scan. The printed
    // label, then Textract's value, only when the page shows no date at all; never the issue date.
    let expiry = latestDate(lines) ?? p.expiryDate ?? extracted.expirationDate;
    if (!latestDate(lines) && !p.expiryDate && p.issueDate && sameDate(expiry, p.issueDate)) expiry = undefined;

    console.log(
        `[syrianPassport] printed fields: given=${p.givenName ?? '-'} surname=${p.surname ?? '-'} father=${p.fatherName ?? '-'} ` +
            `mother=${p.motherName ?? '-'} expiry=${p.expiryDate ?? '-'} issue=${p.issueDate ?? '-'} → name="${name ?? ''}" expiry=${expiry ?? '-'}`,
    );
    // A Syrian passport's country is Syria — not the place of birth Textract offered ("DAMASCUS").
    return {
        ...extracted,
        name,
        firstName,
        lastName,
        expirationDate: expiry,
        expiryDate: expiry,
        country: 'Syria',
        countryIso3: 'SYR',
    };
}

function sameDate(a?: string, b?: string): boolean {
    const n = (s?: string) => {
        const m = s?.match(DATE);
        return m ? `${Number(m[1])}-${Number(m[2])}-${m[3]}` : undefined;
    };
    return !!n(a) && n(a) === n(b);
}
