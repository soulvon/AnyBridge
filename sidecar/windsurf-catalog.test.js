import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WINDSURF_CATALOG, loadWindsurfCatalog } from './windsurf-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('WINDSURF_CATALOG loads directly from windsurf-catalog.json without drift', () => {
  const jsonPath = path.join(__dirname, 'windsurf-catalog.json');
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.ok(Array.isArray(raw.models) && raw.models.length > 0);
  assert.deepEqual(WINDSURF_CATALOG, raw.models);
  assert.deepEqual(loadWindsurfCatalog(), raw.models);
});

