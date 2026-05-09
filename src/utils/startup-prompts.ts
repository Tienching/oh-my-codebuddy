function normalizeCapturedLines(captured: string): string[] {
  return captured
    .split("\n")
    .map((line) => line.replace(/\r/g, "").trim())
    .filter((line) => line.length > 0);
}

export function paneHasWorkspaceTrustPrompt(captured: string): boolean {
  const tail = normalizeCapturedLines(captured).slice(-20);

  const hasLegacyQuestion = tail.some((line) => /Do you trust the contents of this directory\?/i.test(line));
  const hasClaudeInternalQuestion = tail.some((line) => /Quick safety check/i.test(line))
    || tail.some((line) => /Is this a project you created or one you trust\?/i.test(line));

  const hasLegacyChoices = tail.some((line) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(line));
  const hasClaudeInternalChoices = tail.some((line) => /Yes,\s*I trust this folder/i.test(line))
    && tail.some((line) => /No,\s*exit/i.test(line))
    && tail.some((line) => /Enter to confirm/i.test(line));

  return (hasLegacyQuestion && hasLegacyChoices) || (hasClaudeInternalQuestion && hasClaudeInternalChoices);
}

export function paneHasClaudeBypassPermissionsPrompt(captured: string): boolean {
  const tail = normalizeCapturedLines(captured).slice(-20);
  const hasWarning = tail.some((line) => /Bypass Permissions mode/i.test(line));
  const hasChoices = tail.some((line) => /No,\s*exit/i.test(line))
    && tail.some((line) => /Yes,\s*I\s*accept/i.test(line))
    && tail.some((line) => /Enter\s*to\s*confirm/i.test(line));
  return hasWarning && hasChoices;
}
