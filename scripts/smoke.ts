/**
 * Starts the built server as a child process over stdio, the way Claude Code or Cursor would,
 * and calls each tool once. Exits non-zero if a call that should succeed returns an error.
 *
 *   npm run build && npx tsx scripts/smoke.ts [schema-url-or-file]
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const schema = process.argv[2] ?? 'https://petstore3.swagger.io/api/v3/openapi.json';
const isFixture = schema.includes('crm.openapi.json');

type Step = { tool: string; args: Record<string, unknown>; expectError?: boolean };

const steps: Step[] = isFixture
  ? [
      { tool: 'spec_info', args: {} },
      { tool: 'find_endpoint', args: { query: 'change-email' } },
      { tool: 'get_request_schema', args: { method: 'POST', path: '/users/' } },
      { tool: 'diff_payload', args: { method: 'POST', path: '/users/', payload: { id: 1, firstName: 'Ann' } } },
      { tool: 'get_response_schema', args: { method: 'GET', path: '/users/{id}/', status: '404' } },
      { tool: 'get_request_schema', args: { method: 'DELETE', path: '/users' }, expectError: true },
    ]
  : [
      { tool: 'spec_info', args: {} },
      { tool: 'find_endpoint', args: { query: 'addPet' } },
      { tool: 'get_request_schema', args: { method: 'POST', path: '/pet' } },
      { tool: 'diff_payload', args: { method: 'POST', path: '/pet', payload: { name: 'Rex', photoUrl: 'x', status: 'sleeping' } } },
      { tool: 'get_response_schema', args: { method: 'GET', path: '/pet/{petId}', status: '200' } },
      { tool: 'get_request_schema', args: { method: 'DELETE', path: '/pets' }, expectError: true },
    ];

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js', schema] }));

let failed = 0;
for (const { tool, args, expectError = false } of steps) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const ok = Boolean(result.isError) === expectError;
  if (!ok) failed++;
  console.log(`\n## ${ok ? 'ok ' : 'BAD'} ${tool} ${JSON.stringify(args)}${result.isError ? '  [isError]' : ''}\n${text.slice(0, 600)}`);
}

await client.close();
if (failed) {
  console.error(`\n${failed} step(s) did not behave as expected`);
  process.exit(1);
}
