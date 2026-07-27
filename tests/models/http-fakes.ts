/** Shared HTTP fakes for the provider adapter tests — no real network. */

export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response
): typeof fetch {
  return (input, init) => Promise.resolve(handler(urlOf(input), init));
}
