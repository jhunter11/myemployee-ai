import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError } from '../utils/errors';
import type { RequestMetrics } from './metrics';

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  tenantId?: string;
}

export type RequestLogSink = (entry: RequestLogEntry) => void;

export function observeRequests(metrics: RequestMetrics, sink: RequestLogSink): RequestHandler {
  return (request, response, next) => {
    const startedAt = Date.now();
    const tenantId = request.get('x-tenant-id')?.trim();
    response.locals.tenantId = tenantId === '' ? undefined : tenantId;
    metrics.recordRequest();

    response.once('finish', () => {
      if (response.statusCode >= 400) {
        metrics.recordError();
      }
      sink({
        timestamp: new Date().toISOString(),
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
        ...(tenantId === undefined || tenantId === '' ? {} : { tenantId })
      });
    });

    next();
  };
}

export const notFound: RequestHandler = (request, _response, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${request.method} ${request.path} not found`));
};

function isInvalidJson(error: unknown): boolean {
  return error instanceof SyntaxError && 'body' in error;
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  void next;

  if (isInvalidJson(error)) {
    response.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON' }
    });
    return;
  }

  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    });
    return;
  }

  response.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
  });
};
