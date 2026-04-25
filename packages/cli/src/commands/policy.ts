import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { Agent, PolicyConfigValidationError } from '@networkselfmd/node';
import type { PolicyConfig } from '@networkselfmd/node';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

async function withAgent<T>(fn: (agent: Agent) => Promise<T> | T): Promise<T> {
  const agent = new Agent({ dataDir: getDataDir() });
  await agent.start();
  try {
    return await fn(agent);
  } finally {
    await agent.stop();
  }
}

function describeValidationError(err: unknown): string {
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

export async function policyGet(): Promise<void> {
  await withAgent(async (agent) => {
    printConfig(agent.getPolicyConfig());
  });
}

export interface PolicySetOpts {
  interests?: string;
  trusted?: string;
  requireMention?: string;
  mentionPrefixLen?: string;
  reset?: boolean;
}

// Parse a comma-separated string into a trimmed, non-empty list.
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
  await withAgent(async (agent) => {
    if (opts.reset) {
      agent.resetPolicyConfig();
      console.log(chalk.green('\nPolicy reset to defaults.\n'));
      printConfig(agent.getPolicyConfig());
      return;
    }
    const partial: Record<string, unknown> = {};
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
    try {
      agent.updatePolicyConfig(partial);
    } catch (err) {
      fail(describeValidationError(err));
    }
    console.log(chalk.green('\nPolicy updated.\n'));
    printConfig(agent.getPolicyConfig());
  });
}

export async function policyTrustAdd(fingerprint: string): Promise<void> {
  await withAgent(async (agent) => {
    const cur = agent.getPolicyConfig();
    const set = new Set(cur.trustedFingerprints ?? []);
    set.add(fingerprint);
    try {
      agent.updatePolicyConfig({ trustedFingerprints: Array.from(set) });
    } catch (err) {
      fail(describeValidationError(err));
    }
    console.log(chalk.green(`\nTrusted: ${fingerprint}\n`));
  });
}

export async function policyTrustRemove(fingerprint: string): Promise<void> {
  await withAgent(async (agent) => {
    const cur = agent.getPolicyConfig();
    const next = (cur.trustedFingerprints ?? []).filter((fp) => fp !== fingerprint.toLowerCase());
    try {
      agent.updatePolicyConfig({ trustedFingerprints: next });
    } catch (err) {
      fail(describeValidationError(err));
    }
    console.log(chalk.green(`\nUntrusted: ${fingerprint}\n`));
  });
}

export async function policyInterestAdd(keyword: string): Promise<void> {
  await withAgent(async (agent) => {
    const cur = agent.getPolicyConfig();
    const set = new Set(cur.interests ?? []);
    set.add(keyword);
    try {
      agent.updatePolicyConfig({ interests: Array.from(set) });
    } catch (err) {
      fail(describeValidationError(err));
    }
    console.log(chalk.green(`\nInterest added: ${keyword}\n`));
  });
}

export async function policyInterestRemove(keyword: string): Promise<void> {
  await withAgent(async (agent) => {
    const cur = agent.getPolicyConfig();
    const next = (cur.interests ?? []).filter((k) => k !== keyword);
    try {
      agent.updatePolicyConfig({ interests: next });
    } catch (err) {
      fail(describeValidationError(err));
    }
    console.log(chalk.green(`\nInterest removed: ${keyword}\n`));
  });
}
