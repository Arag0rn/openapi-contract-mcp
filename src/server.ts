import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { diffPayload } from './diff.js';
import {
  findEndpoints,
  getOperation,
  getRequestBody,
  getRequestContract,
  getResponseContracts,
  suggestOperations,
} from './operations.js';
import { listOperations, type SpecLoader } from './spec.js';

/** Large schemas can flood the context window. Past this size the agent gets a pointer, not the whole thing. */
const MAX_OUTPUT_CHARS = 20_000;

// Every tool only reads the schema. None of them calls the API the schema describes.
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const methodSchema = z
  .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
  .describe('HTTP method, e.g. POST');
const pathSchema = z
  .string()
  .min(1)
  .describe('Path exactly as written in the schema, templated segments included, e.g. /users/{id}. Use find_endpoint first if unsure.');

const ok = (data: unknown) => {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return { content: [{ type: 'text' as const, text }] };
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: ${text.length} chars total. ` +
          'Ask for a narrower part, e.g. one response status, or use diff_payload which returns only the problems.]',
      },
    ],
  };
};

const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/**
 * Sent to the client on connect. Evals showed that without it, an agent asked to "delete user 5"
 * offers to send the DELETE itself, although this server cannot reach the API at all.
 */
const INSTRUCTIONS = `This server reads one OpenAPI schema. It never calls the API the schema describes and cannot create, change or delete anything.
Use it to answer "what does this endpoint accept or return" and "why does this request fail" from the contract instead of guessing.
Typical flow: find_endpoint (resolve a name, docs anchor or path) -> get_request_schema / get_response_schema -> diff_payload when you have a concrete payload.
If the user asks you to perform a request, explain that these tools are read-only, and use find_endpoint to check whether such an operation is documented at all.`;

export function createServer(loader: SpecLoader): McpServer {
  const server = new McpServer({ name: 'openapi-contract-mcp', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'spec_info',
    {
      title: 'Schema info',
      description:
        'Shows which OpenAPI schema is loaded, its version and when it was downloaded. ' +
        'Call with refresh=true after the backend was deployed: a stale schema looks authoritative and is worse than none.',
      inputSchema: z.object({
        refresh: z.boolean().optional().describe('Download the schema again, ignoring the cache'),
      }),
      annotations: { ...readOnly, idempotentHint: false },
    },
    async ({ refresh }) => {
      const spec = await loader.get({ refresh: refresh ?? false });
      const operations = listOperations(spec.doc);
      return ok({
        title: spec.doc.info.title,
        apiVersion: spec.doc.info.version,
        openapi: spec.doc.openapi,
        source: spec.source,
        loadedAt: spec.loadedAt.toISOString(),
        operations: operations.length,
        deprecatedOperations: operations.filter((op) => op.operation.deprecated).length,
      });
    },
  );

  server.registerTool(
    'find_endpoint',
    {
      title: 'Find endpoint',
      description:
        'Finds API operations by operationId, path fragment, summary or tag. ' +
        'Use it before implementing or debugging any API call, and whenever someone names an endpoint ' +
        'by its docs anchor: the anchor is the operationId, which is often different from the path ' +
        '(docs say "change-email", the path is /auth/set_email/).',
      inputSchema: z.object({
        query: z.string().min(1).describe('operationId, a piece of the path, or a word from the summary'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results, default 10'),
      }),
      annotations: readOnly,
    },
    async ({ query, limit }) => {
      const { doc } = await loader.get();
      const matches = findEndpoints(doc, query, limit ?? 10);
      if (matches.length === 0) {
        return fail(
          `No operation matches "${query}". Try a shorter fragment of the path or a single word from the operationId.`,
        );
      }
      return ok(matches);
    },
  );

  server.registerTool(
    'get_request_schema',
    {
      title: 'Request contract',
      description:
        'Returns what an operation accepts: path, query and header parameters, and the request body schema ' +
        'with $refs resolved and readOnly fields removed. requiredFields lists what must be sent. ' +
        'Use it before writing the request, instead of copying fields from a GET response. ' +
        'If you already have a concrete payload to check, call diff_payload instead: it compares every field ' +
        'exactly, while comparing by hand misses things in larger bodies.',
      inputSchema: z.object({ method: methodSchema, path: pathSchema }),
      annotations: readOnly,
    },
    async ({ method, path }) => {
      const { doc } = await loader.get();
      const ref = getOperation(doc, method, path);
      if (!ref) return fail(notFound(method, path, suggestOperations(doc, method, path)));
      const contract = getRequestContract(doc, ref);
      // Evals caught agents quoting /users/{id} for /users/{id}/. Django-style backends answer that with a redirect or 404.
      return ok(ref.path.endsWith('/') ? { ...contract, note: `The path ends with a slash. Call it exactly as ${ref.path}` } : contract);
    },
  );

  server.registerTool(
    'get_response_schema',
    {
      title: 'Response contract',
      description:
        'Returns what an operation responds with, per status code, $refs resolved. ' +
        'Pass status (e.g. "200" or "400") to get one response; without it you get all of them, which can be long.',
      inputSchema: z.object({
        method: methodSchema,
        path: pathSchema,
        status: z.string().regex(/^[1-5]\d\d$|^default$/).optional().describe('Status code, e.g. "200", or "default"'),
      }),
      annotations: readOnly,
    },
    async ({ method, path, status }) => {
      const { doc } = await loader.get();
      const ref = getOperation(doc, method, path);
      if (!ref) return fail(notFound(method, path, suggestOperations(doc, method, path)));

      const { responses, available } = getResponseContracts(doc, ref, status);
      if (responses.length === 0) {
        return fail(`${method.toUpperCase()} ${path} documents no ${status} response. Documented: ${available.join(', ')}`);
      }
      return ok(responses);
    },
  );

  server.registerTool(
    'diff_payload',
    {
      title: 'Check payload against contract',
      description:
        'First choice whenever the user shows a JSON body and asks why a request fails or what to change. ' +
        'Compares a request body the code actually sends with the schema and lists every mismatch: missing ' +
        'required fields, fields the schema does not know (with the closest valid name), wrong types, values ' +
        'outside an enum, and readOnly fields that must not be sent. Use it when a request fails with 400 or ' +
        'the backend "ignores" a field, to decide whether it is a frontend or a backend bug.',
      inputSchema: z.object({
        method: methodSchema,
        path: pathSchema,
        payload: z.unknown().describe('The JSON body exactly as the frontend sends it'),
      }),
      annotations: readOnly,
    },
    async ({ method, path, payload }) => {
      const { doc } = await loader.get();
      const ref = getOperation(doc, method, path);
      if (!ref) return fail(notFound(method, path, suggestOperations(doc, method, path)));

      const body = getRequestBody(doc, ref);
      if (!body) return fail(`${method.toUpperCase()} ${path} has no request body in the schema. Nothing should be sent.`);

      const issues = diffPayload(body.schema, payload);
      return ok({
        operation: `${ref.method} ${ref.path}`,
        matchesContract: issues.length === 0,
        issues,
      });
    },
  );

  return server;
}

function notFound(method: string, path: string, suggestions: string[]): string {
  const hint = suggestions.length ? ` Did you mean:\n- ${suggestions.join('\n- ')}` : ' Use find_endpoint to search.';
  return `No operation ${method.toUpperCase()} ${path} in the schema.${hint}`;
}
