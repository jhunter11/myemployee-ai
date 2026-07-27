import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEdgeValidationMcpServer,
  type EdgeMcpPaymentWrapper,
  type EdgeValidationMcpOptions
} from '../../src/task-market/mcp-server';
import { evaluateEdgeValidation } from '../../src/task-market/edge-validation';

const validArguments = {
  schemaVersion: 1 as const,
  observations: [10, 10, 10, 10, 10],
  parameters: { minObservations: 5, minimumMean: 10, confidenceZ: 1.96 }
};

const passthrough: EdgeMcpPaymentWrapper = (handler) => (args, context) => handler(args, context);

describe('edge-validation MCP server', () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  async function connect(
    wrapper: EdgeMcpPaymentWrapper,
    execute?: EdgeValidationMcpOptions['execute']
  ) {
    const server = createEdgeValidationMcpServer({ paymentWrapper: wrapper, execute });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it('lists one narrowly described paid tool with the strict input schema', async () => {
    const client = await connect(passthrough);

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name)).toEqual(['edge_validation_v1']);
    expect(tools[0]).toMatchObject({
      name: 'edge_validation_v1',
      title: 'Edge Validation V1',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'observations', 'parameters']
      }
    });
  });

  it('uses the same deterministic kernel and returns structured output without raw observations', async () => {
    const client = await connect(passthrough);

    const result = await client.callTool({
      name: 'edge_validation_v1',
      arguments: validArguments
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      verdict: 'PASS',
      algorithm: { id: 'edge-validation', version: '1.0.0' }
    });
    expect(JSON.stringify(result)).not.toContain('observations');
  });

  it('does not execute when the payment wrapper denies the call', async () => {
    const execute = vi.fn(evaluateEdgeValidation);
    const denied: EdgeMcpPaymentWrapper = () => () =>
      Promise.resolve({
        content: [{ type: 'text', text: '{"error":{"code":402}}' }],
        isError: true
      });
    const client = await connect(denied, execute);

    const result = await client.callTool({
      name: 'edge_validation_v1',
      arguments: validArguments
    });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed MCP arguments before the paid handler executes', async () => {
    const wrapper = vi.fn<EdgeMcpPaymentWrapper>(
      (handler) => (args, context) => handler(args, context)
    );
    const execute = vi.fn(evaluateEdgeValidation);
    const client = await connect(wrapper, execute);

    const result = await client.callTool({
      name: 'edge_validation_v1',
      arguments: { ...validArguments, observations: [1, 2, 3], extra: 'forbidden' }
    });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
