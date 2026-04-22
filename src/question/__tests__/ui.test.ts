import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestionRecord, markQuestionPrompting, readQuestionRecord } from '../state.js';
import { formatQuestionAnswerForInjection } from '../renderer.js';
import {
  applyInteractiveSelectionKey,
  createInitialInteractiveSelectionState,
  promptForSelectionsWithArrows,
  renderInteractiveQuestionFrame,
  runQuestionUi,
} from '../ui.js';
import type { QuestionRecord } from '../types.js';

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  rawMode = false;

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }

  resume(): void {}
  pause(): void {}
}

class FakeTtyOutput {
  isTTY = true;
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

function makeRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    kind: 'omx.question/v1',
    question_id: 'question-1',
    created_at: '2026-04-19T00:00:00.000Z',
    updated_at: '2026-04-19T00:00:00.000Z',
    status: 'prompting',
    question: 'Pick one',
    options: [
      { label: 'Alpha', value: 'alpha' },
      { label: 'Beta', value: 'beta' },
    ],
    allow_other: true,
    other_label: 'Other',
    multi_select: false,
    type: 'single-answerable',
    ...overrides,
  };
}

describe('question ui injection metadata', () => {
  it('persists return-target metadata for answered questions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-'));
    try {
      const { recordPath } = await createQuestionRecord(cwd, {
        question: 'Pick one',
        options: [{ label: 'A', value: 'a' }],
        allow_other: true,
        other_label: 'Other',
        multi_select: false,
        type: 'single-answerable',
      }, 'sess-ui');

      await markQuestionPrompting(recordPath, {
        renderer: 'tmux-pane',
        target: '%42',
        launched_at: '2026-04-19T00:00:00.000Z',
        return_target: '%11',
        return_transport: 'tmux-send-keys',
      });

      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.renderer?.return_target, '%11');
      assert.equal(loaded?.renderer?.return_transport, 'tmux-send-keys');
      assert.equal(
        formatQuestionAnswerForInjection({
          kind: 'other',
          value: 'hello can you hear me',
          selected_labels: ['Other'],
          selected_values: ['hello can you hear me'],
          other_text: 'hello can you hear me',
        }),
        '[omx question answered] hello can you hear me',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('question ui arrow navigation', () => {
  it('moves single-select cursor with up/down arrows and submits current selection on Enter', () => {
    const record = makeRecord();
    let state = createInitialInteractiveSelectionState();

    state = applyInteractiveSelectionKey(record, state, { name: 'down' }).state;
    assert.equal(state.cursorIndex, 1);

    state = applyInteractiveSelectionKey(record, state, { name: 'down' }).state;
    assert.equal(state.cursorIndex, 2);

    state = applyInteractiveSelectionKey(record, state, { name: 'up' }).state;
    assert.equal(state.cursorIndex, 1);

    const submit = applyInteractiveSelectionKey(record, state, { name: 'enter' });
    assert.equal(submit.submit, true);
    assert.equal(submit.state.cursorIndex, 1);
  });

  it('toggles multi-select choices with Space and requires a choice before Enter', () => {
    const record = makeRecord({ multi_select: true, type: 'multi-answerable', allow_other: false });
    let state = createInitialInteractiveSelectionState();

    let update = applyInteractiveSelectionKey(record, state, { name: 'enter' });
    assert.equal(update.submit, false);
    assert.match(update.state.error ?? '', /Select one or more options/);

    state = update.state;
    state = applyInteractiveSelectionKey(record, state, { name: 'space' }).state;
    assert.deepEqual(state.selectedIndices, [0]);

    state = applyInteractiveSelectionKey(record, state, { name: 'down' }).state;
    state = applyInteractiveSelectionKey(record, state, { name: 'space' }).state;
    assert.deepEqual(state.selectedIndices, [0, 1]);

    update = applyInteractiveSelectionKey(record, state, { name: 'enter' });
    assert.equal(update.submit, true);
    assert.deepEqual(update.state.selectedIndices, [0, 1]);
  });

  it('renders navigation instructions with checkbox markers', () => {
    const frame = renderInteractiveQuestionFrame(
      makeRecord({ multi_select: true, type: 'multi-answerable' }),
      {
        cursorIndex: 1,
        selectedIndices: [0],
      },
    );

    assert.match(frame, /Use ↑\/↓ to move, Space to toggle, Enter to submit\./);
    assert.match(frame, /\[x\] 1\. Alpha/);
    assert.match(frame, /› \[ \] 2\. Beta/);
  });

  it('collects arrow-based selection in interactive mode', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const promise = promptForSelectionsWithArrows(makeRecord(), { input, output });

    queueMicrotask(() => {
      input.emit('keypress', '', { name: 'down' });
      input.emit('keypress', '', { name: 'enter' });
    });

    const selections = await promise;
    assert.deepEqual(selections, [2]);
    assert.equal(input.rawMode, false);
    assert.match(output.toString(), /Use ↑\/↓ to move, Enter to select\./);
  });

  it('writes answered state from arrow-key interaction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-run-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        {
          question: 'Pick one',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          allow_other: false,
          other_label: 'Other',
          multi_select: false,
          type: 'single-answerable',
        },
        'sess-ui-run',
      );

      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, { input, output });

      setTimeout(() => {
        input.emit('keypress', '', { name: 'down' });
        input.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.status, 'answered');
      assert.equal(loaded?.answer?.kind, 'option');
      assert.equal(loaded?.answer?.value, 'b');
      assert.equal(loaded?.type, 'single-answerable');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
