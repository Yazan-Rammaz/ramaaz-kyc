export async function backendFetch(
  baseUrl: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | FormData | null;
  } = {},
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const hostname = new URL(url).hostname;
  const hasUnderscore = hostname.includes('_');

  // Build body + content-type for FormData before making the request
  let resolvedBody: BodyInit | undefined;
  let extraHeaders: Record<string, string> = {};

  if (init.body instanceof FormData) {
    // Serialize FormData to a buffer so we can set Content-Length
    const tmp = new Response(init.body as unknown as BodyInit);
    const ct = tmp.headers.get('content-type');
    const ab = await tmp.arrayBuffer();
    const buf = Buffer.from(ab);
    if (ct) extraHeaders['Content-Type'] = ct;
    extraHeaders['Content-Length'] = buf.byteLength.toString();
    resolvedBody = buf;
  } else if (init.body) {
    resolvedBody = init.body as BodyInit;
  }

  const mergedHeaders = { ...extraHeaders, ...(init.headers ?? {}) };

  // Normal hostname (including localhost proxy) — standard fetch works everywhere
  if (!hasUnderscore) {
    return fetch(url, {
      method: init.method ?? 'GET',
      headers: mergedHeaders as HeadersInit,
      body: resolvedBody,
    });
  }

  // Underscore hostname: in production Cloudflare Workers, fetch handles these natively.
  // In local dev, RDB_BASE_URL should point to the local proxy (http://localhost:8789)
  // which has no underscore, so this branch should never run locally.
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: { Host: hostname, ...mergedHeaders } as HeadersInit,
    body: resolvedBody,
  });
}
