import {
  dereference,
  listOperations,
  resolveRef,
  type JsonSchema,
  type OpenApiDocument,
  type Operation,
  type OperationRef,
} from './spec.js';

export type EndpointMatch = {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  deprecated?: boolean;
  matchedOn: 'operationId' | 'path' | 'summary' | 'tag';
};

const normalize = (value: string) => value.toLowerCase().replace(/[\s_\-./{}]+/g, '');

/**
 * Finds operations by operationId, path fragment, summary or tag.
 *
 * operationId is checked first on purpose: the anchor in rendered API docs
 * (`#/accounts/change-email`) is the operationId, while the code calls the path
 * (`/auth/set_email/`). Searching the codebase for the anchor finds nothing.
 */
export function findEndpoints(doc: OpenApiDocument, query: string, limit = 10): EndpointMatch[] {
  const needle = normalize(query);
  if (!needle) return [];

  const ranked: Array<EndpointMatch & { score: number }> = [];
  for (const { method, path, operation } of listOperations(doc)) {
    const base = {
      method,
      path,
      operationId: operation.operationId,
      summary: operation.summary,
      deprecated: operation.deprecated,
    };
    const opId = operation.operationId ? normalize(operation.operationId) : '';

    if (opId === needle) ranked.push({ ...base, matchedOn: 'operationId', score: 0 });
    else if (normalize(path) === needle) ranked.push({ ...base, matchedOn: 'path', score: 1 });
    else if (opId.includes(needle)) ranked.push({ ...base, matchedOn: 'operationId', score: 2 });
    else if (normalize(path).includes(needle)) ranked.push({ ...base, matchedOn: 'path', score: 3 });
    else if (operation.summary && normalize(operation.summary).includes(needle))
      ranked.push({ ...base, matchedOn: 'summary', score: 4 });
    else if (operation.tags?.some((tag) => normalize(tag) === needle))
      ranked.push({ ...base, matchedOn: 'tag', score: 5 });
  }

  return ranked
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ score: _score, ...match }) => match);
}

/** Looks up one operation. Path must match the schema exactly, templated segments included. */
export function getOperation(doc: OpenApiDocument, method: string, path: string): OperationRef | undefined {
  const operation = doc.paths?.[path]?.[method.toLowerCase()];
  return operation ? { method: method.toUpperCase(), path, operation } : undefined;
}

/** Suggestions for a lookup that missed, so the agent can correct itself instead of giving up. */
export function suggestOperations(doc: OpenApiDocument, method: string, path: string): string[] {
  const samePath = doc.paths?.[path];
  if (samePath) {
    const methods = Object.keys(samePath).filter((key) => key !== 'parameters');
    return [`${path} exists but not for ${method.toUpperCase()}. Methods: ${methods.map((m) => m.toUpperCase()).join(', ')}`];
  }
  // Try the last static segment as written and in singular form (/pets vs /pet/{petId}),
  // then list operations with the requested method first: DELETE /pets should suggest a DELETE.
  // Concrete ids (/users/5) and templates (/users/{id}) say nothing about which resource is meant.
  const segments = path.split('/').filter((s) => s && !s.startsWith('{') && !/^\d+$/.test(s));
  const last = segments.pop() ?? path;
  const queries = [...new Set([last, last.replace(/s$/i, '')])];
  const seen = new Map<string, EndpointMatch>();
  for (const query of queries) {
    for (const match of findEndpoints(doc, query, 20)) seen.set(`${match.method} ${match.path}`, match);
  }
  const wanted = method.toUpperCase();
  return [...seen.values()]
    .sort((a, b) => Number(b.method === wanted) - Number(a.method === wanted))
    .slice(0, 5)
    .map((m) => `${m.method} ${m.path}`);
}

type Parameter = NonNullable<Operation['parameters']>[number];

export type RequestContract = {
  method: string;
  path: string;
  operationId?: string;
  deprecated?: boolean;
  parameters: Array<{ name: string; in: string; required: boolean; schema?: JsonSchema }>;
  body?: {
    required: boolean;
    contentType: string;
    requiredFields: string[];
    schema: JsonSchema;
  };
};

export function getRequestContract(doc: OpenApiDocument, ref: OperationRef): RequestContract {
  const { operation } = ref;

  // Parameters can be declared on the path item and overridden per operation.
  const pathLevel = (doc.paths[ref.path]?.parameters as unknown as Parameter[] | undefined) ?? [];
  const merged = new Map<string, Parameter>();
  for (const param of [...pathLevel, ...(operation.parameters ?? [])]) {
    const resolved = param.$ref ? resolveRef<Parameter>(doc, param.$ref) : param;
    merged.set(`${resolved.in}:${resolved.name}`, resolved);
  }

  const contract: RequestContract = {
    method: ref.method,
    path: ref.path,
    operationId: operation.operationId,
    deprecated: operation.deprecated,
    parameters: [...merged.values()].map((p) => ({
      name: p.name,
      in: p.in,
      required: p.in === 'path' ? true : Boolean(p.required),
      schema: p.schema ? dereference(doc, p.schema) : undefined,
    })),
  };

  const body = getRequestBody(doc, ref);
  if (body) {
    const schema = stripReadOnly(body.schema);
    contract.body = {
      required: body.required,
      contentType: body.contentType,
      requiredFields: schema.required ?? [],
      schema,
    };
  }
  return contract;
}

/**
 * The full dereferenced body schema, readOnly fields included.
 * `diff_payload` needs them to say "do not send id" instead of "unknown field id".
 */
export function getRequestBody(
  doc: OpenApiDocument,
  ref: OperationRef,
): { required: boolean; contentType: string; schema: JsonSchema } | undefined {
  const requestBody = ref.operation.requestBody?.$ref
    ? resolveRef<NonNullable<Operation['requestBody']>>(doc, ref.operation.requestBody.$ref)
    : ref.operation.requestBody;
  const picked = pickJson(requestBody?.content);
  if (!picked) return undefined;
  return {
    required: Boolean(requestBody?.required),
    contentType: picked.contentType,
    schema: dereference(doc, picked.schema),
  };
}

export type ResponseContract = {
  status: string;
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
};

export function getResponseContracts(
  doc: OpenApiDocument,
  ref: OperationRef,
  status?: string,
): { responses: ResponseContract[]; available: string[] } {
  const all = ref.operation.responses ?? {};
  const available = Object.keys(all);
  const wanted = status ? available.filter((code) => code === status || code === `${status[0]}XX`) : available;

  const responses = wanted.map((code) => {
    const raw = all[code]!;
    const response = raw.$ref ? resolveRef<typeof raw>(doc, raw.$ref) : raw;
    const picked = pickJson(response.content);
    return {
      status: code,
      description: response.description,
      contentType: picked?.contentType,
      schema: picked ? dereference(doc, picked.schema) : undefined,
    };
  });
  return { responses, available };
}

function pickJson(content?: Record<string, { schema?: JsonSchema }>) {
  if (!content) return undefined;
  const entries = Object.entries(content);
  const json =
    entries.find(([type]) => type === 'application/json') ??
    entries.find(([type]) => /[+/]json\b/.test(type)) ??
    entries[0];
  if (!json || !json[1].schema) return undefined;
  return { contentType: json[0], schema: json[1].schema };
}

/** readOnly fields (id, createdAt) come back from the server but must not be sent. */
function stripReadOnly(schema: JsonSchema): JsonSchema {
  if (!schema.properties) return schema;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([, value]) => !value.readOnly));
  return {
    ...schema,
    properties,
    required: schema.required?.filter((name) => name in properties),
  };
}
