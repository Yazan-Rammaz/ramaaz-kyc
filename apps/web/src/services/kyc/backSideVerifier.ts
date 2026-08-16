import type { IDDocument } from '@ramaaz/kyc-shared/types';

export interface MrzFields {
    nationalNumber?: string;
    documentNumber?: string;
    lastName?: string;
    firstName?: string;
    birthday?: string;
}

// Minimal two-row Levenshtein distance.
function levenshtein(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        for (let j = 1; j <= b.length; j++) {
            curr[j] =
                a[i - 1] === b[j - 1]
                    ? prev[j - 1]
                    : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        }
        prev = curr;
    }
    return prev[b.length];
}

function digitsOnly(s: string): string {
    return s.replace(/\D/g, '');
}

/** Normalize a name for loose comparison: uppercase, strip diacritics, keep letters only. */
function normalizeName(s: string): string {
    return s
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z]/g, '');
}

/**
 * Parse MRZ lines from rawText and extract identity fields.
 *
 * Turkish national ID back MRZ layout:
 *   Line 1: I<TUR<docNo(9)><checkDigit><nationalNo(11)><<<
 *   Line 2: YYMMDD<checkDigit><sex><expiryYYMMDD><checkDigit><nationality><<<...
 *   Line 3: LASTNAME<<FIRSTNAME<<<...
 *
 * The function is intentionally permissive — OCR may corrupt individual
 * characters, so we use position-based extraction where possible.
 */
export function parseMrzFromRawText(rawText: string): MrzFields {
    if (!rawText) return {};

    // MRZ lines contain many '<' characters.
    const mrzLines = rawText
        .split('\n')
        .map((l) => l.trim().toUpperCase())
        .filter((l) => (l.match(/</g) ?? []).length >= 3);

    if (mrzLines.length === 0) return {};

    const result: MrzFields = {};

    for (const line of mrzLines) {
        // ── Line 1: document + national number ──────────────────────────────
        // Pattern: starts with I< (or similar), contains TUR, then has an
        // 11-digit run somewhere after a '<'.
        if (/^I[<A-Z]/.test(line) && line.includes('TUR')) {
            // Find all 11-digit runs in the line.
            const elevenDigit = [...line.matchAll(/\d{11}/g)];
            if (elevenDigit.length > 0) {
                // The national number is the 11-digit group that appears after
                // the document-number field (typically position 15–25).
                // If multiple matches, prefer the one at position ≥ 14.
                const candidate =
                    elevenDigit.find((m) => (m.index ?? 0) >= 14) ?? elevenDigit[0];
                result.nationalNumber = candidate[0];
            }

            // Document number: 9 alphanumeric chars after country code (pos 5–13).
            // Pattern: I<TUR + 9 chars + check digit
            const docMatch = line.match(/^I[<A-Z]TUR([A-Z0-9]{9})/);
            if (docMatch) {
                result.documentNumber = docMatch[1];
            }
        }

        // ── Line 2: DOB ──────────────────────────────────────────────────────
        // Format: YYMMDD<check<sex<expiryYYMMDD...
        if (/^\d{6}[<0-9]/.test(line)) {
            const dob = line.slice(0, 6);
            if (/^\d{6}$/.test(dob)) {
                const yy = parseInt(dob.slice(0, 2), 10);
                const mm = dob.slice(2, 4);
                const dd = dob.slice(4, 6);
                const year = yy > 30 ? 1900 + yy : 2000 + yy;
                result.birthday = `${dd}.${mm}.${year}`;
            }
        }

        // ── Line 3: name ─────────────────────────────────────────────────────
        // Format: LASTNAME<<FIRSTNAME<<<<<...
        if (line.includes('<<') && !/^I[<A-Z]/.test(line) && !/^\d{6}/.test(line)) {
            const parts = line.split('<<');
            if (parts.length >= 2 && /^[A-Z]+$/.test(parts[0])) {
                result.lastName = parts[0];
                // First name may itself contain single '<' for multiple given names.
                result.firstName = parts[1].replace(/<+$/, '').split('<')[0] || undefined;
            }
        }
    }

    return result;
}

/**
 * Verify that the back side belongs to the same physical document as the front.
 *
 * Strategy (in priority order):
 *  1. National number comparison (11-digit, fuzzy ≤1 char) — highest confidence
 *  2. Document number comparison — high confidence
 *  3. Last name comparison (MRZ line 3 vs front lastName) — medium confidence
 *  4. If nothing is comparable → verified=true (can't block what we can't check)
 */
export function verifyBackMatchesFront(
    frontData: Partial<IDDocument>,
    backExtracted: Partial<IDDocument>,
    backRawText: string,
): { verified: boolean; reason?: string } {
    // Parse MRZ fields from back rawText.
    const mrz = parseMrzFromRawText(backRawText);

    // Resolve back national number: structured field first, then MRZ.
    const backNatNum = digitsOnly(backExtracted.nationalNumber ?? mrz.nationalNumber ?? '');
    const frontNatNum = digitsOnly(frontData.nationalNumber ?? '');

    // Resolve back document number: structured field first, then MRZ.
    const backDocNum = digitsOnly(
        (backExtracted.documentNumber ?? mrz.documentNumber ?? '').replace(/[^A-Z0-9]/gi, ''),
    );
    const frontDocNum = digitsOnly(
        (frontData.documentNumber ?? '').replace(/[^A-Z0-9]/gi, ''),
    );

    // Resolve names.
    const backLastName = normalizeName(backExtracted.lastName ?? mrz.lastName ?? '');
    const frontLastName = normalizeName(frontData.lastName ?? '');

    // ── Debug log: all fields side-by-side before decision ────────────────
    console.log(
        '[backSideVerifier] ── cross-side comparison ──────────────────────\n' +
        `  nationalNumber  front=${frontNatNum || '(none)'}  back=${backNatNum || '(none)'}  ${backNatNum.length >= 8 && frontNatNum.length >= 8 ? (backNatNum === frontNatNum ? '✓ exact' : `levenshtein=${levenshtein(backNatNum, frontNatNum)}`) : '— skip (too short)'}\n` +
        `  documentNumber  front=${frontDocNum || '(none)'}  back=${backDocNum || '(none)'}  ${backDocNum.length >= 6 && frontDocNum.length >= 6 ? (backDocNum === frontDocNum ? '✓ exact' : `levenshtein=${levenshtein(backDocNum, frontDocNum)}`) : '— skip (too short)'}\n` +
        `  lastName        front=${frontLastName || '(none)'}  back=${backLastName || '(none)'}  ${backLastName.length >= 2 && frontLastName.length >= 2 ? (backLastName === frontLastName ? '✓ exact' : `levenshtein=${levenshtein(backLastName, frontLastName)}`) : '— skip (too short)'}\n` +
        `  MRZ parsed      natNum=${mrz.nationalNumber ?? '—'}  docNum=${mrz.documentNumber ?? '—'}  lastName=${mrz.lastName ?? '—'}  firstName=${mrz.firstName ?? '—'}`
    );

    if (backNatNum.length >= 8 && frontNatNum.length >= 8) {
        const match =
            backNatNum === frontNatNum || levenshtein(backNatNum, frontNatNum) <= 1;
        console.log(`[backSideVerifier] decision: nationalNumber → ${match ? 'ACCEPT' : 'REJECT'}`);
        return match
            ? { verified: true }
            : {
                  verified: false,
                  reason: 'The ID number on the back does not match the front. Please use the back of the same document.',
              };
    }

    if (backDocNum.length >= 6 && frontDocNum.length >= 6) {
        const match =
            backDocNum === frontDocNum || levenshtein(backDocNum, frontDocNum) <= 1;
        console.log(`[backSideVerifier] decision: documentNumber → ${match ? 'ACCEPT' : 'REJECT'}`);
        return match
            ? { verified: true }
            : {
                  verified: false,
                  reason: 'The document number on the back does not match the front. Please use the back of the same document.',
              };
    }

    if (backLastName.length >= 2 && frontLastName.length >= 2) {
        const match =
            backLastName === frontLastName || levenshtein(backLastName, frontLastName) <= 1;
        console.log(`[backSideVerifier] decision: lastName → ${match ? 'ACCEPT' : 'REJECT'}`);
        return match
            ? { verified: true }
            : {
                  verified: false,
                  reason: 'The name on the back does not match the front. Please use the back of the same document.',
              };
    }

    console.log('[backSideVerifier] decision: nothing to compare → ACCEPT (unverifiable)');
    return { verified: true };
}
