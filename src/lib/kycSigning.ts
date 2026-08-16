import { createHmac, randomUUID } from 'crypto';
import { backendFetch } from './backendFetch';

export interface SignedEnvelope<T> {
  body: T & { timestamp: number; nonce: string };
  signature: string;
}

export function signKycPayload<T extends object>(
  payload: T,
  secret: string,
): SignedEnvelope<T> {
  if (!secret) throw new Error('KYC_SHARED_SECRET is not set');

  const body = {
    ...payload,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomUUID(),
  };

  const json = JSON.stringify(body);
  const signature = 'sha256=' + createHmac('sha256', secret).update(json).digest('hex');

  return { body, signature };
}

export async function postSignedToNest(
  baseUrl: string,
  path: string,
  payload: object,
  authToken: string,
  secret: string,
): Promise<Response> {
  const { body, signature } = signKycPayload(payload, secret);
  return backendFetch(baseUrl, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'X-KYC-Signature': signature,
    },
    body: JSON.stringify(body),
  });
}

export async function patchSignedToNest(
  baseUrl: string,
  path: string,
  payload: object,
  authToken: string,
  secret: string,
): Promise<Response> {
  const { body, signature } = signKycPayload(payload, secret);
  return backendFetch(baseUrl, path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'X-KYC-Signature': signature,
    },
    body: JSON.stringify(body),
  });
}
