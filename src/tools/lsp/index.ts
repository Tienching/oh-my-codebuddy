/**
 * LSP Client
 *
 * Real Language Server Protocol client for IDE-like capabilities:
 * hover, goto definition, find references, document symbols,
 * workspace symbols, diagnostics, rename, code actions.
 *
 * Usage:
 *   import { lspClientManager, getAllServers } from './tools/lsp/index.js';
 *
 *   // Check available servers
 *   const servers = getAllServers();
 *
 *   // Get a client for a file
 *   const client = await lspClientManager.getClientForFile('src/foo.ts');
 *
 *   // Run with lease (protected from idle eviction)
 *   await lspClientManager.runWithClientLease('src/foo.ts', async (client) => {
 *     const hover = await client.hover('src/foo.ts', 10, 5);
 *     return hover;
 *   });
 */

export type {
  Position,
  Range,
  Location,
  TextDocumentIdentifier,
  TextDocumentPositionParams,
  Hover,
  Diagnostic,
  DocumentSymbol,
  SymbolInformation,
  WorkspaceEdit,
  CodeAction,
  LspServerConfig,
} from './types.js';

export {
  LSP_SERVERS,
  commandExists,
  getServerForFile,
  getAllServers,
  getServerForLanguage,
} from './servers.js';

export {
  formatHover,
  formatLocations,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatDiagnostics,
  formatCodeActions,
  formatWorkspaceEdit,
  countEdits,
} from './formatters.js';

export {
  LspClient,
  LspClientManager,
  lspClientManager,
  disconnectAll,
} from './client.js';
