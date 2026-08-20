# dsh-bsl-editor

DeepSeek Harness plugin: a **1C:Enterprise (BSL) code editor** in one window.

- File tree of the current DSH workspace — lazy-loading, git M/A/D badges, filename search, resizable panel.
- Monaco editor (CDN, no build step) with BSL syntax highlighting and per-extension language detection.
- Optional LSP via **bsl-language-server** (diagnostics, completion, hover, go-to-definition, formatting) over WebSocket — off by default.
- No code-server, no Docker.

## Install

```sh
dsh plugin --profile web add dsh-bsl-editor
```

The plugin reads the workspace root from DSH's workspace registry — no manual path.
For LSP it expects `bsl-language-server.exe` at
`%LOCALAPPDATA%\Programs\bsl-language-server\bsl-language-server\bsl-language-server.exe`
(the `bsl-language-server_win.zip` release layout).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `serverPort` | `8025` | bsl-language-server WebSocket port |
| `serverBin` | `""` | explicit path; empty = the standard install location |
| `workspaceDir` | `""` | workspace root override; empty = the DSH workspace |
| `sourceExtensions` | `[".bsl", ".os"]` | text sources opened as code |

## Structure

- `lib/index.js` — host half (ESM): `/bsl/*` routes (tree, read, search, git), optional bsl-language-server spawn.
- `lib/client.js` — client half: the `Editor` conversation-view tab (tree + Monaco).
- `cordis.patch.yml` — bundle patch mounting the plugin row.
