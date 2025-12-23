import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const schemaPath = join(rootDir, 'contracts', 'deal_engine_v0.schema.json');
const fixturesDir = join(rootDir, 'testcases', 'deal_engine_v0', 'fixtures');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

let passed = 0;
let failed = 0;

for (const file of files) {
  const filePath = join(fixturesDir, file);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const valid = validate(data);
    if (valid) {
      console.log(`✓ PASS: ${file}`);
      passed++;
    } else {
      console.log(`✗ FAIL: ${file}`);
      validate.errors.forEach((err) => {
        console.log(`    ${err.instancePath || '/'}: ${err.message}`);
      });
      failed++;
    }
  } catch (e) {
    console.log(`✗ FAIL: ${file} - ${e.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
