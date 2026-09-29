import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { OpenApiDocument } from '../src/spec.js';

export const fixturePath = fileURLToPath(new URL('./fixtures/crm.openapi.json', import.meta.url));

export const loadFixture = (): OpenApiDocument => JSON.parse(readFileSync(fixturePath, 'utf8'));
