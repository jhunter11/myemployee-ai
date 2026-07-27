import { z } from 'zod';

import type { SqliteTelegramInboxRepository } from './inbox-repository';
import type { TelegramUpdateProcessor } from './update-processor';

const UpdateIdSchema = z.object({ update_id: z.number().int().min(0) });

interface TelegramPollingApi {
  getUpdates(input: {
    offset: number;
    limit: 50;
    timeout: 30;
    allowedUpdates: ['message'];
  }): Promise<unknown[]>;
}

export class TelegramLongPoller {
  constructor(
    private readonly options: {
      inbox: SqliteTelegramInboxRepository;
      processor: TelegramUpdateProcessor;
      api: TelegramPollingApi;
    }
  ) {}

  async pollOnce(): Promise<{ received: number; processed: number }> {
    const cursor = await this.options.inbox.cursor();
    const updates = await this.options.api.getUpdates({
      offset: cursor + 1,
      limit: 50,
      timeout: 30,
      allowedUpdates: ['message']
    });
    const ordered = updates
      .flatMap((update) => {
        const parsed = UpdateIdSchema.safeParse(update);
        return parsed.success ? [{ raw: update, updateId: parsed.data.update_id }] : [];
      })
      .sort((left, right) => left.updateId - right.updateId);
    let processed = 0;
    for (const update of ordered) {
      await this.options.processor.process(update.raw);
      processed += 1;
    }
    return { received: updates.length, processed };
  }
}
