import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatQuestionAnswerForInjection,
  injectQuestionAnswerToPane,
  launchQuestionRenderer,
  resolveQuestionRendererStrategy,
} from '../renderer.js';
import { buildSendPaneArgvs } from '../../notifications/tmux-detector.js';

describe('resolveQuestionRendererStrategy', () => {
  it('prefers inside-tmux when TMUX is present', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
  });

  it('fails closed when tmux exists but TMUX is absent', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'unsupported',
    );
  });

  it('uses noop test renderer override when requested', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_TEST_RENDERER: 'noop' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'test-noop',
    );
  });

  it('fails closed when neither attached tmux nor tmux binary exists', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, undefined),
      'unsupported',
    );
  });
});

describe('launchQuestionRenderer', () => {
  it('fails before building UI argv or invoking tmux when no visible renderer is available', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '';
    try {
      assert.throws(
        () => launchQuestionRenderer(
          {
            cwd: '/repo',
            recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
            env: {} as NodeJS.ProcessEnv,
          },
          {
            strategy: 'unsupported',
            execTmux: (args) => {
              calls.push(args);
              return '';
            },
            sleepSync: () => {},
          },
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /visible renderer/i);
          assert.match(error.message, /attached tmux pane/i);
          assert.match(error.message, /Run omx question from inside tmux/i);
          assert.doesNotMatch(error.message, /tmux is unavailable/i);
          return true;
        },
      );
    } finally {
      process.argv[1] = originalArgv1;
    }

    assert.deepEqual(calls, []);
  });

  it('opens an interactive foreground split when already inside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
        sessionId: 's1',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'split-window') return '%42\n';
          if (args[0] === 'list-panes') return '0\t%42\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%42');
    assert.equal(result.return_target, '%11');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'split-window');
    assert.ok(!calls[0]?.includes('-d'));
    assert.equal(calls[0]?.[calls[0]!.length - 6], process.execPath);
    assert.equal(calls[0]?.[calls[0]!.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(calls[0]?.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-1.json',
    ]);
    assert.ok(calls[0]?.includes('-e'));
    assert.ok(calls[0]?.includes('OMX_SESSION_ID=s1'));
    assert.deepEqual(calls[1], ['list-panes', '-t', '%42', '-F', '#{pane_dead}\t#{pane_id}']);
  });

  it('fails before prompting state when a reported split pane is already gone', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'split-window') return '%42\n';
            throw new Error("can't find pane: %42");
          },
          sleepSync: () => {},
        },
      ),
      /Question UI pane %42 disappeared immediately after launch/,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'split-window');
    assert.equal(calls[0]?.[calls[0]!.length - 6], process.execPath);
    assert.equal(calls[0]?.[calls[0]!.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(calls[0]?.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-1.json',
    ]);
    assert.deepEqual(calls[1], ['list-panes', '-t', '%42', '-F', '#{pane_dead}\t#{pane_id}']);
  });

  it('passes direct tmux argv so non-POSIX default shells do not parse a shell string', () => {
    const calls: string[][] = [];
    launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/question with spaces.json',
        sessionId: 'sess-123',
        env: { TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'split-window') return '%77\n';
          if (args[0] === 'list-panes') return '0\t%77\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.some((part) => /question --ui --state-path/.test(part)), false);
    assert.equal(calls[0]?.some((part) => /^'.*'$/.test(part)), false);
    assert.equal(calls[0]?.[calls[0]!.length - 6], process.execPath);
    assert.equal(calls[0]?.[calls[0]!.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(calls[0]?.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/question with spaces.json',
    ]);
  });

  it('uses detached sessions outside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: {} as NodeJS.ProcessEnv,
      },
      {
        strategy: 'detached-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'has-session') return '';
          return 'omx-question-question-2\n';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-session');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.ok(calls[0]?.includes('-d'));
    assert.equal(calls[0]?.[calls[0]!.length - 6], process.execPath);
    assert.equal(calls[0]?.[calls[0]!.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(calls[0]?.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-2.json',
    ]);
    assert.deepEqual(calls[1], ['has-session', '-t', 'omx-question-question-2']);
  });

  it('fails when a detached tmux session disappears immediately after launch', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {} as NodeJS.ProcessEnv,
        },
        {
          strategy: 'detached-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'new-session') return 'omx-question-question-2\n';
            throw new Error('can\'t find session: omx-question-question-2');
          },
          sleepSync: () => {},
        },
      ),
      /Question UI session omx-question-question-2 disappeared immediately after launch/,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.deepEqual(calls[1], ['has-session', '-t', 'omx-question-question-2']);
  });

  it('prefers the current launcher path over a stale ambient OMX_ENTRY_PATH when spawning the UI', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/dist/cli/omx.js';
    try {
      const result = launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-3.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {
            TMUX: '/tmp/tmux-demo',
            TMUX_PANE: '%11',
            OMX_ENTRY_PATH: '/stale/global/dist/cli/omx.js',
          } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'split-window') return '%42\n';
            if (args[0] === 'list-panes') return '0\t%42\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.target, '%42');
      assert.equal(calls[0]?.includes('/repo/dist/cli/omx.js'), true);
      assert.equal(calls[0]?.includes('/stale/global/dist/cli/omx.js'), false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe('question answer injection', () => {
  it('formats other answers into a single-line continuation-safe prompt', () => {
    assert.equal(
      formatQuestionAnswerForInjection({
        kind: 'other',
        value: 'hello\nworld',
        selected_labels: ['Other'],
        selected_values: ['hello\nworld'],
        other_text: 'hello\nworld',
      }),
      '[omx question answered] hello world',
    );
  });

  it('injects the answered text back into the requester pane and submits with isolated double C-m', () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const ok = injectQuestionAnswerToPane(
      '%11',
      {
        kind: 'option',
        value: 'proceed',
        selected_labels: ['Proceed'],
        selected_values: ['proceed'],
      },
      (args) => {
        calls.push(args);
        return '';
      },
      (ms) => {
        sleeps.push(ms);
      },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, buildSendPaneArgvs('%11', '[omx question answered] proceed', true));
    assert.deepEqual(sleeps, [120, 100]);
    assert.equal(calls.some((argv) => argv.includes('Enter')), false);
  });
});
