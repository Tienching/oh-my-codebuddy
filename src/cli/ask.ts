import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { constants as osConstants, homedir } from 'os';
import { getPackageRoot } from '../utils/package.js';
import { codebuddyPromptsDir } from '../utils/paths.js';
import { formatCliText } from './brand.js';

export function getAskUsage(): string {
  return formatCliText([
    'Usage: {cmd} ask <claude|gemini> <question or task>',
    '   or: {cmd} ask <claude|gemini> -p "<prompt>"',
    '   or: {cmd} ask claude --print "<prompt>"',
    '   or: {cmd} ask gemini --prompt "<prompt>"',
    '   or: {cmd} ask <claude|gemini> --agent-prompt <role> "<prompt>"',
    '   or: {cmd} ask <claude|gemini> --agent-prompt=<role> --prompt "<prompt>"',
  ].join('\n'));
}

const ASK_PROVIDERS = ['claude', 'gemini'] as const;
type AskProvider = typeof ASK_PROVIDERS[number];
const ASK_PROVIDER_SET = new Set<string>(ASK_PROVIDERS);
const ASK_ADVISOR_SCRIPT_ENV = 'OMB_ASK_ADVISOR_SCRIPT';
const ASK_AGENT_PROMPT_FLAG = '--agent-prompt';
const ASK_ORIGINAL_TASK_ENV = 'OMB_ASK_ORIGINAL_TASK';
const SAFE_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;
const ASK_SETUP_PROVIDERS = new Set(['codebuddy', 'codex', 'both'] as const);
type AskSetupProvider = 'codebuddy' | 'codex' | 'both';
type AskSetupScope = 'user' | 'project';

function resolveCodeBuddyPromptsDir(env: NodeJS.ProcessEnv): string {
  const override = env.CODEBUDDY_HOME?.trim();
  return override ? join(override, 'prompts') : codebuddyPromptsDir();
}

function resolveCodexPromptsDir(env: NodeJS.ProcessEnv): string {
  const override = env.CODEX_HOME?.trim();
  if (override) {
    return join(override, 'prompts');
  }
  return join(homedir(), '.codex', 'prompts');
}

function normalizeAskSetupScope(rawScope: unknown): AskSetupScope | undefined {
  if (typeof rawScope !== 'string') return undefined;
  const scope = rawScope.trim().toLowerCase();
  if (scope === 'project-local') return 'project';
  if (scope === 'user' || scope === 'project') return scope;
  return undefined;
}

function resolveAskSetupContext(
  cwd: string,
): { scope: AskSetupScope; provider: AskSetupProvider } {
  const scopePath = join(cwd, '.omb', 'setup-scope.json');
  if (existsSync(scopePath)) {
    try {
      const parsed = JSON.parse(readFileSync(scopePath, 'utf-8')) as Partial<{
        scope: string;
        provider: string;
      }>;
      const rawProvider = parsed.provider;
      const provider = rawProvider?.trim().toLowerCase();
      const scope = normalizeAskSetupScope(parsed.scope);
      if (provider && ASK_SETUP_PROVIDERS.has(provider as AskSetupProvider)) {
        return {
          provider: provider as AskSetupProvider,
          scope: scope ?? 'user',
        };
      }
      // Unknown provider value: warn rather than silently collapsing to
      // CodeBuddy so a hand-edited or upgraded scope file is visible.
      if (rawProvider !== undefined && rawProvider !== null) {
        process.stderr.write(
          `[omb] warning: ignoring unknown provider "${String(rawProvider)}" in ${scopePath}; falling back to codebuddy. Run \`omb setup\` to repair.\n`,
        );
      }
    } catch {
      // Malformed JSON: still fall back, but surface the reason.
      process.stderr.write(
        `[omb] warning: could not parse ${scopePath}; falling back to codebuddy provider. Run \`omb setup\` to repair.\n`,
      );
    }
  }

  return {
    provider: 'codebuddy',
    scope: 'user',
  };
}

function resolveAskPromptDirs(
  cwd: string,
  env: NodeJS.ProcessEnv,
  provider: AskSetupProvider,
  scope: AskSetupScope,
): string[] {
  const dirs: string[] = [];
  const codebuddyHomePrompts = resolveCodeBuddyPromptsDir(env);
  const codexHomePrompts = resolveCodexPromptsDir(env);

  if (scope === 'project') {
    if (provider === 'both' || provider === 'codebuddy') {
      dirs.push(join(cwd, '.codebuddy', 'prompts'));
    }
    if (provider === 'both' || provider === 'codex') {
      dirs.push(join(cwd, '.codex', 'prompts'));
    }
  }

  if (provider === 'both' || provider === 'codebuddy') {
    dirs.push(codebuddyHomePrompts);
  }
  if (provider === 'both' || provider === 'codex') {
    dirs.push(codexHomePrompts);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    deduped.push(dir);
  }

  return deduped.filter((dir) => existsSync(dir));
}

export interface ParsedAskArgs {
  provider: AskProvider;
  prompt: string;
  agentPromptRole?: string;
}

function askUsageError(reason: string): Error {
  return new Error(`${reason}\n${getAskUsage()}`);
}

async function resolveAgentPromptContent(
  role: string,
  promptsDirs: string[],
): Promise<string> {
  const normalizedRole = role.trim().toLowerCase();
  if (!SAFE_ROLE_PATTERN.test(normalizedRole)) {
    throw new Error(`[ask] invalid --agent-prompt role "${role}". Expected lowercase role names like "executor" or "test-engineer".`);
  }

  if (promptsDirs.length === 0) {
    throw new Error(`[ask] prompts directory not found. Run "${formatCliText('{cmd} setup')}" to install prompts.`);
  }

  const availableRoles = new Set<string>();
  const checkedDirs: string[] = [];
  let lastMissingErrorSuffix = '';

  for (const promptsDir of promptsDirs) {
    checkedDirs.push(promptsDir);
    const promptPath = join(promptsDir, `${normalizedRole}.md`);
    if (!existsSync(promptPath)) {
      const files = await readdir(promptsDir).catch(() => [] as string[]);
      for (const file of files.filter((candidate) => candidate.endsWith('.md'))) {
        availableRoles.add(file.slice(0, -3));
      }
      lastMissingErrorSuffix = ` (searched ${checkedDirs.join(', ')})`;
      continue;
    }

    const content = (await readFile(promptPath, 'utf-8')).trim();
    if (!content) {
      throw new Error(`[ask] --agent-prompt role "${normalizedRole}" is empty: ${promptPath}`);
    }
    return content;
  }

  const availableSuffix = availableRoles.size > 0
    ? ` Available roles: ${Array.from(availableRoles).sort().join(', ')}.`
    : '';
  throw new Error(
    `[ask] --agent-prompt role "${normalizedRole}" not found.${lastMissingErrorSuffix}${availableSuffix}`,
  );
}

export function parseAskArgs(args: readonly string[]): ParsedAskArgs {
  const [providerRaw, ...rest] = args;
  const provider = (providerRaw || '').toLowerCase();

  if (!provider || !ASK_PROVIDER_SET.has(provider)) {
    throw askUsageError(`Invalid provider "${providerRaw || ''}". Expected one of: ${ASK_PROVIDERS.join(', ')}.`);
  }

  if (rest.length === 0) {
    throw askUsageError('Missing prompt text.');
  }

  let agentPromptRole: string | undefined;
  let prompt = '';

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === ASK_AGENT_PROMPT_FLAG) {
      const role = rest[i + 1]?.trim();
      if (!role || role.startsWith('-')) {
        throw askUsageError('Missing role after --agent-prompt.');
      }
      agentPromptRole = role;
      i += 1;
      continue;
    }
    if (token.startsWith(`${ASK_AGENT_PROMPT_FLAG}=`)) {
      const role = token.slice(`${ASK_AGENT_PROMPT_FLAG}=`.length).trim();
      if (!role) {
        throw askUsageError('Missing role after --agent-prompt=');
      }
      agentPromptRole = role;
      continue;
    }
    if (token === '-p' || token === '--print' || token === '--prompt') {
      prompt = rest.slice(i + 1).join(' ').trim();
      break;
    }
    if (token.startsWith('-p=') || token.startsWith('--print=') || token.startsWith('--prompt=')) {
      const inlinePrompt = token.split('=').slice(1).join('=').trim();
      const remainder = rest.slice(i + 1).join(' ').trim();
      prompt = [inlinePrompt, remainder].filter(Boolean).join(' ').trim();
      break;
    }
    prompt = [prompt, token].filter(Boolean).join(' ').trim();
  }

  if (!prompt) {
    throw askUsageError('Missing prompt text.');
  }

  return {
    provider: provider as AskProvider,
    prompt,
    ...(agentPromptRole ? { agentPromptRole } : {}),
  };
}

export function resolveAskAdvisorScriptPath(
  packageRoot = getPackageRoot(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[ASK_ADVISOR_SCRIPT_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : join(packageRoot, override);
  }
  return join(packageRoot, 'dist', 'scripts', 'run-provider-advisor.js');
}

function resolveSignalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === 'number' && Number.isFinite(signalNumber)) {
    return 128 + signalNumber;
  }
  return 1;
}

export async function askCommand(args: string[]): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(getAskUsage());
    return;
  }

  const parsed = parseAskArgs(args);
  const packageRoot = getPackageRoot();
  const advisorScriptPath = resolveAskAdvisorScriptPath(packageRoot);
  const askSetupContext = resolveAskSetupContext(process.cwd());
  const promptsDirs = resolveAskPromptDirs(
    process.cwd(),
    process.env,
    askSetupContext.provider,
    askSetupContext.scope,
  );

  if (!existsSync(advisorScriptPath)) {
    throw new Error(`[ask] advisor script not found: ${advisorScriptPath}`);
  }

  let finalPrompt = parsed.prompt;
  if (parsed.agentPromptRole) {
    const agentPromptContent = await resolveAgentPromptContent(
      parsed.agentPromptRole,
      promptsDirs,
    );
    finalPrompt = `${agentPromptContent}\n\n${parsed.prompt}`;
  }

  const child = spawnSync(
    process.execPath,
    [advisorScriptPath, parsed.provider, finalPrompt],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [ASK_ORIGINAL_TASK_ENV]: parsed.prompt,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (child.stdout && child.stdout.length > 0) {
    process.stdout.write(child.stdout);
  }
  if (child.stderr && child.stderr.length > 0) {
    process.stderr.write(child.stderr);
  }

  if (child.error) {
    throw new Error(`[ask] failed to launch advisor script: ${child.error.message}`);
  }

  const status = typeof child.status === 'number'
    ? child.status
    : resolveSignalExitCode(child.signal);

  if (status !== 0) {
    process.exitCode = status;
  }
}
