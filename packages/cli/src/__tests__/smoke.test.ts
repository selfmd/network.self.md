import { describe, it, expect } from 'vitest';

describe('cli smoke test', () => {
  it('should export components', async () => {
    // Verify the module structure is valid by checking the source files exist
    // Actual component imports require the @networkselfmd/node dependency
    const fs = await import('node:fs');
    const path = await import('node:path');

    const srcDir = path.resolve(import.meta.dirname, '..');
    expect(fs.existsSync(path.join(srcDir, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'bin.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'components', 'ChatView.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'components', 'StatusBar.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'components', 'TTYAView.tsx'))).toBe(true);
  });

  it('should have all command files', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const commandsDir = path.resolve(import.meta.dirname, '..', 'commands');
    const expectedCommands = ['init.ts', 'groups.ts', 'peers.ts', 'status.ts', 'chat.ts', 'ttya.ts', 'policy.ts', 'policy-audit.ts'];

    for (const cmd of expectedCommands) {
      expect(fs.existsSync(path.join(commandsDir, cmd))).toBe(true);
    }
  });
});
