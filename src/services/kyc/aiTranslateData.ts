

/**
 * AI translation service for KYC document data.
 * Translates/transliterates Arabic names from ID documents to English via OpenAI.
 * Supports graceful fallback if translation fails or is disabled.
 */

const ARABIC_RANGE = /[\u0600-\u06FF]/;
const OPENAI_TRANSLATION_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSLATION_MODEL = process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini';
export const KYC_TRANSLATE_ARABIC_NAMES = process.env.KYC_TRANSLATE_ARABIC_NAMES !== 'false';

interface OpenAiChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
}
/**
 * Detects if a string contains Arabic characters.
 */
export function isArabicText(text: string): boolean {
    return ARABIC_RANGE.test(text);
}

/**
 * Calls OpenAI API to translate/transliterate Arabic text to English.
 * Returns undefined if translation fails, is disabled, or API key is missing.
 *
 * @param text The Arabic text to translate
 * @returns Translated English text or undefined
 */
async function translateArabicTextToEnglish(text: string): Promise<string | undefined> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.warn('[aiTranslateData] OPENAI_API_KEY not set — skipping translation');
        return undefined;
    }

    try {
        const response = await fetch(OPENAI_TRANSLATION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: OPENAI_TRANSLATION_MODEL,
                temperature: 0,
                messages: [
                    {
                        role: 'system',
                        content:
                            'You transliterate/translate Arabic identity document fields to English. Return only the translated text with no extra words.',
                    },
                    {
                        role: 'user',
                        content: text,
                    },
                ],
            }),
        });

        if (!response.ok) {
            /*
              The BODY, not just the status — and at error level.

              Every failure here ends the same way: `return undefined`, the
              caller keeps the Arabic, and the KYC result looks like the
              translator was never switched on. That silence is deliberate (a
              transliteration is not worth failing an identity check over) but
              it means this log line is the ONLY evidence that anything went
              wrong, and a bare status code cannot tell apart the three things
              that actually happen: 401 a revoked or wrong key, 429 no quota or
              rate limit, 404 a model name this account cannot reach.

              Those have completely different fixes and identical symptoms, so
              the body is worth the bytes. OpenAI returns a small JSON error
              object with a human-readable `message`; it is truncated here
              because a runaway HTML error page should not flood the tail.

              Safe to log: this is OpenAI's response, not our request — the key
              is never echoed back in it.
            */
            const detail = await response.text().catch(() => '<unreadable>');
            console.error(
                '[aiTranslateData] OpenAI translation failed —',
                `status=${response.status}`,
                `model=${OPENAI_TRANSLATION_MODEL}`,
                `body=${detail.slice(0, 300)}`,
            );
            return undefined;
        }

        const json = (await response.json()) as OpenAiChatCompletionResponse;
        const translated = json.choices?.[0]?.message?.content?.trim();
        return translated || undefined;
    } catch (error) {
        console.warn('[aiTranslateData] OpenAI translation failed:', error);
        return undefined;
    }
}

/**
 * Translates an Arabic name to English if:
 * 1. Translation is enabled (KYC_TRANSLATE_ARABIC_NAMES !== 'false')
 * 2. The name contains Arabic characters
 * 3. OpenAI API succeeds
 *
 * Falls back to the original name if any step fails.
 *
 * @param name The name (possibly in Arabic)
 * @returns Translated English name or original name if translation unavailable
 */
export async function translateNameIfArabic(name: string | undefined): Promise<string | undefined> {
    if (!name || !KYC_TRANSLATE_ARABIC_NAMES || !isArabicText(name)) {
        return name;
    }

    const translated = await translateArabicTextToEnglish(name);
    return translated || name;
}
