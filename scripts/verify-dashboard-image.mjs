import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const image = process.argv[2] ?? 'networkselfmd-dashboard:release-candidate';
const name = `networkselfmd-smoke-${randomBytes(6).toString('hex')}`;
const directory = mkdtempSync(join(tmpdir(), 'networkselfmd-image-'));
const password = randomBytes(32).toString('hex');
const publication = join(directory, 'publication.json');
writeFileSync(publication, JSON.stringify({ stateIds: [], stateContextIds: [], peers: {} }));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
let started = false;
try {
  docker('run', '-d', '--name', name,
    '-p', '127.0.0.1::3001',
    '-e', 'DASHBOARD_USERNAME=operator', '-e', `DASHBOARD_PASSWORD=${password}`,
    '-e', 'DASHBOARD_PUBLIC_SITE=true',
    '-e', 'DASHBOARD_OPERATOR_ORIGIN=https://operator.example',
    '-e', 'NETWORK_PUBLICATION_CONFIG=/run/config/publication.json',
    '--mount', `type=bind,src=${publication},dst=/run/config/publication.json,readonly`, image);
  started = true;
  const address = docker('port', name, '3001/tcp').split('\n')[0];
  const base = `http://${address}`;
  const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(3000) });
  let healthy = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { healthy = (await request('/healthz')).ok; } catch {}
    if (healthy) break;
    if (docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') {
      throw new Error(`Container exited before readiness:\n${docker('logs', name)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(healthy, 'Container did not become healthy');
  assert.equal((await request('/')).status, 200, 'public HTML');
  const feed = await request('/api/public/network');
  assert.equal(feed.status, 200, 'anonymous approved feed');
  const data = await feed.json();
  assert.equal(data.states.length, 0, 'empty allowlist must publish no states');
  assert.equal(data.peers.length, 0, 'empty allowlist must publish no peers');
  for (const path of ['/api/status', '/api/peers', '/api/states', '/api/identity']) {
    assert.equal((await request(path)).status, 401, `anonymous private route ${path}`);
  }
  const authorization = `Basic ${Buffer.from(`operator:${password}`).toString('base64')}`;
  assert.equal((await request('/api/status', { headers: { authorization } })).status, 200, 'authenticated status');
  assert.equal((await request('/api/discovery/states/' + '00'.repeat(32) + '/join', {
    method: 'POST', headers: { authorization, origin: 'https://unapproved.example', 'content-type': 'application/json' }, body: '{}',
  })).status, 403, 'unapproved mutation origin');
  console.log(`Dashboard image smoke passed: ${image}`);
} finally {
  if (started) docker('rm', '-f', '-v', name);
  rmSync(directory, { recursive: true, force: true });
}
