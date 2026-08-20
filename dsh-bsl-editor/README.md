# dsh-bsl-editor

DeepSeek Harness plugin: a **1C:Enterprise (BSL) code editor** in one window —
file tree with git-change badges, a Monaco editor (loaded from a CDN), and full
LSP via **bsl-language-server** (diagnostics, completion, hover,
go-to-definition, formatting) over a native WebSocket. No code-server, no
C++ toolchain, no Docker.

## How it works

- **Host half** spawns `bsl-language-server -w` (its built-in WebSocket mode,
  Tomcat on a loopback port, LSP at `/lsp`) and exposes JSON routes for the
  file tree (`/bsl/tree`), reads (`/bsl/read`), git status (`/bsl/git-status`),
  git diff (`/bsl/git-diff`) and LSP lifecycle (`/bsl/lsp-status`, `/bsl/lsp-start`).
- **Client half** adds a `1С` tab to the conversation view: a file tree on the
  left and a Monaco editor on the right. Monaco loads from jsdelivr; the LSP
  client is a native `WebSocket` to `ws://127.0.0.1:<port>/lsp`.

## Install

```sh
dsh plugin --profile web add dsh-bsl-editor
```

The plugin expects `bsl-language-server.exe` at
`%LOCALAPPDATA%\Programs\bsl-language-server\bsl-language-server\bsl-language-server.exe`
(the `bsl-language-server_win.zip` release layout). Point `serverBin` elsewhere
if needed.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `serverPort` | `8025` | bsl-language-server WebSocket port |
| `serverBin` | `""` | explicit path; empty = the standard install location |
| `workspaceDir` | `""` | workspace root; empty = dsh cwd |
| `sourceExtensions` | `[".bsl", ".os"]` | text sources opened as code |

## Roadmap

- Inline git diff view (Monaco diff editor between HEAD and working tree).
- Syntax highlighting via the official TextMate grammar (vs hand-written Monarch).
- MCP endpoint of bsl-language-server exposed to the agent.
