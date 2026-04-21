# oh-my-codebuddy (OMB)

[![npm version](https://img.shields.io/npm/v/oh-my-codebuddy)](https://www.npmjs.com/package/oh-my-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

oh-my-codebuddy, CodeBuddy CLI iş akışları için bir orkestrasyon katmanıdır.

OMB, ana CLI üzerine şunları ekler:
- standart akış: `$deep-interview` → `$ralplan` → `$team` / `$ralph`
- yeniden kullanılabilir skill'ler ve rol prompt'ları
- tmux/worktree tabanlı kalıcı team runtime
- state, memory, trace ve code-intel için CLI/MCP parity
- `AGENTS.md` üzerinden proje yönlendirmesi

**Ana komut:** `omb`

## Kurulum

```bash
npm install -g oh-my-codebuddy
omb setup
```

## Hızlı başlangıç

```bash
omb --madmax --high
```

Ya da açıkça tmux içinde:

```bash
omb --tmux --madmax --high
```

Oturum içinde:

```text
$deep-interview "kapsamı ve kısıtları netleştir"
$ralplan "bunu onaylı bir plana dönüştür"
$ralph "onaylı planı doğrulamayla tamamla"
$team 3:executor "onaylı planı paralel yürüt"
```

## Temel komutlar

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

## Runtime verileri

Ana runtime yolu:
- `.omb/state/`
- `.omb/plans/`
- `.omb/logs/`
- `.omb/notepad.md`
- `.omb/project-memory.json`

Eski proje durumlarıyla uyumluluk da gerektiği yerlerde korunur.

## Dokümantasyon

- [Kanonik İngilizce README](../../README.md)
- [Getting Started](../getting-started.html)
- [Agents](../agents.html)
- [Skills](../skills.html)
- [Integrations](../integrations.html)
- [OpenClaw guide](../openclaw-integration.md)
