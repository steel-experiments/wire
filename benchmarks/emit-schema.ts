// ABOUTME: Emit benchmark_tasks.schema.json from the Zod source-of-truth in schema.ts.
// ABOUTME: Run with `bun run benchmarks/emit-schema.ts` (or via tsx) after editing schema.ts.

import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkFile } from './schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, 'benchmark_tasks.schema.json');

// Zod marks `.default()` fields as required (they're always present after parse).
// For raw on-disk JSON we want them optional, so drop defaulted keys from any `required[]`.
function relaxDefaults(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relaxDefaults);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.properties && Array.isArray(o.required)) {
      const props = o.properties as Record<string, { default?: unknown }>;
      const defaulted = new Set(Object.keys(props).filter((k) => 'default' in (props[k] ?? {})));
      o.required = (o.required as string[]).filter((k) => !defaulted.has(k));
      if (!(o.required as string[]).length) delete o.required;
    }
    for (const k of Object.keys(o)) o[k] = relaxDefaults(o[k]);
  }
  return node;
}

const emitted = relaxDefaults(z.toJSONSchema(BenchmarkFile, { target: 'draft-2020-12' })) as Record<string, unknown>;
const out = {
  $id: 'https://wire.dev/benchmarks/benchmark_tasks.schema.json',
  title: 'Wire Benchmark Tasks',
  description: 'Auto-emitted from benchmarks/schema.ts. Do not hand-edit.',
  ...emitted,
};

writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${path}`);
