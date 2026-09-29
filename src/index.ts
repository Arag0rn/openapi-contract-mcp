#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';
import { SpecLoader } from './spec.js';

const source = process.argv[2] ?? process.env.OPENAPI_SPEC;
if (!source) {
  // stdout belongs to the MCP protocol, so every human-readable message goes to stderr.
  console.error('Usage: openapi-contract-mcp <schema-url-or-file>  (or set OPENAPI_SPEC)');
  process.exit(1);
}

const ttlMinutes = Number(process.env.OPENAPI_CACHE_MINUTES ?? 10);
const server = createServer(new SpecLoader({ source, ttlMs: ttlMinutes * 60_000 }));

await server.connect(new StdioServerTransport());
console.error(`openapi-contract-mcp running on stdio, schema: ${source}`);
