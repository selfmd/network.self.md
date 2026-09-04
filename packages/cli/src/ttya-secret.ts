import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { copyAndValidateTTYAAuthSecret } from '@networkselfmd/core';

export const TTYA_PSK_ENV = 'NETWORKSELFMD_TTYA_PSK';

function decodeEnvironmentSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (
    decoded.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')
  ) {
    throw new Error(`${TTYA_PSK_ENV} must be canonical hex or base64`);
  }
  return decoded;
}

/**
 * Load the single PSK used by Agent, TTYAManager, TTYABridge, and TTYAServer.
 * An environment value takes precedence; otherwise an owner-only raw key file
 * is loaded or created atomically.
 */
export function loadOrCreateTTYASecret(
  keyPath: string,
  environmentValue = process.env[TTYA_PSK_ENV],
): Uint8Array {
  if (environmentValue) {
    return copyAndValidateTTYAAuthSecret(
      decodeEnvironmentSecret(environmentValue),
    );
  }

  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(keyPath, 'wx', 0o600);
    try {
      writeFileSync(fd, randomBytes(32));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }
  const permissions = statSync(keyPath).mode & 0o777;
  if (process.platform !== 'win32' && (permissions & 0o077) !== 0) {
    throw new Error(
      `TTYA PSK file must not be accessible by group or others: ${keyPath}`,
    );
  }
  return copyAndValidateTTYAAuthSecret(readFileSync(keyPath));
}
