/**
 * Project Memory Learner
 *
 * Incrementally learns from PostToolUse events to update project memory.
 * Hooks into the existing memory-server storage format.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { trackAccess } from './hot-path-tracker.js';
import type { ProjectMemory, Directive } from './types.js';

const BUILD_PATTERNS = [
  /npm\s+(?:run\s+)?build/i,
  /pnpm\s+(?:run\s+)?build/i,
  /yarn\s+(?:run\s+)?build/i,
  /make\s+(?:build|all)/i,
  /cargo\s+build/i,
  /go\s+build/i,
  /gradle\s+build/i,
  /mvn\s+(?:package|compile)/i,
  /tsc\s+--build/i,
];

const TEST_PATTERNS = [
  /npm\s+(?:run\s+)?test/i,
  /pnpm\s+(?:run\s+)?test/i,
  /yarn\s+(?:run\s+)?test/i,
  /cargo\s+test/i,
  /go\s+test/i,
  /pytest/i,
  /mvn\s+test/i,
  /jest/i,
  /vitest/i,
  /mocha/i,
];

const RUNTIME_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /Node\.js\s+(v?\d+\.\d+\.\d+)/i, category: 'Node.js' },
  { pattern: /Python\s+(\d+\.\d+\.\d+)/i, category: 'Python' },
  { pattern: /rustc\s+(\d+\.\d+\.\d+)/i, category: 'Rust' },
  { pattern: /go\s+version\s+(\d+\.\d+\.\d+)/i, category: 'Go' },
  { pattern: /openjdk\s+(\d+\.\d+\.\d+)/i, category: 'Java' },
];

function getMemoryPath(projectRoot: string): string {
  return join(projectRoot, '.omb', 'project-memory.json');
}

function ensureOmbDir(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.omb'), { recursive: true });
}

function loadMemory(projectRoot: string): ProjectMemory {
  const memPath = getMemoryPath(projectRoot);
  if (!existsSync(memPath)) {
    return {
      version: 1,
      lastScanned: Date.now(),
      notes: [],
      directives: [],
      hotPaths: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(memPath, 'utf-8')) as ProjectMemory;
    // Ensure arrays exist
    if (!raw.notes) raw.notes = [];
    if (!raw.directives) raw.directives = [];
    if (!raw.hotPaths) raw.hotPaths = [];
    return raw;
  } catch {
    return { version: 1, lastScanned: Date.now(), notes: [], directives: [], hotPaths: [] };
  }
}

function saveMemory(projectRoot: string, memory: ProjectMemory): void {
  ensureOmbDir(projectRoot);
  writeFileSync(getMemoryPath(projectRoot), JSON.stringify(memory, null, 2), 'utf-8');
}

/**
 * Learn from a tool execution and update project memory.
 *
 * @param toolName - Name of the tool executed (Read, Edit, Write, Glob, Grep, Bash)
 * @param toolInput - Input parameters to the tool
 * @param toolOutput - Output from the tool (for Bash commands)
 * @param projectRoot - Project root directory
 * @param userMessage - Optional user message for directive detection
 */
export async function learnFromToolOutput(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  projectRoot: string,
  userMessage?: string,
): Promise<void> {
  const memory = loadMemory(projectRoot);
  let updated = false;

  // Track file accesses from Read/Edit/Write
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    const filePath = (toolInput.file_path as string) || (toolInput.path as string);
    if (filePath) {
      memory.hotPaths = trackAccess(memory.hotPaths || [], filePath, projectRoot, 'file');
      updated = true;
    }
  }

  // Track directory accesses from Glob/Grep
  if (toolName === 'Glob' || toolName === 'Grep') {
    const dirPath = toolInput.path as string;
    if (dirPath) {
      memory.hotPaths = trackAccess(memory.hotPaths || [], dirPath, projectRoot, 'directory');
      updated = true;
    }
  }

  // Detect directives from user messages
  if (userMessage) {
    const detected = detectDirectives(userMessage);
    for (const directive of detected) {
      const existing = memory.directives?.find(d => d.directive === directive.directive);
      if (!existing) {
        memory.directives = memory.directives || [];
        memory.directives.push(directive);
        updated = true;
      }
    }
  }

  // Learn from Bash commands
  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';

    // Detect build commands
    if (isBuildCommand(command) && !memory.build) {
      memory.build = { buildCommand: command, testCommand: null, lintCommand: null, devCommand: null, scripts: {} };
      updated = true;
    }

    // Detect test commands
    if (isTestCommand(command) && memory.build && !memory.build.testCommand) {
      memory.build.testCommand = command;
      updated = true;
    }

    // Extract environment hints
    const hints = extractEnvironmentHints(toolOutput);
    for (const hint of hints) {
      const exists = memory.notes?.some(n => n.category === hint.category && n.content === hint.content);
      if (!exists) {
        memory.notes = memory.notes || [];
        memory.notes.push(hint);
        if (memory.notes.length > 20) memory.notes = memory.notes.slice(-20);
        updated = true;
      }
    }
  }

  if (updated) {
    saveMemory(projectRoot, memory);
  }
}

function isBuildCommand(command: string): boolean {
  return BUILD_PATTERNS.some((p) => p.test(command));
}

function isTestCommand(command: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(command));
}

function extractEnvironmentHints(output: string): Array<{ category: string; content: string; timestamp: number; source: 'learned' }> {
  const hints: Array<{ category: string; content: string; timestamp: number; source: 'learned' }> = [];
  const timestamp = Date.now();

  for (const rp of RUNTIME_PATTERNS) {
    const match = output.match(rp.pattern);
    if (match && match[1]) {
      hints.push({ category: rp.category, content: `${rp.category} ${match[1]}`, timestamp, source: 'learned' });
    }
  }

  // Detect missing modules
  const moduleMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (moduleMatch) {
    hints.push({ category: 'dependency', content: `Missing: ${moduleMatch[1]}`, timestamp, source: 'learned' });
  }

  // Detect env var requirements
  const envMatch = output.match(/(?:Missing|Required)\s+(?:environment\s+)?(?:variable|env):\s*([A-Z_][A-Z0-9_]*)/i);
  if (envMatch) {
    hints.push({ category: 'env', content: `Requires: ${envMatch[1]}`, timestamp, source: 'learned' });
  }

  return hints;
}

function detectDirectives(message: string): Directive[] {
  const directives: Directive[] = [];
  const patterns = [
    { re: /\bcritical\b/i, priority: 'high' as const },
    { re: /\bimportant\b/i, priority: 'high' as const },
    { re: /\bmust\s+(?:be|have|do)/i, priority: 'high' as const },
    { re: /\bshould\s+(?:be|have|do)/i, priority: 'normal' as const },
  ];

  for (const { re, priority } of patterns) {
    if (re.test(message)) {
      directives.push({
        directive: message.trim().slice(0, 200),
        priority,
        timestamp: Date.now(),
      });
    }
  }

  return directives;
}
