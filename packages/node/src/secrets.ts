import { readFile } from 'node:fs/promises';

export type SecretProvider = () => string | Promise<string>;

/**
 * Creates a lazy provider so long-running entrypoints can obtain a passphrase
 * from a mounted secret without putting it in argv or logs.
 */
export function secretFileProvider(filePath: string): SecretProvider {
  return async () => {
    const contents = await readFile(filePath, { encoding: 'utf8' });
    return contents.replace(/(?:\r\n|\n)$/, '');
  };
}
