// ABOUTME: Layered secret resolver for benchmark task credentials and Steel browser profiles.
// ABOUTME: Walks providers env → pass → keychain → op (configurable via WIRE_SECRETS_PROVIDER).

import { spawnSync } from 'node:child_process';

export type Credential = { username: string; password: string; totpSecret?: string };
export type Provider = 'env' | 'pass' | 'keychain' | 'op';

const DEFAULT_ORDER: Provider[] = ['env', 'pass', 'keychain', 'op'];

function order(): Provider[] {
  const raw = process.env.WIRE_SECRETS_PROVIDER;
  if (!raw) return DEFAULT_ORDER;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean) as Provider[];
  return parsed.length ? parsed : DEFAULT_ORDER;
}

const envKey = (k: string) => k.toUpperCase().replace(/-/g, '_');

function sh(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.length ? out : null;
}

function withTotp(username: string, password: string, totp: string | null | undefined): Credential {
  return totp ? { username, password, totpSecret: totp } : { username, password };
}

function envCred(key: string): Credential | null {
  const k = envKey(key);
  const u = process.env[`WIRE_SECRET_${k}_USERNAME`];
  const p = process.env[`WIRE_SECRET_${k}_PASSWORD`];
  if (!u || !p) return null;
  return withTotp(u, p, process.env[`WIRE_SECRET_${k}_TOTP_SECRET`]);
}

function passCred(key: string): Credential | null {
  const u = sh('pass', ['show', `wire/${key}/username`]);
  const p = sh('pass', ['show', `wire/${key}/password`]);
  if (!u || !p) return null;
  return withTotp(u, p, sh('pass', ['show', `wire/${key}/totp`]));
}

function keychainCred(key: string): Credential | null {
  const svc = `wire-${key}`;
  const u = sh('security', ['find-generic-password', '-s', svc, '-a', 'username', '-w']);
  const p = sh('security', ['find-generic-password', '-s', svc, '-a', 'password', '-w']);
  if (!u || !p) return null;
  return withTotp(u, p, sh('security', ['find-generic-password', '-s', svc, '-a', 'totp', '-w']));
}

function opCred(key: string): Credential | null {
  const ref = (f: string) => `op://Wire/${key}/${f}`;
  const u = sh('op', ['read', ref('username')]);
  const p = sh('op', ['read', ref('password')]);
  if (!u || !p) return null;
  return withTotp(u, p, sh('op', ['read', ref('totp')]));
}

const credProviders: Record<Provider, (k: string) => Credential | null> = {
  env: envCred, pass: passCred, keychain: keychainCred, op: opCred,
};

export function resolveCredential(key: string): Credential {
  for (const p of order()) {
    const c = credProviders[p]?.(key);
    if (c) return c;
  }
  throw new Error(`No credential for '${key}' in [${order().join(',')}]`);
}

const profileProviders: Record<Provider, (k: string) => string | null> = {
  env: (k) => process.env[`WIRE_PROFILE_${envKey(k)}`] ?? null,
  pass: (k) => sh('pass', ['show', `wire/profiles/${k}`]),
  keychain: (k) => sh('security', ['find-generic-password', '-s', `wire-profile-${k}`, '-a', 'id', '-w']),
  op: (k) => sh('op', ['read', `op://Wire/profile-${k}/id`]),
};

export function resolveProfile(key: string): string {
  for (const p of order()) {
    const id = profileProviders[p]?.(key);
    if (id) return id;
  }
  throw new Error(`No profile for '${key}' in [${order().join(',')}]`);
}
