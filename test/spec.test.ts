import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { dereference, SpecLoader } from '../src/spec.js';
import { fixturePath, loadFixture } from './helpers.js';

const fixtureText = readFileSync(fixturePath, 'utf8');
const response = (body: string, status = 200) => new Response(body, { status });

describe('SpecLoader', () => {
  it('reads a local file', async () => {
    const { doc } = await new SpecLoader({ source: fixturePath }).get();
    expect(doc.info.title).toBe('Demo CRM API');
  });

  it('downloads once and serves from cache within the TTL', async () => {
    const fetchImpl = vi.fn(async () => response(fixtureText));
    let now = 0;
    const loader = new SpecLoader({ source: 'https://api.example.com/schema', ttlMs: 1000, fetchImpl, now: () => now });

    await loader.get();
    now = 999;
    await loader.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 1000;
    await loader.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refresh=true bypasses the cache', async () => {
    const fetchImpl = vi.fn(async () => response(fixtureText));
    const loader = new SpecLoader({ source: 'https://api.example.com/schema', fetchImpl });
    await loader.get();
    await loader.get({ refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one download between concurrent calls', async () => {
    const fetchImpl = vi.fn(async () => response(fixtureText));
    const loader = new SpecLoader({ source: 'https://api.example.com/schema', fetchImpl });
    await Promise.all([loader.get(), loader.get(), loader.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports HTTP errors with the status code', async () => {
    const loader = new SpecLoader({ source: 'https://api.example.com/schema', fetchImpl: async () => response('', 403) });
    await expect(loader.get()).rejects.toThrow('HTTP 403');
  });

  it('rejects swagger 2.0 and non-JSON documents with a clear message', async () => {
    const swagger = new SpecLoader({
      source: 'https://x.test/s',
      fetchImpl: async () => response(JSON.stringify({ swagger: '2.0', paths: {} })),
    });
    await expect(swagger.get()).rejects.toThrow('not an OpenAPI 3.x document');

    const yaml = new SpecLoader({ source: 'https://x.test/s', fetchImpl: async () => response('openapi: 3.0.0') });
    await expect(yaml.get()).rejects.toThrow('not valid JSON');
  });
});

describe('dereference', () => {
  it('inlines nested $refs', () => {
    const doc = loadFixture();
    const user = dereference(doc, { $ref: '#/components/schemas/User' });
    expect(user.properties?.role?.enum).toEqual(['owner', 'admin', 'staff']);
    expect(user.properties?.address?.required).toEqual(['city']);
  });

  it('stops at recursive schemas instead of looping forever', () => {
    const doc = loadFixture();
    const category = dereference(doc, { $ref: '#/components/schemas/Category' });
    expect(category.properties?.children?.items?.description).toBe(
      '[circular reference to #/components/schemas/Category]',
    );
  });
});
