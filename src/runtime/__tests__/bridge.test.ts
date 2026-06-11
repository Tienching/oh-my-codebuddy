import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetRuntimeBridgeSchemaValidationForTests,
  resolveRuntimeBinaryPath,
  RuntimeBridge,
} from '../bridge.js';

afterEach(() => {
  resetRuntimeBridgeSchemaValidationForTests();
});

describe('resolveRuntimeBinaryPath', () => {
  it('prefers explicit OMB_RUNTIME_BINARY override', () => {
    const previous = process.env.OMB_RUNTIME_BINARY;
    try {
      process.env.OMB_RUNTIME_BINARY = '/custom/runtime';
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omb-runtime',
        exists: () => false,
      });
      assert.equal(actual, '/custom/runtime');
    } finally {
      if (typeof previous === 'string') process.env.OMB_RUNTIME_BINARY = previous;
      else delete process.env.OMB_RUNTIME_BINARY;
    }
  });

  it('prefers debug build over release and PATH fallback', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omb-runtime',
      exists: (candidate) => candidate === '/debug/runtime' || candidate === '/release/runtime',
    });
    assert.equal(actual, '/debug/runtime');
  });

  it('falls back to release build when debug is unavailable', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omb-runtime',
      exists: (candidate) => candidate === '/release/runtime',
    });
    assert.equal(actual, '/release/runtime');
  });

  it('falls back to PATH binary when local builds are unavailable', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omb-runtime',
      exists: () => false,
    });
    assert.equal(actual, 'omb-runtime');
  });
});

describe('RuntimeBridge schema validation', () => {
  it('accepts mailbox commands after normalizing schema naming differences', () => {
    const bridge = new RuntimeBridge({ binaryPath: '/ignored' });
    const runCalls: string[][] = [];
    (bridge as unknown as { run: (args: string[]) => string }).run = (args: string[]) => {
      runCalls.push(args);
      if (args[0] === 'schema') {
        return JSON.stringify({
          schema_version: 1,
          commands: [
            'acquire-authority',
            'renew-authority',
            'queue-dispatch',
            'mark-notified',
            'mark-delivered',
            'mark-failed',
            'request-replay',
            'capture-snapshot',
            'create_mailbox_message',
            'mark-mailbox-notified',
            'mark_mailbox_delivered',
          ],
          events: [],
          transport: 'tmux',
        });
      }
      if (args[0] === 'exec') {
        return JSON.stringify({
          event: 'MailboxMessageCreated',
          message_id: 'msg-1',
          from_worker: 'worker-1',
          to_worker: 'worker-2',
        });
      }
      throw new Error(`Unexpected runtime bridge call: ${args.join(' ')}`);
    };

    const event = bridge.execCommand({
      command: 'CreateMailboxMessage',
      message_id: 'msg-1',
      from_worker: 'worker-1',
      to_worker: 'worker-2',
      body: 'hello',
    });

    assert.equal(event.event, 'MailboxMessageCreated');
    assert.deepEqual(runCalls.map((args) => args[0]), ['schema', 'exec']);
  });

  it('throws when the runtime schema omits mailbox commands', () => {
    const bridge = new RuntimeBridge({ binaryPath: '/ignored' });
    (bridge as unknown as { run: (args: string[]) => string }).run = (args: string[]) => {
      if (args[0] === 'schema') {
        return JSON.stringify({
          schema_version: 1,
          commands: [
            'acquire-authority',
            'renew-authority',
            'queue-dispatch',
            'mark-notified',
            'mark-delivered',
            'mark-failed',
            'request-replay',
            'capture-snapshot',
          ],
          events: [],
          transport: 'tmux',
        });
      }
      throw new Error(`Unexpected runtime bridge call: ${args.join(' ')}`);
    };

    assert.throws(
      () => bridge.execCommand({
        command: 'CreateMailboxMessage',
        message_id: 'msg-1',
        from_worker: 'worker-1',
        to_worker: 'worker-2',
        body: 'hello',
      }),
      /create-mailbox-message, mark-mailbox-notified, mark-mailbox-delivered/,
    );
  });
});
