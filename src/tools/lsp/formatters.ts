/**
 * LSP Response Formatters
 *
 * Formats LSP protocol responses into human-readable text.
 */

import type {
  Hover,
  Location,
  DocumentSymbol,
  SymbolInformation,
  Diagnostic,
  CodeAction,
  WorkspaceEdit,
} from './types.js';

/**
 * Format hover response
 */
export function formatHover(hover: Hover | null): string {
  if (!hover) return 'No hover information';

  const { contents, range } = hover;
  let text = '';

  if (typeof contents === 'string') {
    text = contents;
  } else if (Array.isArray(contents)) {
    text = contents.map(c => (typeof c === 'string' ? c : `**${c.kind}**\n${c.value}`)).join('\n---\n');
  } else {
    text = `**${contents.kind}**\n${contents.value}`;
  }

  if (range) {
    text += `\n\n\`[${range.start.line + 1}:${range.start.character + 1} → ${range.end.line + 1}:${range.end.character + 1}]\``;
  }

  return text;
}

/**
 * Format locations (definition, references)
 */
export function formatLocations(locations: Location | Location[] | null): string {
  if (!locations) return 'No locations found';
  const list = Array.isArray(locations) ? locations : [locations];
  if (list.length === 0) return 'No locations found';

  return list.map(loc => {
    const { uri, range } = loc;
    const fileName = uri.split('/').pop() || uri;
    const { start, end } = range;
    const pos = start.line === end.line
      ? `${start.line + 1}:${start.character + 1}`
      : `${start.line + 1}:${start.character + 1} → ${end.line + 1}:${end.character + 1}`;
    return `${fileName} (${pos})`;
  }).join('\n');
}

/**
 * Format document symbols
 */
export function formatDocumentSymbols(symbols: DocumentSymbol[] | SymbolInformation[] | null): string {
  if (!symbols || symbols.length === 0) return 'No symbols found';

  const SYMBOL_KINDS: Record<number, string> = {
    1: 'File',
    2: 'Module',
    3: 'Namespace',
    4: 'Package',
    5: 'Class',
    6: 'Method',
    7: 'Property',
    8: 'Field',
    9: 'Constructor',
    10: 'Enum',
    11: 'Interface',
    12: 'Function',
    13: 'Variable',
    14: 'Constant',
    15: 'String',
    16: 'Number',
    17: 'Boolean',
    18: 'Array',
    19: 'Object',
    20: 'Key',
    21: 'Null',
    22: 'EnumMember',
    23: 'Event',
    24: 'Operator',
    25: 'TypeParameter',
  };

  function formatSymbol(sym: DocumentSymbol | SymbolInformation, indent: number): string {
    const prefix = '  '.repeat(indent);
    const kind = 'kind' in sym ? SYMBOL_KINDS[sym.kind] || `Kind(${sym.kind})` : 'Symbol';
    const name = sym.name;
    const range = 'range' in sym ? sym.range : null;
    const loc = 'location' in sym ? sym.location : null;
    const rangeStr = range
      ? `[${range.start.line + 1}:${range.start.character + 1}]`
      : loc
        ? `[${loc.range.start.line + 1}:${loc.range.start.character + 1}]`
        : '';

    let line = `${prefix}${name} (${kind}) ${rangeStr}`.trim();

    if ('children' in sym && sym.children?.length) {
      line += '\n' + sym.children.map(c => formatSymbol(c, indent + 1)).join('\n');
    }

    return line;
  }

  const lines = symbols.map(s => formatSymbol(s, 0));
  return lines.join('\n');
}

/**
 * Format workspace symbols
 */
export function formatWorkspaceSymbols(symbols: SymbolInformation[] | null): string {
  if (!symbols || symbols.length === 0) return 'No symbols found';

  const SYMBOL_KINDS: Record<number, string> = {
    1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package',
    5: 'Class', 6: 'Method', 7: 'Property', 8: 'Field',
    9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function',
    13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
    17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
    21: 'Null', 22: 'EnumMember', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
  };

  return symbols.map(sym => {
    const fileName = sym.location.uri.split('/').pop() || sym.location.uri;
    const { line, character } = sym.location.range.start;
    const kind = SYMBOL_KINDS[sym.kind] || `Kind(${sym.kind})`;
    const container = sym.containerName ? ` (${sym.containerName})` : '';
    return `${sym.name} — ${kind}${container} at ${fileName}:${line + 1}:${character + 1}`;
  }).join('\n');
}

/**
 * Format diagnostics
 */
export function formatDiagnostics(diagnostics: Diagnostic[], file: string): string {
  const SEVERITY_NAMES: Record<number, string> = {
    1: 'Error',
    2: 'Warning',
    3: 'Information',
    4: 'Hint',
  };

  return diagnostics.map(d => {
    const severity = d.severity ? SEVERITY_NAMES[d.severity] || `Severity(${d.severity})` : 'Unknown';
    const code = d.code ? ` [${d.code}]` : '';
    const source = d.source ? ` (${d.source})` : '';
    const { start } = d.range;
    return `[${severity}] ${file}:${start.line + 1}:${start.character + 1}${code}${source}\n  ${d.message}`;
  }).join('\n\n');
}

/**
 * Format code actions
 */
export function formatCodeActions(actions: CodeAction[] | null): string {
  if (!actions || actions.length === 0) return 'No code actions available';

  return actions.map((action, i) => {
    let line = `${i + 1}. ${action.title}`;
    if (action.kind) line += ` [${action.kind}]`;
    if (action.isPreferred) line += ' (Preferred)';
    if (action.diagnostics?.length) line += ` — ${action.diagnostics.length} diagnostic(s)`;
    return line;
  }).join('\n');
}

/**
 * Format workspace edit
 */
export function formatWorkspaceEdit(edit: WorkspaceEdit): string {
  let output = '';

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      const fileName = change.textDocument.uri.split('/').pop() || change.textDocument.uri;
      output += `File: ${fileName}\n`;
      for (const e of change.edits) {
        const { start, end } = e.range;
        output += `  ${start.line + 1}:${start.character + 1} → ${end.line + 1}:${end.character + 1}: "${e.newText}"\n`;
      }
    }
  }

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fileName = uri.split('/').pop() || uri;
      output += `File: ${fileName}\n`;
      for (const e of edits) {
        const { start, end } = e.range;
        output += `  ${start.line + 1}:${start.character + 1} → ${end.line + 1}:${end.character + 1}: "${e.newText}"\n`;
      }
    }
  }

  return output || 'No edits';
}

/**
 * Count files and total edits in a workspace edit
 */
export function countEdits(edit: WorkspaceEdit): { files: number; edits: number } {
  let files = 0;
  let edits = 0;

  if (edit.documentChanges) {
    files = edit.documentChanges.length;
    edits = edit.documentChanges.reduce((sum, change) => sum + change.edits.length, 0);
  } else if (edit.changes) {
    files = Object.keys(edit.changes).length;
    edits = Object.values(edit.changes).reduce((sum, e) => sum + e.length, 0);
  }

  return { files, edits };
}
