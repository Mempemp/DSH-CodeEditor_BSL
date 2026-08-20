# dsh-bsl-editor

DeepSeek Harness plugin: a **1C:Enterprise (BSL) code editor** in one window.

- File tree of the current DSH workspace — lazy-loading, git M/A/D badges, filename search, resizable panel.
- **1C metadata tree** — a «Файлы | Метаданные» switch rebuilds the tree as a 1C:Enterprise metadata tree with per-type icons: Подсистемы, Справочники, Документы, Регистры, Общие модули, … → объекты → Реквизиты / Табличные части / Формы / Команды / Макеты / Модули. Click a module and it opens in the editor.
- Monaco editor (CDN, no build step) with BSL syntax highlighting and per-extension language detection.
- **F12 go-to-definition without LSP** — resolves «[Коллектор.]Модуль.Метод» through the metadata model (exact module); a bare method name is looked up in the current module only (repeated F12 cycles through candidates).
- LSP via **bsl-language-server** (diagnostics, completion, hover, go-to-definition, formatting) over WebSocket — **off by default** (unstable on large configurations). Enable it in DSH Settings → «1С-редактор»; status bar on top shows the connection state (click retries).
- No code-server, no Docker.

## Metadata tree: supported dump formats

The metadata tree auto-detects the configuration inside the workspace (scan depth 3, shallowest wins):

| Format | Marker | Notes |
|---|---|---|
| **EDT** | `Configuration/Configuration.mdo` | objects from `.mdo` files (attributes, tabular sections, forms, commands, templates) |
| **XML dump (Designer)** | `ConfigDumpInfo.xml` + `Configuration.xml` | full tree from the flat/hierarchical metadata list, incl. attributes |
| **Object-by-object XML** | root `Configuration.xml` + type dirs (`Catalogs/`, `Documents/`, …) | sections recovered from the filesystem: Формы / Команды / Макеты / Модули / Предопределённые (this dump variant stores no attribute metadata) |

Module mapping: `CommonModules/<Имя>/Ext/Module.bsl`, `Catalogs/<Имя>/Ext/ObjectModule.bsl`, `Forms/<Форма>/Ext/Form/Module.bsl`, root `Ext/ManagedApplicationModule.bsl`, etc. — wherever the file exists on disk, the tree node opens it.

The tree is lazy: only what you expand gets parsed, so ЗУП-scale configurations stay instant. Node icons come from the bundled `resources/icons/*.svg`.

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
| `lspEnabled` | `false` | master LSP switch (Settings → «1С-редактор») |

## Structure

- `lib/index.js` — host half (ESM): `/bsl/*` routes (tree, read, search, git, meta), bsl-language-server spawn on demand.
- `lib/metadata.js` — the 1C metadata model: format detection + three parsers (EDT / ConfigDumpInfo / object-by-object), lazy with caching.
- `lib/client.js` — client half: the `Editor` conversation-view tab (tree + Monaco, files/metadata switch).
- `resources/icons/` — 1C metadata node icons.
- `cordis.patch.yml` — bundle patch mounting the plugin row.

## Credits

Metadata tree structure and node icons are adapted from
[zerobig/vscode-1c-metadata-viewer](https://github.com/zerobig/vscode-1c-metadata-viewer)
(MIT License, © Ilya Bushin). The object-by-object dump format support (no
`ConfigDumpInfo.xml`) is original work beyond that extension.
