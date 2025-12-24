#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Usage: node scripts/run-deal-engine.mjs <fixture.json>
const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('Usage: node scripts/run-deal-engine.mjs <fixture.json>');
  process.exit(1);
}

const request = JSON.parse(readFileSync(fixturePath, 'utf8'));

// Import engine (adjust path based on build output)
const { DealEngineRuntime } = await import('../services/deal-engine/dist/index.js');

const engine = new DealEngineRuntime(request);
const validation = engine.validate();
if (!validation.valid) {
  console.error('Validation failed:', validation.errors);
  process.exit(1);
}

const result = engine.run();

// Output to stdout
console.log(JSON.stringify(result, null, 2));

// Write artifact
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = join(__dirname, '..', 'artifacts', 'deal-engine', timestamp);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, basename(fixturePath).replace('.json', '.result.json')), JSON.stringify(result, null, 2));
console.error(`Artifact written to ${artifactDir}`);
