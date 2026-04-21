/**
 * LSP MCP Server
 *
 * Provides real LSP capabilities via the MCP protocol.
 * Wraps the LSP client (typescript-language-server, rust-analyzer, etc.)
 * to expose proper hover, goto definition, find references, etc.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { autoStartStdioMcpServer } from './bootstrap.js';
import {
  lspClientManager,
  getAllServers,
  getServerForFile,
  formatHover,
  formatLocations,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatDiagnostics,
  formatCodeActions,
  formatWorkspaceEdit,
  countEdits,
} from '../tools/lsp/index.js';
import type { Range } from '../tools/lsp/index.js';

const server = new Server(
  { name: 'omb-lsp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

async function withLspClient<T>(
  filePath: string,
  operation: string,
  fn: (client: Awaited<ReturnType<typeof lspClientManager.getClientForFile>>) => Promise<T>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const serverConfig = getServerForFile(filePath);
  if (!serverConfig) {
    return errorResult(
      `No language server available for: ${filePath}\n\nUse lsp_servers to see available servers.`,
    );
  }

  try {
    const result = await lspClientManager.runWithClientLease(filePath, fn);
    return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return errorResult(msg);
    }
    return errorResult(`Error in ${operation}: ${msg}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'lsp_hover',
      description: 'Get type information, documentation, and signature at a specific position. Useful for understanding what a symbol represents.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)', minimum: 1 },
          character: { type: 'integer', description: 'Character position (0-indexed)', minimum: 0 },
        },
        required: ['file', 'line', 'character'],
      },
    },
    {
      name: 'lsp_goto_definition',
      description: 'Find the definition location of a symbol (function, variable, class, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)', minimum: 1 },
          character: { type: 'integer', description: 'Character position (0-indexed)', minimum: 0 },
        },
        required: ['file', 'line', 'character'],
      },
    },
    {
      name: 'lsp_find_references',
      description: 'Find all references to a symbol across the codebase.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)', minimum: 1 },
          character: { type: 'integer', description: 'Character position (0-indexed)', minimum: 0 },
          includeDeclaration: { type: 'boolean', description: 'Include the declaration in results (default: true)' },
        },
        required: ['file', 'line', 'character'],
      },
    },
    {
      name: 'lsp_document_symbols',
      description: 'Get a hierarchical outline of all symbols in a file (functions, classes, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
        },
        required: ['file'],
      },
    },
    {
      name: 'lsp_workspace_symbols',
      description: 'Search for symbols across the entire workspace by name.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or pattern to search' },
          file: { type: 'string', description: 'Any file in the workspace (determines which server to use)' },
        },
        required: ['query', 'file'],
      },
    },
    {
      name: 'lsp_diagnostics',
      description: 'Get language server diagnostics (errors, warnings, hints) for a file.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint'], description: 'Filter by severity' },
        },
        required: ['file'],
      },
    },
    {
      name: 'lsp_servers',
      description: 'List all known language servers and their installation status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'lsp_prepare_rename',
      description: 'Check if a symbol at the given position can be renamed.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)', minimum: 1 },
          character: { type: 'integer', description: 'Character position (0-indexed)', minimum: 0 },
        },
        required: ['file', 'line', 'character'],
      },
    },
    {
      name: 'lsp_rename',
      description: 'Rename a symbol across all files in the project. Returns the list of edits.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          line: { type: 'integer', description: 'Line number (1-indexed)', minimum: 1 },
          character: { type: 'integer', description: 'Character position (0-indexed)', minimum: 0 },
          newName: { type: 'string', description: 'New name for the symbol' },
        },
        required: ['file', 'line', 'character', 'newName'],
      },
    },
    {
      name: 'lsp_code_actions',
      description: 'Get available code actions (refactorings, quick fixes) for a selection.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the source file' },
          startLine: { type: 'integer', description: 'Start line of selection (1-indexed)', minimum: 1 },
          startCharacter: { type: 'integer', description: 'Start character (0-indexed)', minimum: 0 },
          endLine: { type: 'integer', description: 'End line of selection (1-indexed)', minimum: 1 },
          endCharacter: { type: 'integer', description: 'End character (0-indexed)', minimum: 0 },
        },
        required: ['file', 'startLine', 'startCharacter', 'endLine', 'endCharacter'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  switch (name) {
    case 'lsp_hover': {
      const { file, line, character } = a as { file: string; line: number; character: number };
      if (!file || !line) return errorResult('file and line are required');
      return withLspClient(file, 'hover', async (client) => {
        const result = await client!.hover(file, line - 1, character);
        return formatHover(result);
      });
    }

    case 'lsp_goto_definition': {
      const { file, line, character } = a as { file: string; line: number; character: number };
      if (!file || !line) return errorResult('file and line are required');
      return withLspClient(file, 'goto definition', async (client) => {
        const locations = await client!.definition(file, line - 1, character);
        return formatLocations(locations);
      });
    }

    case 'lsp_find_references': {
      const { file, line, character, includeDeclaration = true } = a as {
        file: string; line: number; character: number; includeDeclaration?: boolean;
      };
      if (!file || !line) return errorResult('file and line are required');
      return withLspClient(file, 'find references', async (client) => {
        const locations = await client!.references(file, line - 1, character, includeDeclaration);
        if (!locations?.length) return 'No references found';
        return `Found ${locations.length} reference(s):\n\n${formatLocations(locations)}`;
      });
    }

    case 'lsp_document_symbols': {
      const { file } = a as { file: string };
      if (!file) return errorResult('file is required');
      return withLspClient(file, 'document symbols', async (client) => {
        const symbols = await client!.documentSymbols(file);
        return formatDocumentSymbols(symbols);
      });
    }

    case 'lsp_workspace_symbols': {
      const { query, file } = a as { query: string; file: string };
      if (!query) return errorResult('query is required');
      return withLspClient(file || query, 'workspace symbols', async (client) => {
        const symbols = await client!.workspaceSymbols(query);
        if (!symbols?.length) return `No symbols found matching: ${query}`;
        return `Found ${symbols.length} symbol(s) matching "${query}":\n\n${formatWorkspaceSymbols(symbols)}`;
      });
    }

    case 'lsp_diagnostics': {
      const { file, severity } = a as { file: string; severity?: string };
      if (!file) return errorResult('file is required');
      return withLspClient(file, 'diagnostics', async (client) => {
        await client!.openDocument(file);
        let diagnostics = client!.supportsPullDiagnostics
          ? await client!.pullDiagnostics(file)
          : (await client!.waitForDiagnostics(file, 30_000), client!.getDiagnostics(file));

        if (severity) {
          const severityMap: Record<string, number> = { error: 1, warning: 2, info: 3, hint: 4 };
          const severityNum = severityMap[severity];
          diagnostics = diagnostics.filter(d => d.severity === severityNum);
        }

        if (!diagnostics.length) {
          return severity ? `No ${severity} diagnostics` : 'No diagnostics';
        }
        return `Found ${diagnostics.length} diagnostic(s):\n\n${formatDiagnostics(diagnostics, file)}`;
      });
    }

    case 'lsp_servers': {
      const servers = getAllServers();
      const installed = servers.filter(s => s.installed);
      const notInstalled = servers.filter(s => !s.installed);

      let output = '## Language Server Status\n\n';
      if (installed.length) {
        output += '### Installed:\n';
        for (const s of installed) {
          output += `- ${s.name} (${s.command})\n  Extensions: ${s.extensions.join(', ')}\n`;
        }
        output += '\n';
      }
      if (notInstalled.length) {
        output += '### Not Installed:\n';
        for (const s of notInstalled) {
          output += `- ${s.name} (${s.command})\n  Extensions: ${s.extensions.join(', ')}\n  Install: ${s.installHint}\n`;
        }
      }
      return { content: [{ type: 'text' as const, text: output }] };
    }

    case 'lsp_prepare_rename': {
      const { file, line, character } = a as { file: string; line: number; character: number };
      if (!file || !line) return errorResult('file and line are required');
      return withLspClient(file, 'prepare rename', async (client) => {
        const range = await client!.prepareRename(file, line - 1, character);
        if (!range) return 'Cannot rename symbol at this position';
        return `Rename possible. Symbol range: line ${range.start.line + 1}, col ${range.start.character + 1} to line ${range.end.line + 1}, col ${range.end.character + 1}`;
      });
    }

    case 'lsp_rename': {
      const { file, line, character, newName } = a as { file: string; line: number; character: number; newName: string };
      if (!file || !line || !newName) return errorResult('file, line, and newName are required');
      return withLspClient(file, 'rename', async (client) => {
        const edit = await client!.rename(file, line - 1, character, newName);
        if (!edit) return 'Rename failed or no edits returned';
        const { files, edits } = countEdits(edit);
        return `Rename to "${newName}" would affect ${files} file(s) with ${edits} edit(s):\n\n${formatWorkspaceEdit(edit)}\n\nNote: Use the Edit tool to apply these changes.`;
      });
    }

    case 'lsp_code_actions': {
      const { file, startLine, startCharacter, endLine, endCharacter } = a as {
        file: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number;
      };
      if (!file) return errorResult('file is required');
      const range: Range = {
        start: { line: startLine - 1, character: startCharacter },
        end: { line: endLine - 1, character: endCharacter },
      };
      return withLspClient(file, 'code actions', async (client) => {
        const actions = await client!.codeActions(file, range);
        return formatCodeActions(actions);
      });
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

autoStartStdioMcpServer('lsp', server);
