// Подменный fetch: маршрут — функция от URL; записывает вызовы, чтобы проверять адреса и заголовки.

export interface Call {
  url: string;
  headers: Record<string, string>;
}

export type Route = (url: URL) => { status?: number; body: unknown } | undefined;

export function fakeFetch(route: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const hit = route(new URL(url));
    if (!hit) return new Response('not found', { status: 404 });
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    return new Response(body, { status: hit.status ?? 200 });
  };
  return { fetch: impl as typeof fetch, calls };
}
