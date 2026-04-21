---
title: README translations
description: Index and maintenance guidance for localized oh-my-codebuddy README files
author: OpenAI CodeBuddy
ms.date: 2026-04-21
ms.topic: reference
keywords:
  - readme
  - translations
  - localization
  - documentation
estimated_reading_time: 2
---

## Purpose

This folder contains the localized README files for oh-my-codebuddy.

The repository root `README.md` is the canonical source and reflects the current OMB product surface.
Localized files here should stay aligned with that canonical README, especially for:
- product naming (`oh-my-codebuddy`, `OMB`)
- primary command (`omb`)
- current workflow (`$deep-interview`, `$ralplan`, `$team`, `$ralph`)
- current runtime/state path (`.omb/`)

## Available translations

| Language            | File |
|---------------------|------|
| Deutsch             | [README.de.md](./README.de.md) |
| English             | [../../README.md](../../README.md) |
| Español             | [README.es.md](./README.es.md) |
| Français            | [README.fr.md](./README.fr.md) |
| Italiano            | [README.it.md](./README.it.md) |
| Polski              | [README.pl.md](./README.pl.md) |
| Português           | [README.pt.md](./README.pt.md) |
| Русский             | [README.ru.md](./README.ru.md) |
| Türkçe              | [README.tr.md](./README.tr.md) |
| Tiếng Việt          | [README.vi.md](./README.vi.md) |
| Ελληνικά            | [README.el.md](./README.el.md) |
| 日本語              | [README.ja.md](./README.ja.md) |
| 한국어              | [README.ko.md](./README.ko.md) |
| 简体中文            | [README.zh.md](./README.zh.md) |
| Українська          | [README.uk.md](./README.uk.md) |
| 繁體中文            | [README.zh-TW.md](./README.zh-TW.md) |

## Maintenance rules

- Treat `../../README.md` as the canonical source.
- Keep localized README files concise when exact parity is difficult, but do not keep stale branding or stale command examples.
- Prefer `omb` as the primary command in all current-facing copy.
- Do not reintroduce outdated legacy artwork or screenshot blocks.
- Keep relative links valid from `docs/readme/`.

## Related docs

- Localized OpenClaw guides live one level up in `../`.
- The canonical project entry point remains `../../README.md`.
