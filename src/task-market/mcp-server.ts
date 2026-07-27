import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';

import {
  EdgeValidationInputSchema,
  evaluateEdgeValidation,
  type EdgeValidationInput,
  type EdgeValidationResult
} from './edge-validation';

interface EdgeMcpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

type EdgeMcpToolHandler = (
  args: EdgeValidationInput,
  context: unknown
) => EdgeMcpToolResult | Promise<EdgeMcpToolResult>;

export type EdgeMcpPaymentWrapper = (
  handler: EdgeMcpToolHandler
) => (
  args: EdgeValidationInput,
  context: unknown
) => EdgeMcpToolResult | Promise<EdgeMcpToolResult>;

export interface EdgeValidationMcpOptions {
  paymentWrapper: EdgeMcpPaymentWrapper;
  execute?: (input: EdgeValidationInput) => EdgeValidationResult;
}

function asStructuredContent(result: EdgeValidationResult): Record<string, unknown> {
  return result as unknown as Record<string, unknown>;
}

export function createEdgeValidationMcpServer(options: EdgeValidationMcpOptions): McpServer {
  const execute = options.execute ?? evaluateEdgeValidation;
  const server = new McpServer({ name: 'jarvis-edge-validation', version: '1.0.0' });
  const paidHandler = options.paymentWrapper((args) => {
    const result = execute(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: asStructuredContent(result)
    };
  });

  server.registerTool(
    'edge_validation_v1',
    {
      title: 'Edge Validation V1',
      description:
        'Paid deterministic validation of a bounded numeric series. Runs no code, URLs, files, tools, or model prompts.',
      inputSchema: EdgeValidationInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    paidHandler
  );

  return server;
}

function methodNotAllowed(response: Response): void {
  response.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32_000, message: 'Method not allowed' },
    id: null
  });
}

export function installEdgeValidationMcpRoutes(
  app: Express,
  options: EdgeValidationMcpOptions
): void {
  // @anchor tm.mcp.batch-surface - the whole parsed body reaches the transport, so a JSON-RPC array fans out into one paid-gate entry per element
  app.post('/mcp', async (request: Request, response: Response) => {
    const server = createEdgeValidationMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal server error' },
          id: null
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });
  app.get('/mcp', (_request, response) => methodNotAllowed(response));
  app.delete('/mcp', (_request, response) => methodNotAllowed(response));
}
