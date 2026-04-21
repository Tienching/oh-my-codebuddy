import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProbedPlatformCommand } from '../../utils/platform-command.js';
import {
  buildSetupBackupContext,
  detectInstallerRuntime,
  isExperimentalInstallerFacadeEnabled,
  resolveInstallerRelativePath,
  runSetupRefresh,
} from '../index.js';


function missingTmuxProbe(): ProbedPlatformCommand {
  const error = new Error('tmux not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return {
    spec: { command: 'tmux', args: ['-V'] },
    result: {
      error,
      status: null,
      signal: null,
      output: [null, '', ''],
      pid: 0,
      stdout: '',
      stderr: '',
    },
  } as ProbedPlatformCommand;
}

function availableTmuxProbe(): ProbedPlatformCommand {
  return {
    spec: { command: 'tmux', args: ['-V'] },
    result: {
      error: undefined,
      status: 0,
      signal: null,
      output: [null, 'tmux 3.4', ''],
      pid: 0,
      stdout: 'tmux 3.4',
      stderr: '',
    },
  } as ProbedPlatformCommand;
}

describe('installer facade helpers', () => {
  it('keeps project-scoped backups under .omb/backups/setup', () => {
    const context = buildSetupBackupContext(
      'project',
      '/tmp/project',
      new Date('2026-04-20T01:02:03.000Z'),
    );

    assert.equal(
      context.backupRoot,
      '/tmp/project/.omb/backups/setup/2026-04-20T01-02-03.000Z',
    );
    assert.equal(context.baseRoot, '/tmp/project');
  });

  it('resolves relative backup paths safely within the base root', () => {
    assert.equal(
      resolveInstallerRelativePath('/tmp/project', '/tmp/project/.codebuddy/config.toml'),
      '.codebuddy/config.toml',
    );
  });

  it('falls back to a sanitized absolute path when the target escapes the base root', () => {
    assert.equal(
      resolveInstallerRelativePath('/tmp/project', '/etc/hosts'),
      'etc/hosts',
    );
  });

  it('keeps the installer facade flag disabled by default', () => {
    assert.equal(isExperimentalInstallerFacadeEnabled({}), false);
  });

  it('accepts canonical truthy flag values', () => {
    assert.equal(
      isExperimentalInstallerFacadeEnabled({
        OMB_EXPERIMENTAL_PLATFORM_FACADE: 'true',
      }),
      true,
    );
    assert.equal(
      isExperimentalInstallerFacadeEnabled({
        OMX_EXPERIMENTAL_INSTALLER_FACADE: '1',
      }),
      true,
    );
  });

  it('detects tmux-missing installer environments without changing setup refresh behavior', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const calls: Array<{ force?: boolean; verbose?: boolean }> = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      const request = { force: true, verbose: true };
      const result = await runSetupRefresh(
        async (options) => {
          calls.push(options ?? {});
        },
        request,
        {
          env: { PATH: '' },
          platform: 'linux',
          spawnPlatformCommandSyncImpl: () => missingTmuxProbe(),
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      );

      assert.deepEqual(calls, [request]);
      assert.equal(result, request);
      assert.match(logs.join('\n'), /installer runtime: .*tmux=missing/);
      assert.match(logs.join('\n'), /reasons=tmux_missing/);
    } finally {
      console.log = originalLog;
    }
  });

  it('marks missing TMUX_PANE as degraded when the process claims tmux context', () => {
    const runtime = detectInstallerRuntime({
      env: {
        PATH: '',
        TMUX: '/tmp/tmux-test.sock,123,0',
      },
      platform: 'linux',
      spawnPlatformCommandSyncImpl: () => availableTmuxProbe(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });

    assert.equal(runtime.insideTmux, true);
    assert.equal(runtime.tmuxAvailable, true);
    assert.equal(runtime.tmuxPane, null);
    assert.equal(runtime.degraded, true);
    assert.deepEqual(runtime.degradedReasons, ['missing_tmux_pane']);
  });
});
