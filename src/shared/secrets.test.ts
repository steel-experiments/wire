// ABOUTME: Tests for src/secrets.ts credential and profile resolvers.
// ABOUTME: Exercises the env provider deterministically; shell providers are not invoked here.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveCredential, resolveProfile } from './secrets.js';

function clearEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('WIRE_SECRET_') || k.startsWith('WIRE_PROFILE_')) delete process.env[k];
  }
  process.env.WIRE_SECRETS_PROVIDER = 'env';
}

test('resolveCredential reads username/password/totp from env', () => {
  clearEnv();
  process.env.WIRE_SECRET_GITHUB_BENCH_USERNAME = 'wire-bot';
  process.env.WIRE_SECRET_GITHUB_BENCH_PASSWORD = 'pw-123';
  process.env.WIRE_SECRET_GITHUB_BENCH_TOTP_SECRET = 'TOTP123';
  const c = resolveCredential('github-bench');
  assert.equal(c.username, 'wire-bot');
  assert.equal(c.password, 'pw-123');
  assert.equal(c.totpSecret, 'TOTP123');
});

test('resolveCredential omits totpSecret when not set', () => {
  clearEnv();
  process.env.WIRE_SECRET_REDDIT_BENCH_USERNAME = 'r-bot';
  process.env.WIRE_SECRET_REDDIT_BENCH_PASSWORD = 'r-pw';
  const c = resolveCredential('reddit-bench');
  assert.equal(c.username, 'r-bot');
  assert.equal(c.totpSecret, undefined);
});

test('resolveCredential throws when key is unset', () => {
  clearEnv();
  assert.throws(() => resolveCredential('not-set'), /No credential for 'not-set'/);
});

test('resolveProfile reads from env via WIRE_PROFILE_<KEY>', () => {
  clearEnv();
  process.env.WIRE_PROFILE_REDDIT_BENCH = 'profile-abc-123';
  assert.equal(resolveProfile('reddit-bench'), 'profile-abc-123');
});

test('resolveProfile throws when key is unset', () => {
  clearEnv();
  assert.throws(() => resolveProfile('not-set'), /No profile for 'not-set'/);
});

test('hyphens in keys map to underscores in env names', () => {
  clearEnv();
  process.env.WIRE_SECRET_X_BENCH_USERNAME = 'x-bot';
  process.env.WIRE_SECRET_X_BENCH_PASSWORD = 'x-pw';
  const c = resolveCredential('x-bench');
  assert.equal(c.username, 'x-bot');
});

test('WIRE_SECRETS_PROVIDER=env restricts to env-only', () => {
  clearEnv();
  process.env.WIRE_SECRETS_PROVIDER = 'env';
  assert.throws(() => resolveCredential('never-set'), /\[env\]/);
});
