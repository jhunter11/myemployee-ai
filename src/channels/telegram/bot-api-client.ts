import { z } from 'zod';

const TelegramTokenSchema = z.string().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,100}$/);

const GetUpdatesInputSchema = z.strictObject({
  offset: z.number().int().min(0),
  limit: z.literal(50),
  timeout: z.literal(30),
  allowedUpdates: z.tuple([z.literal('message')])
});

const SendInputSchema = z.strictObject({
  chatId: z.number().int().positive(),
  text: z.string().trim().min(1).max(4_000)
});

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class TelegramBotApiClient {
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: { token: unknown; fetch?: typeof globalThis.fetch }) {
    this.token = TelegramTokenSchema.parse(options.token);
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async getUpdates(input: {
    offset: number;
    limit: 50;
    timeout: 30;
    allowedUpdates: ['message'];
  }): Promise<unknown[]> {
    const request = GetUpdatesInputSchema.parse(input);
    const result = await this.call('getUpdates', {
      offset: request.offset,
      limit: request.limit,
      timeout: request.timeout,
      allowed_updates: request.allowedUpdates
    });
    if (!Array.isArray(result)) {
      throw new Error('Telegram Bot API getUpdates returned an invalid result');
    }
    return result.map((item: unknown) => item);
  }

  async send(chatId: number, text: string): Promise<void> {
    const request = SendInputSchema.parse({ chatId, text });
    await this.call('sendMessage', { chat_id: request.chatId, text: request.text });
  }

  private async call(method: 'getUpdates' | 'sendMessage', body: object): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === 'getUpdates' ? 35_000 : 10_000);
    let response: Response;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch {
      throw new Error(`Telegram Bot API ${method} transport failed`);
    } finally {
      clearTimeout(timeout);
    }
    let payload: Record<string, unknown>;
    try {
      payload = object(await response.json());
    } catch {
      throw new Error(`Telegram Bot API ${method} returned invalid JSON`);
    }
    if (!response.ok || payload.ok !== true) {
      const providerCode = Number.isSafeInteger(payload.error_code)
        ? ` and code ${String(payload.error_code)}`
        : '';
      throw new Error(
        `Telegram Bot API ${method} failed with HTTP ${response.status}${providerCode}`
      );
    }
    return payload.result;
  }
}
