# dsh-ide-switch

DeepSeek Harness plugin: **one window, two modes**. A header toggle switches the
whole DSH window between the agent chat and a full-screen **code-server** IDE —
same browser tab, same workspace, nothing nested side-by-side.

## What it does

- **Self-bootstraps code-server**: on first toggle it installs `code-server`
  via `npm install -g code-server` (one-time, a few minutes) and starts it on
  `127.0.0.1:8443` with `--auth none` (loopback only).
- **Installs VS Code extensions** into code-server on first healthy boot.
  Default: [`1c-syntax.language-1c-bsl`](https://open-vsx.org/extension/1c-syntax/language-1c-bsl)
  (BSL Language Server for 1C:Enterprise — diagnostics, completion,
  go-to-definition, formatting).
- **Adds a header toggle** (`IDE` / `Chat`) with a live status dot
  (gray idle · yellow installing/starting · green running · red missing).
- **IDE mode** mounts a full-screen code-server iframe over the chat with a
  floating `← Chat` button (Esc also returns to chat). The chat session keeps
  living underneath — nothing is lost on switch. Mode persists across reloads.
- The IDE opens the folder `dsh` was started from (`workspaceDir` config).

## Install

```sh
dsh plugin --profile web add dsh-ide-switch
```

Restart `dsh web`, hard-refresh the browser, click **IDE** in the session header.

## Configuration

Overridable in the profile patch (`cordis.patch.yml` / settings), id `ide-switch`:

| Key | Default | Meaning |
|---|---|---|
| `codeServerPort` | `8443` | code-server loopback port |
| `codeServerBin` | `""` | explicit code-server path; empty = PATH / npm global |
| `workspaceDir` | `""` | IDE folder; empty = dsh start directory |
| `autoInstall` | `true` | auto-install code-server when missing |
| `installExtensions` | `["1c-syntax.language-1c-bsl"]` | extensions to install |
| `proxy` | `false` | serve IDE on the same origin under `/ide/` (experimental) |

## HTTP surface

- `GET /ide-status` — `{state, reason, port, url}` (client polls this)
- `GET /ide-start` — force (re)start code-server
- `GET /ide/…` — the IDE itself (redirect to the local port, or proxy when `proxy: true`)

## Roadmap

- Deep links: click a file path in chat → switch to IDE mode with that file open.
- Same-origin proxying as the default once sub-path WebSocket routing is verified.
