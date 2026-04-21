# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Το oh-my-codebuddy είναι επίπεδο orchestration για ροές εργασίας CodeBuddy CLI.

Το OMB προσθέτει πάνω από το βασικό coding CLI:
- μια προεπιλεγμένη ροή: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- επαναχρησιμοποιήσιμα skills και role prompts
- ανθεκτικό team runtime με tmux/worktrees
- parity CLI/MCP για state, memory, trace και code-intel
- καθοδήγηση έργου μέσω `AGENTS.md`

**Κύρια εντολή:** `omb`

## Εγκατάσταση

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Γρήγορη εκκίνηση

```bash
omb --madmax --high
```

Ή ρητά μέσα σε tmux:

```bash
omb --tmux --madmax --high
```

Μέσα στη συνεδρία:

```text
$deep-interview "ξεκαθάρισε scope και περιορισμούς"
$ralplan "μετέτρεψέ το σε εγκεκριμένο σχέδιο"
$ralph "ολοκλήρωσε το σχέδιο με επαλήθευση"
$team 3:executor "υλοποίησε το σχέδιο παράλληλα"
```

## Βασικές εντολές

```bash
omb team 3:executor "fix the failing tests with verification"
omb team status <team-name>
omb team resume <team-name>
omb team shutdown <team-name>
omb explore --prompt "find where team state is written"
omb sparkshell git status
omb doctor
omb uninstall
```

## Runtime δεδομένα

Κύριος φάκελος runtime:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Η συμβατότητα με παλαιότερη κατάσταση έργου παραμένει όπου χρειάζεται.

## Τεκμηρίωση

- [Canonical English README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
