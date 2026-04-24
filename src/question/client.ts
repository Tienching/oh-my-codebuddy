import { spawn } from 'node:child_process';
import { resolveOmbCliEntryPath } from '../utils/paths.js';
import type { QuestionAnswer, QuestionInput } from './types.js';

export interface OmbQuestionSuccessPayload {
  ok: true;
  question_id: string;
  session_id?: string;
  prompt: QuestionInput;
  answer: QuestionAnswer;
}

export interface OmbQuestionErrorPayload {
  ok: false;
  question_id?: string;
  session_id?: string;
  error: {
    code: string;
    message: string;
  };
}

export type OmbQuestionPayload = OmbQuestionSuccessPayload | OmbQuestionErrorPayload;

export interface OmbQuestionClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv1?: string | null;
  runner?: OmbQuestionProcessRunner;
}

export interface OmbQuestionProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type OmbQuestionProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<OmbQuestionProcessResult>;

export class OmbQuestionError extends Error {
  readonly code: string;
  readonly payload?: OmbQuestionErrorPayload;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(
    code: string,
    message: string,
    options: {
      payload?: OmbQuestionErrorPayload;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'OmbQuestionError';
    this.code = code;
    this.payload = options.payload;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.exitCode = options.exitCode ?? null;
  }
}

export async function defaultOmbQuestionProcessRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<OmbQuestionProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseQuestionStdout(stdout: string, stderr: string, exitCode: number | null): OmbQuestionPayload {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new OmbQuestionError('question_no_stdout', 'omb question did not emit a JSON response on stdout.', {
      stdout,
      stderr,
      exitCode,
    });
  }

  try {
    return JSON.parse(trimmed) as OmbQuestionPayload;
  } catch (error) {
    throw new OmbQuestionError(
      'question_invalid_stdout',
      `omb question emitted invalid JSON on stdout: ${(error as Error).message}`,
      { stdout, stderr, exitCode },
    );
  }
}

export async function runOmbQuestion(
  input: Partial<QuestionInput> & { question: string },
  options: OmbQuestionClientOptions = {},
): Promise<OmbQuestionSuccessPayload> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const ombBin = resolveOmbCliEntryPath({ argv1: options.argv1, cwd, env });
  if (!ombBin) {
    throw new OmbQuestionError('question_cli_not_found', 'Could not resolve the omb CLI entrypoint for blocking question execution.');
  }

  const runner = options.runner ?? defaultOmbQuestionProcessRunner;
  const result = await runner(
    process.execPath,
    [ombBin, 'question', '--json', '--input', JSON.stringify(input)],
    { cwd, env },
  );
  const payload = parseQuestionStdout(result.stdout, result.stderr, result.code);

  if (!payload.ok) {
    throw new OmbQuestionError(payload.error.code, payload.error.message, {
      payload,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    });
  }

  if (result.code !== 0) {
    throw new OmbQuestionError(
      'question_nonzero_exit',
      `omb question returned an answer but exited with code ${result.code}.`,
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.code },
    );
  }

  return payload;
}
