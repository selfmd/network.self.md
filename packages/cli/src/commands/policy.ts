import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import {
  AgentDatabase,
  PolicyConfigRepository,
  validatePolicyConfig,
  PolicyConfigValidationError,
  formatValidationErrors,
} from '@networkselfmd/node';
import type { PolicyConfig } from '@networkselfmd/node';

// ---------------------------------------------------------------------------
// CLI policy commands are owner-private, local-only operator controls.
//
// They MUST NOT instantiate Agent / start the swarm / rejoin groups / join the
// TTYA topic. The promise to the operator is "this just edits a row in your
// local SQLite", and that's what these commands do — they go straight to
// AgentDatabase + PolicyConfigRepository + validatePolicyConfig with no
// network in sight.
// ---------------------------------------------------------------------------

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

// Open the local DB, run a synchronous transform with a PolicyConfigRepository,
// then close. Migrations are idempotent so this is safe to call repeatedly.
function withRepo<T>(fn: (repo: PolicyConfigRepository) => T): T {
  const db = new AgentDatabase(getDataDir());
  db.migrate();
  try {
    return fn(new PolicyConfigRepository(db.getDb()));
  } finally {
    db.close();
  }
}

function describeError(err: unknown): string {
  if (err instanceof PolicyConfigValidationError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

function fail(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

function printConfig(c: PolicyConfig): void {
  console.log(chalk.bold('\nPolicy configuration\n'));
  const trusted = c.trustedFingerprints ?? [];
  const interests = c.interests ?? [];
  console.log(`  ${chalk.dim('Trusted fingerprints:')} ${trusted.length === 0 ? chalk.dim('(none)') : ''}`);
  for (const fp of trusted) console.log(`    - ${fp}`);
  console.log(`  ${chalk.dim('Interests:')} ${interests.length === 0 ? chalk.dim('(none)') : ''}`);
  for (const kw of interests) console.log(`    - ${kw}`);
  console.log(
    `  ${chalk.dim('requireMention:')}    ${c.requireMention === undefined ? chalk.dim('(default: true)') : c.requireMention}`,
  );
  console.log(
    `  ${chalk.dim('mentionPrefixLen:')}  ${c.mentionPrefixLen === undefined ? chalk.dim('(default: 8)') : c.mentionPrefixLen}`,
  );
  console.log();
}

// Validate + persist in a single repo-open. Throws on bad input — caller
// turns that into a CLI failure. Used by every mutation command below so
// validation is defined once.
function persistConfig(merged: PolicyConfig): PolicyConfig {
  return withRepo((repo) => {
    const result = validatePolicyConfig(merged);
    if (!result.ok) throw new PolicyConfigValidationError(result.errors);
    repo.save(result.config);
    return result.config;
  });
}

export async function policyGet(): Promise<void> {
  const config = withRepo((repo) => repo.load() ?? {});
  printConfig(config);
}

export interface PolicySetOpts {
  interests?: string;
  trusted?: string;
  requireMention?: string;
  mentionPrefixLen?: string;
  reset?: boolean;
}

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBool(raw: string | undefined, field: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === 'yes' || lower === '1') return true;
  if (lower === 'false' || lower === 'no' || lower === '0') return false;
  fail(`--${field} must be true/false (got "${raw}")`);
}

function parseInteger(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) fail(`--${field} must be an integer (got "${raw}")`);
  return n;
}

export async function policySet(opts: PolicySetOpts): Promise<void> {
  // CLI `reset` clears the persisted row. The CLI has no programmatic
  // AgentOptions context, so reset reverts to the empty default {} — not
  // to a previously-passed AgentOptions.policyConfig. Operators that
  // want different defaults should restart their agent with a desired
  // AgentOptions.policyConfig and then `policy set --reset` from the
  // CLI will defer to that on the next agent start.
  if (opts.reset) {
    withRepo((repo) => repo.clear());
    console.log(chalk.green('\nPolicy reset (persisted row cleared).\n'));
    printConfig({});
    return;
  }

  const partial: Partial<PolicyConfig> = {};
  const trusted = parseList(opts.trusted);
  const interests = parseList(opts.interests);
  const requireMention = parseBool(opts.requireMention, 'require-mention');
  const mentionPrefixLen = parseInteger(opts.mentionPrefixLen, 'mention-prefix-len');
  if (trusted !== undefined) partial.trustedFingerprints = trusted;
  if (interests !== undefined) partial.interests = interests;
  if (requireMention !== undefined) partial.requireMention = requireMention;
  if (mentionPrefixLen !== undefined) partial.mentionPrefixLen = mentionPrefixLen;
  if (Object.keys(partial).length === 0) {
    fail('Nothing to set. Pass at least one of --interests, --trusted, --require-mention, --mention-prefix-len, or --reset.');
  }

  let updated: PolicyConfig;
  try {
    const merged = withRepo((repo) => ({ ...(repo.load() ?? {}), ...partial }));
    updated = persistConfig(merged);
  } catch (err) {
    fail(describeError(err));
  }
  console.log(chalk.green('\nPolicy updated.\n'));
  printConfig(updated);
}

function mutateList(
  field: 'trustedFingerprints' | 'interests',
  transform: (current: string[]) => string[],
): PolicyConfig {
  const merged = withRepo((repo) => {
    const cur = repo.load() ?? {};
    const list = cur[field] ?? [];
    const next = transform(list);
    return { ...cur, [field]: next };
  });
  return persistConfig(merged);
}

export async function policyTrustAdd(fingerprint: string): Promise<void> {
  try {
    mutateList('trustedFingerprints', (list) => Array.from(new Set([...list, fingerprint])));
  } catch (err) {
    fail(describeError(err));
  }
  console.log(chalk.green(`\nTrusted: ${fingerprint}\n`));
}

export async function policyTrustRemove(fingerprint: string): Promise<void> {
  const target = fingerprint.toLowerCase();
  try {
    mutateList('trustedFingerprints', (list) => list.filter((fp) => fp !== target));
  } catch (err) {
    fail(describeError(err));
  }
  console.log(chalk.green(`\nUntrusted: ${fingerprint}\n`));
}

export async function policyInterestAdd(keyword: string): Promise<void> {
  try {
    mutateList('interests', (list) => Array.from(new Set([...list, keyword])));
  } catch (err) {
    fail(describeError(err));
  }
  console.log(chalk.green(`\nInterest added: ${keyword}\n`));
}

export async function policyInterestRemove(keyword: string): Promise<void> {
  try {
    mutateList('interests', (list) => list.filter((k) => k !== keyword));
  } catch (err) {
    fail(describeError(err));
  }
  console.log(chalk.green(`\nInterest removed: ${keyword}\n`));
}

// Re-exported for unit tests so they can verify validator messages
// without re-importing from the node package.
export { formatValidationErrors };
