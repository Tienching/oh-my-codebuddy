/**
 * Command template parsing helpers.
 * Supports simple front-matter + template body format used by CodeBuddy/CodeLexical command files.
 */

export interface ParsedCommandFile {
  description: string;
  template: string;
}

const FRONT_MATTER_RE =
  /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const DESCRIPTION_RE = /^\s*description:\s*(.+?)\s*$/m;

function normalizeDescription(rawDescription?: string): string {
  if (!rawDescription) return "";
  return rawDescription
    .trim()
    .replace(/^["'](.*)["']$/s, "$1");
}

export function parseCommandFile(content: string): ParsedCommandFile {
  const frontMatterMatch = content.match(FRONT_MATTER_RE);

  if (!frontMatterMatch) {
    return {
      description: "",
      template: content,
    };
  }

  const [, rawFrontMatter, rawTemplate] = frontMatterMatch;
  const descriptionMatch = rawFrontMatter.match(DESCRIPTION_RE);
  const description = normalizeDescription(descriptionMatch?.[1]);

  return {
    description,
    template: rawTemplate,
  };
}
