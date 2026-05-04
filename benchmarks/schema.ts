// ABOUTME: Zod schema source-of-truth for the wire benchmark task corpus.
// ABOUTME: `benchmark_tasks.schema.json` is hand-mirrored from this; tasks live in `benchmark_tasks.json`.

import { z } from 'zod';

export const Tier = z.enum(['scrape', 'session', 'research', 'agent']);

export const Vertical = z.enum([
  'ecommerce', 'travel', 'financial-services', 'healthcare', 'legal',
  'sales-intel', 'developer-tools', 'knowledge-base', 'logistics',
  'non-profit-gov', 'sports-entertainment', 'hr-recruiting',
  'customer-service', 'rpa-workflow', 'accounting-ops',
  'infra-probe', 'misc',
]);

export const Capability = z.enum([
  'extract-text', 'extract-structured', 'extract-table',
  'navigate', 'multi-step-nav', 'search', 'filter',
  'form-fill', 'login', 'click-flow', 'iframe-interact',
  'file-download', 'file-upload', 'compare', 'synthesize',
]);

export const Infra = z.enum([
  'none', 'proxy', 'profile', 'credentials', 'captcha', 'stealth', 'recording',
]);

export const Source = z.object({
  name: z.enum([
    'wire-original', 'wire-default', 'wire-demo',
    'webvoyager', 'mind2web', 'webarena', 'visualwebarena',
    'gaia', 'assistantbench', 'browsecomp', 'miniwob',
    'webshop', 'osworld', 'agentbench',
  ]),
  task_id: z.string().optional(),
  url: z.string().url().optional(),
  license: z.string().optional(),
  modified: z.boolean().default(false),
  notes: z.string().optional(),
});

export const Auth = z.object({
  type: z.enum(['credentials', 'profile']),
  key: z.string(),
});

export const Grader = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('contains'),
    values: z.array(z.string()).min(1),
    case_sensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('regex'),
    pattern: z.string(),
    flags: z.string().optional(),
  }),
  z.object({
    type: z.literal('json-schema'),
    schema: z.unknown(),
  }),
  z.object({
    type: z.literal('url-match'),
    pattern: z.string(),
  }),
  z.object({
    type: z.literal('llm-judge'),
    rubric: z.string(),
    must_have: z.array(z.string()).optional(),
    must_not_have: z.array(z.string()).optional(),
    reference: z.string().optional(),
    model: z.string().default('gpt-5.4-mini'),
  }),
]);

export const Task = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  prompt: z.string().min(10),
  source: Source,
  vertical: Vertical,
  tier: Tier,
  capabilities: z.array(Capability).min(1),
  infra: z.array(Infra).default(['none']),
  tags: z.array(z.string()).default([]),
  entry_url: z.string().url().optional(),
  auth: Auth.optional(),
  difficulty: z.number().int().min(1).max(5),
  max_steps: z.number().int().min(1).max(50),
  graders: z.array(Grader).min(1),
  dynamic_content: z.enum(['low', 'medium', 'high']).default('low'),
  last_verified: z.string().date(),
  disabled: z
    .object({ reason: z.string(), since: z.string().date() })
    .optional(),
});

export const BenchmarkFile = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  generated_at: z.string().date(),
  tasks: z.array(Task),
});

export type TierT = z.infer<typeof Tier>;
export type VerticalT = z.infer<typeof Vertical>;
export type CapabilityT = z.infer<typeof Capability>;
export type InfraT = z.infer<typeof Infra>;
export type SourceT = z.infer<typeof Source>;
export type AuthT = z.infer<typeof Auth>;
export type GraderT = z.infer<typeof Grader>;
export type TaskT = z.infer<typeof Task>;
export type BenchmarkFileT = z.infer<typeof BenchmarkFile>;
