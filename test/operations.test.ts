import { describe, expect, it } from 'vitest';

import {
  findEndpoints,
  getOperation,
  getRequestContract,
  getResponseContracts,
  suggestOperations,
} from '../src/operations.js';
import { loadFixture } from './helpers.js';

const doc = loadFixture();

describe('findEndpoints', () => {
  it('resolves a docs anchor (operationId) to the real path', () => {
    const [first] = findEndpoints(doc, 'change-email');
    expect(first).toMatchObject({ method: 'POST', path: '/auth/set_email/', matchedOn: 'operationId' });
  });

  it('matches path fragments regardless of separators', () => {
    expect(findEndpoints(doc, 'set email').map((m) => m.path)).toContain('/auth/set_email/');
  });

  it('ranks an exact operationId above partial matches', () => {
    const results = findEndpoints(doc, 'users-list');
    expect(results[0]?.operationId).toBe('users-list');
  });

  it('finds by tag and marks deprecated operations', () => {
    const results = findEndpoints(doc, 'users');
    expect(results.find((m) => m.method === 'PATCH')?.deprecated).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(findEndpoints(doc, '  ')).toEqual([]);
  });
});

describe('suggestOperations', () => {
  it('names the available methods when the path exists', () => {
    expect(suggestOperations(doc, 'DELETE', '/users/')[0]).toContain('Methods: GET, POST');
  });

  it('suggests close paths when the path does not exist', () => {
    expect(suggestOperations(doc, 'POST', '/accounts/set_email')).toContain('POST /auth/set_email/');
  });

  it('puts operations with the requested method first and handles plural paths', () => {
    expect(suggestOperations(doc, 'PATCH', '/user/5')[0]).toBe('PATCH /users/{id}/');
    expect(suggestOperations(doc, 'GET', '/categories')[0]).toBe('GET /categories/{id}/');
  });
});

describe('getRequestContract', () => {
  it('lists required body fields without readOnly ones', () => {
    const contract = getRequestContract(doc, getOperation(doc, 'post', '/users/')!);
    expect(contract.body?.requiredFields).toEqual(['email', 'role']);
    expect(contract.body?.schema.properties).not.toHaveProperty('id');
    expect(contract.body?.schema.properties).not.toHaveProperty('created_at');
  });

  it('merges path-level parameters and resolves parameter $refs', () => {
    const contract = getRequestContract(doc, getOperation(doc, 'GET', '/users/')!);
    expect(contract.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'X-Tenant', in: 'header', required: true }),
        expect.objectContaining({ name: 'role', in: 'query', required: false }),
      ]),
    );
  });

  it('treats path parameters as required even when the schema omits it', () => {
    const contract = getRequestContract(doc, getOperation(doc, 'GET', '/users/{id}/')!);
    expect(contract.parameters).toContainEqual(expect.objectContaining({ name: 'id', in: 'path', required: true }));
  });
});

describe('getResponseContracts', () => {
  it('filters by status and resolves response $refs', () => {
    const ref = getOperation(doc, 'POST', '/auth/set_email/')!;
    const { responses } = getResponseContracts(doc, ref, '400');
    expect(responses).toHaveLength(1);
    expect(responses[0]?.description).toBe('Validation failed');
  });

  it('lists the documented statuses when the wanted one is missing', () => {
    const ref = getOperation(doc, 'GET', '/users/{id}/')!;
    const result = getResponseContracts(doc, ref, '500');
    expect(result.responses).toEqual([]);
    expect(result.available).toEqual(['200', '404']);
  });
});
