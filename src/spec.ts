import { readFile } from 'node:fs/promises';

/** Minimal OpenAPI 3.x types: only the parts this server reads. */
export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  description?: string;
  readOnly?: boolean;
  writeOnly?: boolean;
  [key: string]: unknown;
};

type MediaType = { schema?: JsonSchema };

export type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: JsonSchema; $ref?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, MediaType>; $ref?: string };
  responses?: Record<string, { description?: string; content?: Record<string, MediaType>; $ref?: string }>;
};

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema>; [key: string]: unknown };
};

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** One method + path pair, flattened out of the `paths` object. */
export type OperationRef = {
  method: string;
  path: string;
  operation: Operation;
};

export function listOperations(doc: OpenApiDocument): OperationRef[] {
  const result: OperationRef[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation) result.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return result;
}

/**
 * Follows a local `$ref` such as `#/components/schemas/User`.
 * Remote refs are out of scope: the server reads one document and says so instead of guessing.
 */
export function resolveRef<T>(doc: OpenApiDocument, ref: string): T {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local $refs are supported, got "${ref}"`);
  }
  let node: unknown = doc;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(part in node)) {
      throw new Error(`Unresolvable $ref "${ref}"`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node as T;
}

/**
 * Returns a copy of the schema with every `$ref` inlined, so the agent sees one self-contained object.
 * Recursive schemas (a Category with child Categories) are cut at the second visit and marked.
 */
export function dereference(doc: OpenApiDocument, schema: JsonSchema, seen: string[] = []): JsonSchema {
  if (schema.$ref) {
    if (seen.includes(schema.$ref)) {
      return { description: `[circular reference to ${schema.$ref}]` };
    }
    return dereference(doc, resolveRef<JsonSchema>(doc, schema.$ref), [...seen, schema.$ref]);
  }

  const out: JsonSchema = { ...schema };
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, dereference(doc, value, seen)]),
    );
  }
  if (schema.items) out.items = dereference(doc, schema.items, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    out.additionalProperties = dereference(doc, schema.additionalProperties, seen);
  }
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const list = schema[key];
    if (list) out[key] = list.map((part) => dereference(doc, part, seen));
  }
  return out;
}

export type SpecLoaderOptions = {
  /** http(s) URL or local file path of an OpenAPI 3.x JSON document. */
  source: string;
  /** How long a downloaded schema stays valid. A stale schema looks authoritative, so keep this short. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type LoadedSpec = {
  doc: OpenApiDocument;
  source: string;
  loadedAt: Date;
};

/**
 * Loads the schema once and keeps it in memory for `ttlMs`.
 * This is the only network call the server ever makes, and it is a GET for the schema itself:
 * no tool talks to the API described by the schema.
 */
export class SpecLoader {
  private cached?: LoadedSpec;
  private pending?: Promise<LoadedSpec>;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: SpecLoaderOptions) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async get({ refresh = false } = {}): Promise<LoadedSpec> {
    const fresh = this.cached && this.now() - this.cached.loadedAt.getTime() < this.ttlMs;
    if (fresh && !refresh) return this.cached!;

    // Concurrent tool calls share one download instead of each starting their own.
    this.pending ??= this.load().finally(() => {
      this.pending = undefined;
    });
    this.cached = await this.pending;
    return this.cached;
  }

  private async load(): Promise<LoadedSpec> {
    const { source } = this.options;
    const text = /^https?:\/\//i.test(source) ? await this.download(source) : await readFile(source, 'utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Schema at ${source} is not valid JSON. YAML is not supported yet, export the schema as JSON.`);
    }
    const doc = parsed as OpenApiDocument;
    if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
      throw new Error(`Schema at ${source} is not an OpenAPI 3.x document (swagger 2.0 is not supported).`);
    }
    return { doc, source, loadedAt: new Date(this.now()) };
  }

  private async download(url: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'openapi-contract-mcp' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Could not download schema from ${url}: HTTP ${res.status}`);
    return res.text();
  }
}
