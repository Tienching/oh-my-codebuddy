/**
 * LSP Client Implementation
 *
 * Manages connections to language servers using JSON-RPC 2.0 over stdio.
 * Handles server lifecycle, message buffering, and request/response matching.
 *
 */

import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, parse, join } from 'path';
import { pathToFileURL } from 'url';
import type {
  Range,
  Location,
  Hover,
  Diagnostic,
  DocumentSymbol,
  SymbolInformation,
  WorkspaceEdit,
  CodeAction,
  LspServerConfig,
} from './types.js';
import { getServerForFile, commandExists } from './servers.js';

/** Default timeout (ms) for LSP requests */
const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 15_000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const env = process.env[name];
  if (!env) return fallback;
  const parsed = parseInt(env, 10);
  return !isNaN(parsed) && parsed > 0 ? parsed : fallback;
}

function getLspRequestTimeout(
  serverConfig: Pick<LspServerConfig, 'initializeTimeoutMs'>,
  method: string,
  baseTimeout = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
): number {
  if (method === 'initialize' && serverConfig.initializeTimeoutMs) {
    return Math.max(baseTimeout, serverConfig.initializeTimeoutMs);
  }
  return baseTimeout;
}

/** Convert a file path to a valid file:// URI (cross-platform) */
function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

// JSON-RPC Types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export class LspClient {
  private static readonly MAX_BUFFER_SIZE = 50 * 1024 * 1024;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private buffer = Buffer.alloc(0);
  private openDocuments = new Set<string>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private workspaceRoot: string;
  private serverConfig: LspServerConfig;
  private _serverCapabilities: Record<string, unknown> | null = null;
  private _supportsPullDiagnostics = false;

  constructor(workspaceRoot: string, serverConfig: LspServerConfig) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.serverConfig = serverConfig;
  }

  async connect(): Promise<void> {
    if (this.process) return;

    if (!commandExists(this.serverConfig.command)) {
      throw new Error(
        `Language server '${this.serverConfig.command}' not found.\nInstall with: ${this.serverConfig.installHint}`,
      );
    }

    return new Promise((resolve, reject) => {
      const shell = process.platform === 'win32';
      this.process = spawn(this.serverConfig.command, this.serverConfig.args, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[LSP ${this.serverConfig.name}] stderr: ${data.toString().slice(0, 500)}`);
      });

      this.process.on('error', (error) => {
        reject(new Error(`Failed to start LSP server: ${error.message}`));
      });

      this.process.on('exit', (code) => {
        this.process = null;
        if (code !== 0) {
          console.error(`[LSP ${this.serverConfig.name}] exited with code ${code}`);
        }
        this.rejectPendingRequests(new Error(`LSP server exited (code ${code})`));
      });

      this.initialize()
        .then(() => {
          resolve();
        })
        .catch(reject);
    });
  }

  forceKill(): void {
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Ignore
      }
      this.process = null;
      for (const waiters of this.diagnosticWaiters.values()) {
        for (const wake of waiters) wake();
      }
      this.diagnosticWaiters.clear();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.process) return;

    try {
      await this.request('shutdown', null, 3000);
      this.notify('exit', null);
    } catch {
      // Ignore
    } finally {
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      this.rejectPendingRequests(new Error('Client disconnected'));
      this.openDocuments.clear();
      this.diagnostics.clear();
      for (const waiters of this.diagnosticWaiters.values()) {
        for (const wake of waiters) wake();
      }
      this.diagnosticWaiters.clear();
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    if (this.buffer.length > LspClient.MAX_BUFFER_SIZE) {
      console.error('[LSP] Response buffer exceeded 50MB limit, resetting');
      this.buffer = Buffer.alloc(0);
      this.rejectPendingRequests(new Error('LSP response buffer overflow'));
      return;
    }

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString();
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break;

      const messageJson = this.buffer.subarray(messageStart, messageEnd).toString();
      this.buffer = this.buffer.subarray(messageEnd);

      try {
        const message = JSON.parse(messageJson);
        this.handleMessage(message);
      } catch {
        // Invalid JSON, skip
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ('method' in message) {
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'textDocument/publishDiagnostics') {
      const params = notification.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics);
      const waiters = this.diagnosticWaiters.get(params.uri);
      if (waiters?.length) {
        this.diagnosticWaiters.delete(params.uri);
        for (const wake of waiters) wake();
      }
    }
  }

  private async request<T>(method: string, params: unknown, timeout?: number): Promise<T> {
    if (!this.process?.stdin) {
      throw new Error('LSP server not connected');
    }

    const effectiveTimeout = timeout ?? getLspRequestTimeout(this.serverConfig, method);

    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    const content = JSON.stringify(request);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutHandle,
      });

      this.process?.stdin?.write(message);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    const content = JSON.stringify(notification);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
    this.process.stdin.write(message);
  }

  private async initialize(): Promise<void> {
    const initResult = await this.request<{ capabilities?: Record<string, unknown> }>('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.workspaceRoot).href,
      rootPath: this.workspaceRoot,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
          rename: { prepareSupport: true },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
        },
        workspace: { symbol: {}, workspaceFolders: true },
      },
      initializationOptions: this.serverConfig.initializationOptions || {},
    }, getLspRequestTimeout(this.serverConfig, 'initialize'));

    this._serverCapabilities = initResult?.capabilities ?? null;
    this._supportsPullDiagnostics = !!this._serverCapabilities?.diagnosticProvider;
    this.notify('initialized', {});
  }

  private getLanguageId(filePath: string): string {
    const ext = parse(filePath).ext.slice(1).toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
      mts: 'typescript', cts: 'typescript', mjs: 'javascript', cjs: 'javascript',
      py: 'python', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
      hpp: 'cpp', java: 'java', json: 'json', html: 'html', css: 'css', scss: 'scss',
      yaml: 'yaml', yml: 'yaml', php: 'php', phtml: 'php', rb: 'ruby', rake: 'ruby',
      gemspec: 'ruby', erb: 'ruby', lua: 'lua', kt: 'kotlin', kts: 'kotlin',
      ex: 'elixir', exs: 'elixir', heex: 'elixir', eex: 'elixir', cs: 'csharp',
    };
    return langMap[ext] || ext;
  }

  private async prepareDocument(filePath: string): Promise<string> {
    await this.openDocument(filePath);
    return fileUri(filePath);
  }

  async openDocument(filePath: string): Promise<void> {
    const uri = fileUri(filePath);
    if (this.openDocuments.has(uri)) return;
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const content = readFileSync(filePath, 'utf-8');
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this.getLanguageId(filePath), version: 1, text: content },
    });
    this.openDocuments.add(uri);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  closeDocument(filePath: string): void {
    const uri = fileUri(filePath);
    if (!this.openDocuments.has(uri)) return;
    this.notify('textDocument/didClose', { textDocument: { uri } });
    this.openDocuments.delete(uri);
  }

  // LSP Request Methods

  async hover(filePath: string, line: number, character: number): Promise<Hover | null> {
    const uri = await this.prepareDocument(filePath);
    return (await this.request<Hover | null>('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    })) ?? null;
  }

  async definition(filePath: string, line: number, character: number): Promise<Location | Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    return (await this.request<Location | Location[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    })) ?? null;
  }

  async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    return (await this.request<Location[] | null>('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    })) ?? null;
  }

  async documentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const uri = await this.prepareDocument(filePath);
    return (await this.request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', {
      textDocument: { uri },
    })) ?? null;
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[] | null> {
    return (await this.request<SymbolInformation[] | null>('workspace/symbol', { query })) ?? null;
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    return this.diagnostics.get(fileUri(filePath)) || [];
  }

  get supportsPullDiagnostics(): boolean {
    return this._supportsPullDiagnostics;
  }

  async pullDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const uri = fileUri(filePath);
    const result = await this.request<{ items?: Diagnostic[] }>('textDocument/diagnostic', {
      textDocument: { uri },
    });
    return result?.items || [];
  }

  waitForDiagnostics(filePath: string, timeoutMs = 2000): Promise<void> {
    const uri = fileUri(filePath);
    if (this.diagnostics.has(uri)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.diagnosticWaiters.delete(uri);
          resolve();
        }
      }, timeoutMs);

      const existing = this.diagnosticWaiters.get(uri) || [];
      existing.push(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      });
      this.diagnosticWaiters.set(uri, existing);
    });
  }

  async prepareRename(filePath: string, line: number, character: number): Promise<Range | null> {
    const uri = await this.prepareDocument(filePath);
    try {
      const result = await this.request<Range | { range: Range; placeholder: string } | null>(
        'textDocument/prepareRename',
        { textDocument: { uri }, position: { line, character } },
      );
      if (!result) return null;
      return 'range' in result ? result.range : result;
    } catch {
      return null;
    }
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
    const uri = await this.prepareDocument(filePath);
    return (await this.request<WorkspaceEdit | null>('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName,
    })) ?? null;
  }

  async codeActions(filePath: string, range: Range, diagnostics: Diagnostic[] = []): Promise<CodeAction[] | null> {
    const uri = await this.prepareDocument(filePath);
    return (await this.request<CodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context: { diagnostics },
    })) ?? null;
  }
}

// ── Idle timeout constants ────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = readPositiveIntEnv('OMB_LSP_IDLE_TIMEOUT_MS', 5 * 60 * 1000);
const IDLE_CHECK_INTERVAL_MS = readPositiveIntEnv('OMB_LSP_IDLE_CHECK_INTERVAL_MS', 60 * 1000);

/**
 * Client manager — maintains a pool of LSP clients per workspace/server
 * with idle eviction and in-flight request protection.
 */
export class LspClientManager {
  private clients = new Map<string, LspClient>();
  private lastUsed = new Map<string, number>();
  private inFlightCount = new Map<string, number>();
  private idleDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startIdleCheck();
    this.registerCleanupHandlers();
  }

  private registerCleanupHandlers(): void {
    const forceKillAll = () => {
      if (this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
      for (const timer of this.idleDeadlines.values()) {
        clearTimeout(timer);
      }
      this.idleDeadlines.clear();
      for (const client of this.clients.values()) {
        try { client.forceKill(); } catch { /* noop */ }
      }
      this.clients.clear();
      this.lastUsed.clear();
      this.inFlightCount.clear();
    };

    process.on('exit', forceKillAll);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(sig, forceKillAll);
    }
  }

  private findWorkspaceRoot(filePath: string): string {
    let dir = dirname(resolve(filePath));
    const markers = [
      'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
      'pom.xml', 'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
      'go.mod', '.git',
    ];

    while (true) {
      const parsed = parse(dir);
      if (parsed.root === dir) break;
      for (const marker of markers) {
        if (existsSync(join(dir, marker))) return dir;
      }
      dir = dirname(dir);
    }
    return dirname(resolve(filePath));
  }

  async getClientForFile(filePath: string): Promise<LspClient | null> {
    const serverConfig = getServerForFile(filePath);
    if (!serverConfig) return null;

    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const key = `${workspaceRoot}:${serverConfig.command}`;

    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(workspaceRoot, serverConfig);
      try {
        await client.connect();
        this.clients.set(key, client);
      } catch (error) {
        throw error;
      }
    }

    this.touchClient(key);
    return client;
  }

  async runWithClientLease<T>(filePath: string, fn: (client: LspClient) => Promise<T>): Promise<T> {
    const client = await this.getClientForFile(filePath);
    if (!client) throw new Error(`No language server available for: ${filePath}`);

    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const serverConfig = getServerForFile(filePath)!;
    const key = `${workspaceRoot}:${serverConfig.command}`;

    this.touchClient(key);
    this.inFlightCount.set(key, (this.inFlightCount.get(key) || 0) + 1);

    try {
      return await fn(client);
    } finally {
      const count = (this.inFlightCount.get(key) || 1) - 1;
      if (count <= 0) {
        this.inFlightCount.delete(key);
      } else {
        this.inFlightCount.set(key, count);
      }
      this.touchClient(key);
    }
  }

  private touchClient(key: string): void {
    this.lastUsed.set(key, Date.now());
    this.scheduleIdleDeadline(key);
  }

  private scheduleIdleDeadline(key: string): void {
    this.clearIdleDeadline(key);
    const timer = setTimeout(() => {
      this.idleDeadlines.delete(key);
      this.evictClientIfIdle(key);
    }, IDLE_TIMEOUT_MS);
    if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.idleDeadlines.set(key, timer);
  }

  private clearIdleDeadline(key: string): void {
    const timer = this.idleDeadlines.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleDeadlines.delete(key);
    }
  }

  private startIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.evictIdleClients(), IDLE_CHECK_INTERVAL_MS);
    if (this.idleTimer && typeof this.idleTimer === 'object' && 'unref' in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  private evictIdleClients(): void {
    for (const key of this.lastUsed.keys()) {
      this.evictClientIfIdle(key);
    }
  }

  private evictClientIfIdle(key: string): void {
    const lastUsedTime = this.lastUsed.get(key);
    if (lastUsedTime === undefined) {
      this.clearIdleDeadline(key);
      return;
    }

    const idleFor = Date.now() - lastUsedTime;
    if (idleFor <= IDLE_TIMEOUT_MS) {
      if (!this.idleDeadlines.has(key)) this.scheduleIdleDeadline(key);
      return;
    }

    if ((this.inFlightCount.get(key) || 0) > 0) {
      this.scheduleIdleDeadline(key);
      return;
    }

    const client = this.clients.get(key);
    this.clearIdleDeadline(key);
    this.clients.delete(key);
    this.lastUsed.delete(key);
    this.inFlightCount.delete(key);

    if (client) client.disconnect().catch(() => {/* noop */});
  }

  async disconnectAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const timer of this.idleDeadlines.values()) clearTimeout(timer);
    this.idleDeadlines.clear();

    const entries = Array.from(this.clients.entries());
    const results = await Promise.allSettled(entries.map(([, c]) => c.disconnect()));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.warn(`LSP disconnectAll: failed for "${entries[i][0]}": ${r.reason}`);
      }
    }
    this.clients.clear();
    this.lastUsed.clear();
    this.inFlightCount.clear();
  }

  get clientCount(): number { return this.clients.size; }
  getInFlightCount(key: string): number { return this.inFlightCount.get(key) || 0; }
}

// Process-global singleton
const GLOBAL_KEY = '__ombLspClientManager';
const gw = globalThis as typeof globalThis & { [GLOBAL_KEY]?: LspClientManager };
export const lspClientManager = gw[GLOBAL_KEY] ?? (gw[GLOBAL_KEY] = new LspClientManager());

export async function disconnectAll(): Promise<void> {
  return lspClientManager.disconnectAll();
}
