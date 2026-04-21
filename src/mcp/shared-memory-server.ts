/**
 * Shared Memory MCP Server
 *
 * Provides cross-agent shared memory tools:
 * - shared_memory_write: Write a key-value pair with optional TTL
 * - shared_memory_read: Read a value by key and namespace
 * - shared_memory_list: List keys in a namespace or all namespaces
 * - shared_memory_delete: Delete a key
 * - shared_memory_cleanup: Remove expired entries
 *
 * Storage: .omb/shared-memory/{namespace}/{key}.json
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { autoStartStdioMcpServer } from './bootstrap.js';
import {
  writeEntry,
  readEntry,
  listEntries,
  deleteEntry,
  cleanupExpired,
  listNamespaces,
} from '../shared-memory/storage.js';
import { resolveWorkingDirectoryForState } from './state-paths.js';

const server = new Server(
  { name: 'omb-shared-memory', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'shared_memory_write',
      description: 'Write a key-value pair to shared memory for cross-agent handoffs.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key identifier (alphanumeric, hyphens, underscores, dots)' },
          value: { type: 'unknown', description: 'JSON-serializable value to store' },
          namespace: { type: 'string', description: 'Namespace for grouping (e.g., team name, session group)' },
          ttl: { type: 'integer', description: 'Time-to-live in seconds (max 7 days)' },
          workingDirectory: { type: 'string' },
        },
        required: ['key', 'value', 'namespace'],
      },
    },
    {
      name: 'shared_memory_read',
      description: 'Read a value from shared memory by key and namespace.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to read' },
          namespace: { type: 'string', description: 'Namespace to read from' },
          workingDirectory: { type: 'string' },
        },
        required: ['key', 'namespace'],
      },
    },
    {
      name: 'shared_memory_list',
      description: 'List keys in a namespace, or list all namespaces.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace to list keys from. Omit to list all namespaces.' },
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'shared_memory_delete',
      description: 'Delete a key from shared memory.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to delete' },
          namespace: { type: 'string', description: 'Namespace to delete from' },
          workingDirectory: { type: 'string' },
        },
        required: ['key', 'namespace'],
      },
    },
    {
      name: 'shared_memory_cleanup',
      description: 'Remove expired entries from shared memory.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace to clean. Omit to clean all namespaces.' },
          workingDirectory: { type: 'string' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  let wd: string;
  try {
    wd = resolveWorkingDirectoryForState(a.workingDirectory as string | undefined);
  } catch (error) {
    return errorResult((error as Error).message);
  }

  switch (name) {
    case 'shared_memory_write': {
      const { key, value, namespace, ttl } = a as { key: string; value: unknown; namespace: string; ttl?: number };
      if (!key || !namespace) return errorResult('key and namespace are required');
      const entry = writeEntry(namespace, key, value, ttl, wd);
      let msg = `Written to shared memory.\n- Namespace: ${namespace}\n- Key: ${key}\n- Updated: ${entry.updatedAt}`;
      if (entry.expiresAt) msg += `\n- Expires: ${entry.expiresAt}`;
      return { content: [{ type: 'text' as const, text: msg }] };
    }

    case 'shared_memory_read': {
      const { key, namespace } = a as { key: string; namespace: string };
      if (!key || !namespace) return errorResult('key and namespace are required');
      const entry = readEntry(namespace, key, wd);
      if (!entry) return { content: [{ type: 'text' as const, text: `Key "${key}" not found in namespace "${namespace}" (or expired).` }] };
      const meta = [
        `- Namespace: ${namespace}`,
        `- Key: ${key}`,
        `- Created: ${entry.createdAt}`,
        `- Updated: ${entry.updatedAt}`,
      ];
      if (entry.expiresAt) meta.push(`- Expires: ${entry.expiresAt}`);
      return { content: [{ type: 'text' as const, text: `## Shared Memory Entry\n\n${meta.join('\n')}\n\n### Value\n\n\`\`\`json\n${JSON.stringify(entry.value, null, 2)}\n\`\`\`` }] };
    }

    case 'shared_memory_list': {
      const { namespace } = a as { namespace?: string };
      if (!namespace) {
        const namespaces = listNamespaces(wd);
        if (!namespaces.length) return { content: [{ type: 'text' as const, text: 'No shared memory namespaces found.' }] };
        return { content: [{ type: 'text' as const, text: `## Namespaces\n\n${namespaces.map(ns => `- ${ns}`).join('\n')}` }] };
      }
      const items = listEntries(namespace, wd);
      if (!items.length) return { content: [{ type: 'text' as const, text: `No entries in namespace "${namespace}".` }] };
      const lines = items.map(item => {
        let line = `- **${item.key}** (updated: ${item.updatedAt})`;
        if (item.expiresAt) line += ` [expires: ${item.expiresAt}]`;
        return line;
      });
      return { content: [{ type: 'text' as const, text: `## Shared Memory: ${namespace}\n\n${items.length} entries:\n\n${lines.join('\n')}` }] };
    }

    case 'shared_memory_delete': {
      const { key, namespace } = a as { key: string; namespace: string };
      if (!key || !namespace) return errorResult('key and namespace are required');
      const deleted = deleteEntry(namespace, key, wd);
      return { content: [{ type: 'text' as const, text: deleted ? `Deleted "${key}" from namespace "${namespace}".` : `Key "${key}" not found in namespace "${namespace}".` }] };
    }

    case 'shared_memory_cleanup': {
      const { namespace } = a as { namespace?: string };
      const result = cleanupExpired(namespace, wd);
      return { content: [{ type: 'text' as const, text: result.removed === 0 ? 'No expired entries found.' : `Removed ${result.removed} expired entry/entries.` }] };
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

autoStartStdioMcpServer('shared_memory', server);
