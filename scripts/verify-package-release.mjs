import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const treeish = process.env.PACKAGE_RELEASE_TREEISH ?? 'HEAD';
const packages = [
  { directory: 'core', name: '@networkselfmd/core' },
  { directory: 'node', name: '@networkselfmd/node' },
  { directory: 'web', name: '@networkselfmd/web' },
  { directory: 'mcp', name: '@networkselfmd/mcp', bin: 'networkselfmd-mcp' },
  { directory: 'cli', name: '@networkselfmd/cli', bin: 'networkselfmd' },
];

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: options.encoding,
    env: { ...process.env, CI: 'true', ...options.env },
    stdio: options.encoding ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPublishableContents(packageName, entries) {
  const files = entries.filter(Boolean).map((entry) => entry.replace(/^\.\//, ''));
  const allowedRootFiles = new Set([
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
  ]);

  for (const file of files) {
    const allowed =
      allowedRootFiles.has(file) ||
      file === 'package/' ||
      file === 'package/dist/' ||
      file.startsWith('package/dist/');
    assert(allowed, `${packageName}: unexpected tarball entry ${file}`);
    assert(!file.includes('/src/'), `${packageName}: source file leaked: ${file}`);
    assert(!file.includes('/__tests__/'), `${packageName}: test file leaked: ${file}`);
    assert(!/\.test\.[^.]+$/.test(file), `${packageName}: test file leaked: ${file}`);
    assert(!file.endsWith('.map'), `${packageName}: source map leaked: ${file}`);
  }

  for (const required of [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/index.d.ts',
  ]) {
    assert(files.includes(required), `${packageName}: missing ${required}`);
  }
}

function inspectTarball(descriptor, tarball) {
  const listing = run('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assertPublishableContents(descriptor.name, listing);
  if (descriptor.bin) {
    assert(
      listing.includes('package/dist/bin.js'),
      `${descriptor.name}: missing package/dist/bin.js`,
    );
  }

  const manifest = JSON.parse(
    run('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  assert(manifest.license === 'MIT', `${descriptor.name}: missing MIT metadata`);
  assert(manifest.engines?.node === '>=20.0.0', `${descriptor.name}: missing Node engine`);
  assert(
    manifest.repository?.directory === `packages/${descriptor.directory}`,
    `${descriptor.name}: wrong repository directory`,
  );
  for (const value of Object.values(manifest.dependencies ?? {})) {
    assert(!String(value).startsWith('workspace:'), `${descriptor.name}: workspace dependency leaked`);
  }
}

function inspectNpmDryRun(descriptor, packageDirectory) {
  const result = JSON.parse(
    run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: packageDirectory,
      encoding: 'utf8',
    }),
  );
  const entries = result[0].files.map(({ path }) => `package/${path}`);
  assertPublishableContents(`${descriptor.name} (npm dry-run)`, entries);
  if (descriptor.bin) {
    assert(
      entries.includes('package/dist/bin.js'),
      `${descriptor.name} (npm dry-run): missing package/dist/bin.js`,
    );
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'networkselfmd-package-release-'));
try {
  const archive = join(temporaryRoot, 'source.tar');
  const source = join(temporaryRoot, 'source');
  const tarballs = join(temporaryRoot, 'tarballs');
  const consumer = join(temporaryRoot, 'consumer');
  mkdirSync(source);
  mkdirSync(tarballs);
  mkdirSync(consumer);

  run('git', ['archive', '--format=tar', `--output=${archive}`, treeish]);
  run('tar', ['-xf', archive, '-C', source]);
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: source });

  const packed = [];
  for (const descriptor of packages) {
    const packageDirectory = join(source, 'packages', descriptor.directory);
    const before = new Set(readdirSync(tarballs));
    run('pnpm', ['pack', '--pack-destination', tarballs], { cwd: packageDirectory });
    const created = readdirSync(tarballs).filter(
      (file) => file.endsWith('.tgz') && !before.has(file),
    );
    assert(created.length === 1, `${descriptor.name}: expected one tarball, got ${created.length}`);
    const tarball = join(tarballs, created[0]);
    inspectTarball(descriptor, tarball);
    inspectNpmDryRun(descriptor, packageDirectory);
    packed.push(tarball);
  }

  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'package-release-smoke', private: true, type: 'module' }),
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...packed],
    { cwd: consumer },
  );

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const names = ${JSON.stringify(packages.map(({ name }) => name))};
       for (const name of names) {
         const module = await import(name);
         if (Object.keys(module).length === 0) throw new Error(name + ' exported nothing');
       }
       console.log('package imports: ok');`,
    ],
    { cwd: consumer },
  );

  const cliBin = join(consumer, 'node_modules', '.bin', 'networkselfmd');
  const cliHelp = run(cliBin, ['--help'], { cwd: consumer, encoding: 'utf8' });
  assert(cliHelp.includes('Terminal interface for network.self.md'), 'CLI --help smoke failed');

  const mcpBin = join(consumer, 'node_modules', '@networkselfmd', 'mcp', 'dist', 'bin.js');
  assert(readFileSync(mcpBin, 'utf8').startsWith('#!/usr/bin/env node'), 'MCP bin lost shebang');
  run(process.execPath, ['--check', mcpBin], { cwd: consumer });

  console.log(`Verified ${packed.length} clean-archive package tarballs.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
