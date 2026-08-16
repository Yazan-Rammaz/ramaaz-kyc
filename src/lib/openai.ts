import OpenAI from 'openai';

export function getOpenAI(apiKey: string): OpenAI {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey });
}
