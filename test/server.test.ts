import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { SpecLoader } from '../src/spec.js';
import { fixturePath } from './helpers.js';

/** Talks to the server through the real MCP protocol, in memory: what an agent would see. */
describe('MCP server', () => {
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(new SpecLoader({ source: fixturePath })).connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return { isError: Boolean(result.isError), text };
  };

  it('exposes five read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'diff_payload',
      'find_endpoint',
      'get_request_schema',
      'get_response_schema',
      'spec_info',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('spec_info describes the loaded schema', async () => {
    const { text } = await call('spec_info', {});
    expect(JSON.parse(text)).toMatchObject({ title: 'Demo CRM API', operations: 7, deprecatedOperations: 1 });
  });

  it('find_endpoint resolves an operationId to its path', async () => {
    const { text } = await call('find_endpoint', { query: 'change-email' });
    expect(JSON.parse(text)[0]).toMatchObject({ method: 'POST', path: '/auth/set_email/' });
  });

  it('a wrong path returns a recoverable error with suggestions', async () => {
    const { isError, text } = await call('get_request_schema', { method: 'POST', path: '/accounts/set_email' });
    expect(isError).toBe(true);
    expect(text).toContain('Did you mean');
    expect(text).toContain('POST /auth/set_email/');
  });

  it('diff_payload reports every mismatch', async () => {
    const { text } = await call('diff_payload', {
      method: 'POST',
      path: '/users/',
      payload: { id: 1, email: 'a@b.de', firstName: 'Ann' },
    });
    const result = JSON.parse(text);
    expect(result.matchesContract).toBe(false);
    expect(result.issues.map((i: { kind: string }) => i.kind).sort()).toEqual(['missing', 'read-only', 'unknown']);
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const { isError } = await call('get_response_schema', { method: 'POST', path: '/users/', status: 'ok' });
    expect(isError).toBe(true);
  });
});
