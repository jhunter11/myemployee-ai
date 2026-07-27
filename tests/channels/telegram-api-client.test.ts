import { describe, expect, it, vi } from 'vitest';

import { TelegramBotApiClient } from '../../src/channels/telegram/bot-api-client';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Telegram Bot API client', () => {
  it('uses outbound POST long polling with the exact current Bot API fields', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response({ ok: true, result: [{ update_id: 8, message: { text: '/today' } }] })
      );
    const client = new TelegramBotApiClient({
      token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
      fetch
    });

    const updates = await client.getUpdates({
      offset: 8,
      limit: 50,
      timeout: 30,
      allowedUpdates: ['message']
    });

    expect(updates).toEqual([{ update_id: 8, message: { text: '/today' } }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getUpdates'
    );
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({
      offset: 8,
      limit: 50,
      timeout: 30,
      allowed_updates: ['message']
    });
  });

  it('sends only a bounded private reply and sanitizes provider failures', async () => {
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true, result: { message_id: 88 } }))
      .mockResolvedValueOnce(
        response({ ok: false, error_code: 401, description: `leaked ${token}` }, 401)
      );
    const client = new TelegramBotApiClient({ token, fetch });

    await expect(client.send(84, 'Bounded reply.')).resolves.toBeUndefined();
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: 84, text: 'Bounded reply.' });

    await expect(
      client.getUpdates({ offset: 1, limit: 50, timeout: 30, allowedUpdates: ['message'] })
    ).rejects.toThrow('Telegram Bot API getUpdates failed with HTTP 401 and code 401');
    try {
      await client.getUpdates({ offset: 1, limit: 50, timeout: 30, allowedUpdates: ['message'] });
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it('rejects malformed tokens, oversized replies, and non-private chat IDs before fetch', async () => {
    expect(() => new TelegramBotApiClient({ token: 'not-a-token', fetch: vi.fn() })).toThrow();
    const fetch = vi.fn();
    const client = new TelegramBotApiClient({
      token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
      fetch
    });

    await expect(client.send(-1001, 'No group sends')).rejects.toThrow();
    await expect(client.send(84, 'x'.repeat(4_001))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
