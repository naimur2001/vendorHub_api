// Usage: node scripts/check-openapi.mjs
// Validates the merged OpenAPI spec and checks our own rules: every operation has an
// operationId, a tag and a summary, and no operationId is used twice.
import SwaggerParser from '@apidevtools/swagger-parser';
import { loadOpenApi } from '../src/docs/openapi.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const spec = loadOpenApi();

try {
  await SwaggerParser.validate(structuredClone(spec));
} catch (err) {
  console.error(`INVALID: ${err.message}`);
  process.exit(1);
}

const problems = [];
const seen = new Set();
let count = 0;
for (const [route, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    count += 1;
    const where = `${method.toUpperCase()} ${route}`;
    if (!op.operationId) problems.push(`${where}: no operationId`);
    else if (seen.has(op.operationId)) problems.push(`${where}: operationId "${op.operationId}" used twice`);
    else seen.add(op.operationId);
    if (!op.tags?.length) problems.push(`${where}: no tag`);
    if (!op.summary) problems.push(`${where}: no summary`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`VALID ${count} operations`);