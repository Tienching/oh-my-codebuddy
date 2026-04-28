import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmb(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const ombBin = join(repoRoot, 'dist', 'cli', 'omb.js');
  const r = spawnSync(process.execPath, [ombBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('omb doctor invalid config detection', () => {
  it('fails when settings.json contains invalid JSON', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omb-doctor-invalid-config-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codebuddy');
      await mkdir(codexDir, { recursive: true });

      await writeFile(
        join(codexDir, 'settings.json'),
        `{invalid json content`,
      );

      const res = runOmb(wd, ['doctor'], {
        HOME: home,
        CODEBUDDY_HOME: codexDir,
      });

      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /\[XX\] Config: invalid settings\.json/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
