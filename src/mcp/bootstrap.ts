import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export type McpServerName = 'state' | 'memory' | 'code_intel' | 'trace' | 'team' | 'lsp' | 'shared_memory';

const SERVER_DISABLE_ENVS: Record<McpServerName, string[]> = {
  state: ['OMX_STATE_SERVER_DISABLE_AUTO_START', 'OMB_STATE_SERVER_DISABLE_AUTO_START'],
  memory: ['OMX_MEMORY_SERVER_DISABLE_AUTO_START', 'OMB_MEMORY_SERVER_DISABLE_AUTO_START'],
  code_intel: ['OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START', 'OMB_CODE_INTEL_SERVER_DISABLE_AUTO_START'],
  trace: ['OMX_TRACE_SERVER_DISABLE_AUTO_START', 'OMB_TRACE_SERVER_DISABLE_AUTO_START'],
  team: ['OMX_TEAM_SERVER_DISABLE_AUTO_START', 'OMB_TEAM_SERVER_DISABLE_AUTO_START'],
  lsp: ['OMX_LSP_SERVER_DISABLE_AUTO_START', 'OMB_LSP_SERVER_DISABLE_AUTO_START'],
  shared_memory: ['OMX_SHARED_MEMORY_SERVER_DISABLE_AUTO_START', 'OMB_SHARED_MEMORY_SERVER_DISABLE_AUTO_START'],
};

const GLOBAL_DISABLE_ENVS = ['OMX_MCP_SERVER_DISABLE_AUTO_START', 'OMB_MCP_SERVER_DISABLE_AUTO_START'];
const LIFECYCLE_DEBUG_ENVS = ['OMX_MCP_TRANSPORT_DEBUG', 'OMB_MCP_TRANSPORT_DEBUG'];

interface StdioLifecycleServer {
  connect(transport: StdioServerTransport): Promise<unknown>;
  close(): Promise<unknown>;
}

export function shouldAutoStartMcpServer(
  server: McpServerName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const globalDisabled = GLOBAL_DISABLE_ENVS.some((name) => env[name] === '1');
  const serverDisabled = SERVER_DISABLE_ENVS[server].some((name) => env[name] === '1');
  return !globalDisabled && !serverDisabled;
}

export function autoStartStdioMcpServer(
  serverName: McpServerName,
  server: StdioLifecycleServer,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!shouldAutoStartMcpServer(serverName, env)) {
    return;
  }

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const lifecycleDebugEnabled = LIFECYCLE_DEBUG_ENVS.some((name) => env[name] === '1');

  const logLifecycle = (message: string, error?: unknown) => {
    if (!lifecycleDebugEnabled) return;
    const detail = error ? ` ${error instanceof Error ? error.message : String(error)}` : '';
    process.stderr.write(`[omb-${serverName}-server] ${message}${detail}\n`);
  };

  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logLifecycle(`transport shutdown: ${reason}`);
    process.stdin.off('end', handleStdinEnd);
    process.stdin.off('close', handleStdinClose);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);

    try {
      await server.close();
    } catch (error) {
      console.error(`[omx-${serverName}-server] shutdown failed`, error);
    }
  };

  const handleStdinEnd = () => {
    void shutdown('stdin_end');
  };
  const handleStdinClose = () => {
    void shutdown('stdin_close');
  };
  const handleSigterm = () => {
    void shutdown('sigterm');
  };
  const handleSigint = () => {
    void shutdown('sigint');
  };

  process.stdin.once('end', handleStdinEnd);
  process.stdin.once('close', handleStdinClose);
  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);

  // Funnel transport/client disconnects through the same idempotent shutdown path.
  transport.onclose = () => {
    void shutdown('transport_close');
  };

  server.connect(transport).catch((error) => {
    logLifecycle('server.connect failed', error);
    process.stdin.off('end', handleStdinEnd);
    process.stdin.off('close', handleStdinClose);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
    console.error(error);
  });
}
