/** Placeholder tokens used in templates for provider home paths */
export const TEMPLATE_PLACEHOLDERS = {
  CODEBUDDY_HOME: '{{CODEBUDDY_HOME}}',
  CODEX_HOME: '{{CODEX_HOME}}',
  CLAUDE_HOME: '{{CLAUDE_HOME}}',
} as const;

export type TemplatePlaceholder = typeof TEMPLATE_PLACEHOLDERS[keyof typeof TEMPLATE_PLACEHOLDERS];

/** Scope + provider → replacement map for template rendering */
export function getTemplateReplacements(
  scope: 'project' | 'user',
  provider: 'codebuddy' | 'codex' | 'claude' | 'both' | 'all',
): Map<string, string> {
  const replacements = new Map<string, string>();
  const prefix = scope === 'project' ? './' : '~/';

  const codebuddyHome = `${prefix}.codebuddy`;
  const codexHome = `${prefix}.codex`;
  const claudeHome = `${prefix}.claude`;

  if (provider === 'codebuddy' || provider === 'both' || provider === 'all') {
    replacements.set(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME, codebuddyHome);
  }
  if (provider === 'codex' || provider === 'both' || provider === 'all') {
    replacements.set(TEMPLATE_PLACEHOLDERS.CODEX_HOME, codexHome);
  }
  if (provider === 'claude' || provider === 'all') {
    replacements.set(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME, claudeHome);
  }

  // For single-provider (non-both/non-all), also fill other provider placeholders
  // with the same target path (back-compat with old behavior where all were rewritten)
  if (provider === 'codebuddy') {
    replacements.set(TEMPLATE_PLACEHOLDERS.CODEX_HOME, codebuddyHome);
    replacements.set(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME, codebuddyHome);
  } else if (provider === 'codex') {
    replacements.set(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME, codexHome);
    replacements.set(TEMPLATE_PLACEHOLDERS.CLAUDE_HOME, codexHome);
  } else if (provider === 'claude') {
    replacements.set(TEMPLATE_PLACEHOLDERS.CODEBUDDY_HOME, claudeHome);
    replacements.set(TEMPLATE_PLACEHOLDERS.CODEX_HOME, claudeHome);
  }

  return replacements;
}

/** Render template by replacing placeholders only */
export function renderTemplate(content: string, replacements: Map<string, string>): string {
  let result = content;
  for (const [placeholder, value] of replacements) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}
