import { describe, expect, it } from 'vitest';

import { diffPayload } from '../src/diff.js';
import { getOperation, getRequestBody } from '../src/operations.js';
import { loadFixture } from './helpers.js';

const doc = loadFixture();
const bodyOf = (method: string, path: string) => getRequestBody(doc, getOperation(doc, method, path)!)!.schema;

describe('diffPayload', () => {
  const user = bodyOf('POST', '/users/');

  it('accepts a valid payload', () => {
    expect(diffPayload(user, { email: 'a@b.de', role: 'staff', tags: ['x'] })).toEqual([]);
  });

  it('reports missing required fields but not missing readOnly ones', () => {
    const issues = diffPayload(user, { email: 'a@b.de' });
    expect(issues).toEqual([expect.objectContaining({ path: '$.role', kind: 'missing' })]);
  });

  it('flags readOnly fields that the frontend copied from a GET response', () => {
    const issues = diffPayload(user, { id: 7, email: 'a@b.de', role: 'staff' });
    expect(issues).toEqual([expect.objectContaining({ path: '$.id', kind: 'read-only' })]);
  });

  it('suggests the real name for camelCase vs snake_case mix-ups', () => {
    const issues = diffPayload(user, { email: 'a@b.de', role: 'staff', firstName: 'Ann' });
    expect(issues[0]).toMatchObject({ path: '$.firstName', kind: 'unknown' });
    expect(issues[0]?.message).toContain('did you mean "first_name"');
  });

  it('reports wrong types and enum values with their location', () => {
    const issues = diffPayload(user, { email: 'a@b.de', role: 'manager', tags: ['ok', 3] });
    expect(issues).toEqual([
      expect.objectContaining({ path: '$.role', kind: 'enum' }),
      expect.objectContaining({ path: '$.tags[1]', kind: 'type' }),
    ]);
  });

  it('walks into nested objects and respects nullable', () => {
    expect(diffPayload(user, { email: 'a@b.de', role: 'staff', address: { city: 'Leipzig', zip_code: null } })).toEqual([]);
    expect(diffPayload(user, { email: 'a@b.de', role: 'staff', address: { zip_code: '04329' } })).toEqual([
      expect.objectContaining({ path: '$.address.city', kind: 'missing' }),
    ]);
  });

  it('merges allOf parts', () => {
    const patched = bodyOf('PATCH', '/users/{id}/');
    expect(diffPayload(patched, { first_name: 'Ann', role: 'admin' })).toEqual([]);
    expect(diffPayload(patched, { role: 'boss' })[0]).toMatchObject({ kind: 'enum' });
  });

  it('accepts a payload matching one oneOf variant and explains the closest miss otherwise', () => {
    const payment = bodyOf('POST', '/payments/');
    expect(diffPayload(payment, { method: 'card', plan_id: 3 })).toEqual([]);

    const issues = diffPayload(payment, { method: 'wallet', amount: '10' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('no-variant');
    expect(issues[0]?.message).toContain('$.amount is string, expected number');
  });

  it('accepts integers where the schema says number', () => {
    const payment = bodyOf('POST', '/payments/');
    expect(diffPayload(payment, { method: 'wallet', amount: 10 })).toEqual([]);
  });
});
