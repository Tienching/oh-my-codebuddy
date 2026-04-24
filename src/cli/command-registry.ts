/**
 * Command registry for the OMB CLI.
 *
 * Provides a typed registry of CLI commands with resolution,
 * help generation, and dispatch support.
 */

import { formatCliText } from "./brand.js";

export interface CommandResult {
  exitCode: number;
  output?: string;
  error?: string;
}

export interface CliContext {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  isTty: boolean;
  isTmux: boolean;
}

export interface CommandDescriptor {
  name: string;
  aliases: string[];
  helpText: string;
  hidden?: boolean;
  ownsLocalHelp?: boolean;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDescriptor>();
  private aliasIndex = new Map<string, string>();

  register(descriptor: CommandDescriptor): void {
    this.commands.set(descriptor.name, descriptor);
    for (const alias of descriptor.aliases) {
      this.aliasIndex.set(alias, descriptor.name);
    }
  }

  resolve(name: string): CommandDescriptor | undefined {
    return this.commands.get(name) ?? this.commands.get(this.aliasIndex.get(name) ?? "");
  }

  allCommands(): CommandDescriptor[] {
    return [...this.commands.values()];
  }

  generateHelp(): string {
    return formatCliText(`
{project} ({cmd}) - Multi-agent orchestration for {product} CLI

Usage:
  {cmd}           Launch {product} CLI (HUD auto-attaches only when already inside tmux)
  {cmd} exec      Run codebuddy exec non-interactively with {acronym} AGENTS/overlay injection
  {cmd} setup     Install skills, prompts, MCP servers, and scope-specific AGENTS.md
  {cmd} uninstall Remove {acronym} configuration and clean up installed artifacts
  {cmd} doctor    Check installation health
  {cmd} cleanup   Kill orphaned {acronym} MCP server processes and remove stale .omb /tmp directories
  {cmd} doctor --team  Check team/swarm runtime health diagnostics
  {cmd} ask       Ask local provider CLI (claude|gemini) and write artifact output
  {cmd} adapt     Scaffold OMB-owned adapter foundations for persistent external targets
  {cmd} question  Blocking question entrypoint for controlled user questions
  {cmd} resume    Resume a previous interactive {product} session
  {cmd} explore   Default read-only exploration entrypoint (may adaptively use sparkshell backend)
  {cmd} session   Search prior local session transcripts and history artifacts
  {cmd} agents-init [path]
                Bootstrap lightweight AGENTS.md files for a repo/subtree
  {cmd} agents    Manage {product} native agent TOML files
  {cmd} deepinit [path]
                Alias for agents-init (lightweight AGENTS bootstrap only)
  {cmd} team      Spawn parallel worker panes in tmux and bootstrap inbox/task state
  {cmd} ralph     Launch {product} with ralph persistence mode active
  {cmd} autoresearch Launch thin-supervisor autoresearch with keep/discard/reset parity
  {cmd} version   Show version information
  {cmd} tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  {cmd} hooks     Manage hook plugins (init|status|validate|test)
  {cmd} hud       Show HUD statusline (--watch, --json, --preset=NAME)
  {cmd} state     Read/write/list {acronym} mode state via CLI parity surface
  {cmd} notepad   CLI parity for {acronym} notepad MCP tools
  {cmd} project-memory
                CLI parity for {acronym} project-memory MCP tools
  {cmd} trace     CLI parity for {acronym} trace MCP tools
  {cmd} code-intel
                CLI parity for {acronym} code-intel MCP tools
  {cmd} sparkshell <command> [args...]
  {cmd} sparkshell --tmux-pane <pane-id> [--tail-lines <100-1000>]
                Run native sparkshell sidecar for direct command execution or explicit tmux-pane summarization
                (also used as an adaptive backend for qualifying read-only explore tasks)
  {cmd} help      Show this help message
  {cmd} status    Show active modes and state
  {cmd} cancel    Cancel active execution modes
  {cmd} reasoning Show or set model reasoning effort (low|medium|high|xhigh)

Options:
  --yolo        Launch {product} in yolo mode (shorthand for: {cmd} launch --yolo)
  --model <id>  Pass through to {product} to choose the exact model directly
  --high        [DEPRECATED] Use --effort high instead
  --xhigh       [DEPRECATED] Use --effort xhigh instead
  --effort <l>  Set reasoning effort: low | medium | high | xhigh
  --madmax      DANGEROUS: bypass {product} approvals and sandbox
                (alias for --dangerously-skip-permissions)
  --spark       Use the {product} spark model (~1.3x faster) for team workers only
                Workers get the configured low-complexity team model; leader model unchanged
  --madmax-spark  spark model for workers + bypass approvals for leader and workers
                (shorthand for: --spark --madmax)
  --notify-temp  Enable temporary notification routing for this run/session only
  --tmux         Launch the interactive leader session in detached tmux
  --discord      Select Discord provider for temporary notification mode
  --slack        Select Slack provider for temporary notification mode
  --telegram     Select Telegram provider for temporary notification mode
  --custom <name>
                Select custom/OpenClaw gateway name for temporary notification mode
  -w, --worktree[=<name>]
                Launch {product} in a git worktree (detached when no name is given)
  --force       Force reinstall (overwrite existing files)
  --dry-run     Show what would be done without doing it
  --keep-config Skip settings.json cleanup during uninstall
  --purge       Remove .omb/ cache directory during uninstall
  --verbose     Show detailed output
  --scope       Setup scope for "{cmd} setup" only:
                user | project
`);
  }
}

/** Commands that own their own help output (i.e. don't delegate to top-level help). */
const NESTED_HELP_COMMAND_NAMES = new Set([
  "ask",
  "adapt",
  "question",
  "cleanup",
  "autoresearch",
  "agents",
  "agents-init",
  "deepinit",
  "exec",
  "hooks",
  "hud",
  "state",
  "ralph",
  "resume",
  "session",
  "sparkshell",
  "team",
  "tmux-hook",
]);

export function commandOwnsLocalHelp(commandName: string): boolean {
  return NESTED_HELP_COMMAND_NAMES.has(commandName);
}

/** Build and return the default command registry with all known commands. */
export function buildCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register({ name: "launch", aliases: [], helpText: "Launch CodeBuddy CLI with HUD" });
  registry.register({ name: "exec", aliases: [], helpText: "Run codebuddy exec non-interactively", ownsLocalHelp: true });
  registry.register({ name: "setup", aliases: [], helpText: "Install skills, prompts, MCP servers, and scope-specific AGENTS.md" });
  registry.register({ name: "uninstall", aliases: [], helpText: "Remove OMB configuration and clean up installed artifacts" });
  registry.register({ name: "doctor", aliases: [], helpText: "Check installation health" });
  registry.register({ name: "cleanup", aliases: [], helpText: "Kill orphaned OMB MCP server processes", ownsLocalHelp: true });
  registry.register({ name: "ask", aliases: [], helpText: "Ask local provider CLI and write artifact output", ownsLocalHelp: true });
  registry.register({ name: "adapt", aliases: [], helpText: "Scaffold OMB-owned adapter foundations for persistent external targets", ownsLocalHelp: true });
  registry.register({ name: "question", aliases: [], helpText: "Blocking question entrypoint for controlled user questions", ownsLocalHelp: true });
  registry.register({ name: "explore", aliases: [], helpText: "Default read-only exploration entrypoint" });
  registry.register({ name: "sparkshell", aliases: [], helpText: "Run native sparkshell sidecar", ownsLocalHelp: true });
  registry.register({ name: "team", aliases: [], helpText: "Spawn parallel worker panes in tmux", ownsLocalHelp: true });
  registry.register({ name: "ralph", aliases: [], helpText: "Launch with ralph persistence mode", ownsLocalHelp: true });
  registry.register({ name: "state", aliases: [], helpText: "Read/write/list OMB mode state", ownsLocalHelp: true });
  registry.register({ name: "session", aliases: [], helpText: "Search prior local session transcripts", ownsLocalHelp: true });
  registry.register({ name: "resume", aliases: [], helpText: "Resume a previous interactive session", ownsLocalHelp: true });
  registry.register({ name: "version", aliases: ["-v", "--version"], helpText: "Show version information" });
  registry.register({ name: "help", aliases: ["--help", "-h"], helpText: "Show help message" });
  registry.register({ name: "tmux-hook", aliases: [], helpText: "Manage tmux prompt injection workaround", ownsLocalHelp: true });
  registry.register({ name: "hooks", aliases: [], helpText: "Manage hook plugins", ownsLocalHelp: true });
  registry.register({ name: "hud", aliases: [], helpText: "Show HUD statusline", ownsLocalHelp: true });
  registry.register({ name: "status", aliases: [], helpText: "Show active modes and state" });
  registry.register({ name: "cancel", aliases: [], helpText: "Cancel active execution modes" });
  registry.register({ name: "reasoning", aliases: [], helpText: "Show or set model reasoning effort" });
  registry.register({ name: "agents", aliases: [], helpText: "Manage CodeBuddy native agent TOML files", ownsLocalHelp: true });
  registry.register({ name: "agents-init", aliases: ["deepinit"], helpText: "Bootstrap lightweight AGENTS.md files", ownsLocalHelp: true });
  registry.register({ name: "autoresearch", aliases: [], helpText: "Launch thin-supervisor autoresearch", ownsLocalHelp: true });
  registry.register({ name: "mcp-parity", aliases: [], helpText: "CLI parity for OMB MCP tools", hidden: true });
  registry.register({ name: "notepad", aliases: [], helpText: "CLI parity for OMB notepad MCP tools" });
  registry.register({ name: "project-memory", aliases: [], helpText: "CLI parity for OMB project-memory MCP tools" });
  registry.register({ name: "trace", aliases: [], helpText: "CLI parity for OMB trace MCP tools" });
  registry.register({ name: "code-intel", aliases: [], helpText: "CLI parity for OMB code-intel MCP tools" });

  return registry;
}
