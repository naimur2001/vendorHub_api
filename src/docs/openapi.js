import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'openapi');

// base.yaml holds info, login methods and shared schemas; every file in docs/openapi/paths
// adds its own paths (and optional schemas). Files are merged in name order (01-, 02-, ...).
export function loadOpenApi() {
  const spec = YAML.parse(readFileSync(path.join(dir, 'base.yaml'), 'utf8'));
  spec.paths ??= {};
  spec.components ??= {};
  spec.components.schemas ??= {};

  const files = readdirSync(path.join(dir, 'paths'))
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  for (const f of files) {
    const part = YAML.parse(readFileSync(path.join(dir, 'paths', f), 'utf8')) ?? {};
    for (const [route, operations] of Object.entries(part.paths ?? {})) {
      spec.paths[route] = { ...(spec.paths[route] ?? {}), ...operations }; // the same path in two files: methods merge
    }
    Object.assign(spec.components.schemas, part.components?.schemas ?? {});
  }
  return spec;
}