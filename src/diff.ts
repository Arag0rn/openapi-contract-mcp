import type { JsonSchema } from './spec.js';

export type Issue = {
  /** JSON-path-like location, e.g. `$.address.zip` or `$.tags[2]`. */
  path: string;
  kind: 'missing' | 'unknown' | 'type' | 'enum' | 'no-variant' | 'read-only';
  message: string;
};

/**
 * Compares a real payload with a dereferenced schema.
 * Not a full JSON Schema validator: it covers what breaks requests in practice
 * (missing required fields, unknown fields, wrong types, enum values, readOnly fields sent),
 * and reports each problem with a path the agent can act on.
 */
export function diffPayload(schema: JsonSchema, payload: unknown, path = '$'): Issue[] {
  if (schema.allOf?.length) {
    return diffPayload(mergeAllOf(schema), payload, path);
  }

  const variants = schema.oneOf ?? schema.anyOf;
  if (variants?.length) {
    const results = variants.map((variant) => diffPayload(variant, payload, path));
    if (results.some((issues) => issues.length === 0)) return [];
    // Report the variant that came closest, so the message stays short and useful.
    const closest = results.reduce((best, issues) => (issues.length < best.length ? issues : best));
    return [
      {
        path,
        kind: 'no-variant',
        message: `Matches none of the ${variants.length} allowed variants. Closest one fails with: ${closest
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; ')}`,
      },
    ];
  }

  if (payload === null) {
    return isNullable(schema) ? [] : [{ path, kind: 'type', message: `is null, expected ${describeType(schema)}` }];
  }

  const expected = expectedTypes(schema);
  const actual = jsonType(payload);
  if (expected.length && !expected.includes(actual) && !(actual === 'integer' && expected.includes('number'))) {
    return [{ path, kind: 'type', message: `is ${actual}, expected ${describeType(schema)}` }];
  }

  if (schema.enum && !schema.enum.some((value) => value === payload)) {
    return [
      {
        path,
        kind: 'enum',
        message: `is ${JSON.stringify(payload)}, allowed: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      },
    ];
  }

  if (actual === 'array' && schema.items) {
    return (payload as unknown[]).flatMap((item, index) => diffPayload(schema.items!, item, `${path}[${index}]`));
  }

  if (actual === 'object' && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    return diffObject(schema, payload as Record<string, unknown>, path);
  }

  return [];
}

function diffObject(schema: JsonSchema, payload: Record<string, unknown>, path: string): Issue[] {
  const issues: Issue[] = [];
  const properties = schema.properties ?? {};

  for (const name of schema.required ?? []) {
    if (!(name in payload) && !properties[name]?.readOnly) {
      issues.push({ path: `${path}.${name}`, kind: 'missing', message: 'is required but missing' });
    }
  }

  for (const [name, value] of Object.entries(payload)) {
    const child = properties[name];
    if (child) {
      if (child.readOnly) {
        issues.push({
          path: `${path}.${name}`,
          kind: 'read-only',
          message: 'is readOnly: the server sets it, do not send it',
        });
      } else {
        issues.push(...diffPayload(child, value, `${path}.${name}`));
      }
      continue;
    }
    if (typeof schema.additionalProperties === 'object') {
      issues.push(...diffPayload(schema.additionalProperties, value, `${path}.${name}`));
    } else if (schema.additionalProperties !== true) {
      // OpenAPI allows extra fields by default, but most backends drop or reject them silently,
      // which is exactly the "the backend ignores my field" bug. So report it, with the closest known name.
      const hint = closestName(name, Object.keys(properties));
      issues.push({
        path: `${path}.${name}`,
        kind: 'unknown',
        message: `is not in the schema${hint ? `, did you mean "${hint}"?` : ''}`,
      });
    }
  }
  return issues;
}

function mergeAllOf(schema: JsonSchema): JsonSchema {
  const { allOf = [], ...rest } = schema;
  return [rest, ...allOf.map((part) => (part.allOf ? mergeAllOf(part) : part))].reduce<JsonSchema>(
    (acc, part) => ({
      ...acc,
      ...part,
      properties: { ...acc.properties, ...part.properties },
      required: [...new Set([...(acc.required ?? []), ...(part.required ?? [])])],
    }),
    {},
  );
}

function expectedTypes(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type.filter((t) => t !== 'null');
  if (schema.type) return [schema.type];
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

function isNullable(schema: JsonSchema): boolean {
  // OpenAPI 3.0 uses `nullable: true`, 3.1 uses `type: [..., 'null']`.
  return schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
}

function describeType(schema: JsonSchema): string {
  const types = expectedTypes(schema);
  const base = types.length ? types.join(' | ') : 'any';
  return schema.format ? `${base} (${schema.format})` : base;
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Catches the usual suspects: camelCase vs snake_case and small typos. */
function closestName(name: string, candidates: string[]): string | undefined {
  const flat = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
  const exact = candidates.find((candidate) => flat(candidate) === flat(name));
  if (exact) return exact;

  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(flat(candidate), flat(name));
    if (distance <= 2 && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best?.name;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}
