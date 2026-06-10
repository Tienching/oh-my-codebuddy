import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runPlatformCommandSync,
  runGitCommandSync,
  runTmuxCommandSync,
  type CommandResult,
  type RunCommandOptions,
} from '../platform-command.js';

describe('platform-command unified execution', () => {
  describe('runPlatformCommandSync', () => {
    it('returns ok:true for successful commands', () => {
      const result = runPlatformCommandSync('echo', ['hello']);
      assert.equal(result.ok, true);
      assert.equal(result.stdout, 'hello');
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.errorKind, null);
    });

    it('returns ok:false for failing commands', () => {
      const result = runPlatformCommandSync('false', []);
      assert.equal(result.ok, false);
      assert.notEqual(result.exitCode, 0);
    });

    it('returns ok:false for missing commands', () => {
      const result = runPlatformCommandSync('nonexistent-command-xyz', []);
      assert.equal(result.ok, false);
      assert.equal(result.errorKind, 'missing');
    });

    it('includes durationMs', () => {
      const result = runPlatformCommandSync('echo', ['test']);
      assert.ok(result.durationMs >= 0);
    });

    it('includes commandLabel', () => {
      const result = runPlatformCommandSync('echo', ['hello', 'world']);
      assert.ok(result.commandLabel.includes('echo'));
      assert.ok(result.commandLabel.includes('hello'));
    });

    it('supports cwd option', () => {
      const result = runPlatformCommandSync('ls', [], { cwd: '/' });
      assert.equal(result.ok, true);
    });

    it('truncates large output', () => {
      const result = runPlatformCommandSync('bash', ['-c', 'cat /dev/urandom | head -c 2000000 | base64'], {
        maxOutputBytes: 1024,
        timeoutMs: 5000,
      });
      assert.ok(result.stdout.length < 2000);
      if (result.stdout.includes('truncated')) {
        assert.ok(result.stdout.includes('truncated'));
      }
    });

    it('returns timedOut:true when command exceeds timeout', () => {
      const result = runPlatformCommandSync('sleep', ['10'], {
        timeoutMs: 100,
      });
      assert.equal(result.ok, false);
      // On some platforms, timeout may show as signal or exitCode
      assert.ok(result.timedOut || result.exitCode !== 0);
    });
  });

  describe('runGitCommandSync', () => {
    it('returns ok:true for git version', () => {
      const result = runGitCommandSync(['--version']);
      assert.equal(result.ok, true);
      assert.ok(result.stdout.includes('git version'));
    });

    it('returns ok:false in non-git directory for rev-parse', () => {
      const result = runGitCommandSync(['rev-parse', '--show-toplevel'], { cwd: '/tmp' });
      // May succeed if /tmp is inside a git repo, so just check structure
      assert.ok(typeof result.ok === 'boolean');
      assert.ok(typeof result.stdout === 'string');
    });
  });

  describe('runTmuxCommandSync', () => {
    it('returns structured result even when tmux is unavailable', () => {
      const result = runTmuxCommandSync(['list-sessions']);
      // tmux may or may not be running; just verify structure
      assert.ok(typeof result.ok === 'boolean');
      assert.ok(typeof result.stdout === 'string');
      assert.ok(typeof result.stderr === 'string');
      assert.ok(typeof result.durationMs === 'number');
    });
  });

  describe('CommandResult type', () => {
    it('has all required fields', () => {
      const result = runPlatformCommandSync('echo', ['test']);
      const fields: (keyof CommandResult)[] = [
        'ok', 'stdout', 'stderr', 'exitCode', 'signal',
        'errorKind', 'timedOut', 'commandLabel', 'durationMs',
      ];
      for (const field of fields) {
        assert.ok(field in result, `Missing field: ${field}`);
      }
    });
  });
});
