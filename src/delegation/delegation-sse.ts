import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

import type { CommandPrincipal, ServerScopeBinding } from '../commands/contracts';
import { AppError } from '../utils/errors';
import { authorizeDelegationContext } from './delegation-control-service';
import type { SqliteDelegationRepository } from './delegation-repository';
import type { DelegationSafeEvent } from './contracts';

const CursorSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/u)
  .transform((value, context) => {
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor)) {
      context.addIssue({ code: 'custom', message: 'Last-Event-ID is outside the safe range' });
      return z.NEVER;
    }
    return cursor;
  });
const LimitSchema = z.number().int().min(1).max(100);

export interface DelegationEventBatch {
  events: DelegationSafeEvent[];
  nextEventId: string | null;
  hasMore: boolean;
  retryMs: 5000;
}

export class DelegationEventStream {
  constructor(private readonly options: { repository: SqliteDelegationRepository }) {}

  async read(input: {
    principal: unknown;
    binding: unknown;
    lastEventId: unknown;
    limit: unknown;
  }): Promise<DelegationEventBatch> {
    await Promise.resolve();
    const { binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'read'
    });
    const after = input.lastEventId === null ? 0 : CursorSchema.parse(input.lastEventId);
    const limit = LimitSchema.parse(input.limit);
    const available = this.options.repository.listEvents({ binding, after, limit: limit + 1 });
    const events = available.slice(0, limit);
    return {
      events,
      nextEventId: events.at(-1)?.id ?? null,
      hasMore: available.length > limit,
      retryMs: 5000
    };
  }
}

export interface DelegationSseAuthorization {
  principal: CommandPrincipal;
  binding: ServerScopeBinding;
}

export interface DelegationSseHandlerOptions {
  stream: DelegationEventStream;
  authorize(request: Request): Promise<DelegationSseAuthorization>;
  maxEvents: number;
}

function encodeBatch(batch: DelegationEventBatch): string {
  let text = `retry: ${batch.retryMs}\n\n`;
  for (const event of batch.events) {
    text += `id: ${event.id}\n`;
    text += `event: delegation.${event.type}\n`;
    text += `data: ${JSON.stringify(event)}\n\n`;
  }
  return text;
}

export function createDelegationSseHandler(options: DelegationSseHandlerOptions): RequestHandler {
  const maxEvents = LimitSchema.parse(options.maxEvents);
  return async (request, response, next) => {
    try {
      if (Object.keys(request.query).length !== 0) {
        throw new AppError(
          400,
          'DELEGATION_STREAM_QUERY_FORBIDDEN',
          'Delegation stream does not accept caller-selected scope or cursor query fields'
        );
      }
      const lastEventId = request.get('last-event-id') ?? null;
      const authorization = await options.authorize(request);
      const batch = await options.stream.read({
        ...authorization,
        lastEventId,
        limit: maxEvents
      });
      response.status(200).set({
        'Cache-Control': 'no-store',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no'
      });
      response.send(encodeBatch(batch));
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new AppError(400, 'DELEGATION_STREAM_CURSOR_INVALID', 'Last-Event-ID is invalid'));
        return;
      }
      next(error);
    }
  };
}
