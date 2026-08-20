// dsh-bsl-editor — client half.
//
// A "1C" conversation.view tab: file tree (with git badges) on the left,
// a Monaco editor (loaded from CDN) on the right, wired to bsl-language-server
// over a native WebSocket for diagnostics, completion, hover, go-to-definition
// and formatting. Inline git-change gutter decorations come from the host's
// /bsl/git-diff route.
window.__ModuleLoader__.load({
  id: "dsh-bsl-editor",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useState, useEffect, useRef, useCallback } = React;

    // Colored folder + neutral file icons (rounded, 16×16). Folders are blue;
    // files are a single neutral color — the extension is already visible in the name.
    function coloredFolder(open) {
      const c = open ? "#6ab0ff" : "#3f8ef2";
      return jsx("svg", { width: 16, height: 16, viewBox: "0 0 16 16", children:
        jsx("path", { d: "M1.5 4.5A1.5 1.5 0 0 1 3 3h2.8c.4 0 .79.16 1.07.45l.72.7c.28.29.67.45 1.07.45H13A1.5 1.5 0 0 1 14.5 6V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12Z", fill: c })
      });
    }

    function coloredFile(name) {
      const c = "#8a94a6"; // single neutral color — extension is already visible in the name
      return jsxs("svg", { width: 16, height: 16, viewBox: "0 0 16 16", children: [
        jsx("path", { d: "M3 2h7l4 4v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 1.5 13V3.5A1.5 1.5 0 0 1 3 2Z", fill: c }),
        jsx("path", { d: "M10 2v4h4", fill: "none", stroke: "rgba(0,0,0,0.22)", strokeWidth: 1, strokeLinejoin: "round" }),
      ]});
    }

    // Transient toast (fixed, bottom-centre) for editor actions.
    function showToast(msg) {
      let t = document.querySelector("[data-bsl-toast]");
      if (!t) {
        t = document.createElement("div");
        t.setAttribute("data-bsl-toast", "1");
        t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;background:rgba(20,22,28,.95);color:#e6e6e6;padding:8px 14px;border-radius:10px;font:var(--dsw-font-s-14);box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .18s";
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.style.opacity = "1";
      clearTimeout(t._timer);
      t._timer = setTimeout(() => { t.style.opacity = "0"; }, 2200);
    }

    // Send a code reference into the DSH chat. Reliable path: copy to clipboard
    // and focus the composer (user pastes). Best-effort: try to insert directly
    // into the composer's editable (textarea / contenteditable).
    function sendToChat(text) {
      try { navigator.clipboard?.writeText(text); } catch {}
      let inserted = false;
      const seat = document.querySelector("[data-composer-seat]");
      const editable = (seat || document).querySelector('[contenteditable="true"], textarea, [role="textbox"]');
      if (editable) {
        editable.focus();
        try {
          if (editable.tagName === "TEXTAREA") {
            const s = editable.selectionStart ?? editable.value.length;
            const e = editable.selectionEnd ?? s;
            editable.setRangeText(text, s, e, "end");
            editable.dispatchEvent(new Event("input", { bubbles: true }));
            inserted = true;
          } else {
            const sel = window.getSelection();
            const inEditable = sel && sel.rangeCount > 0 && (editable.contains(sel.anchorNode) || sel.anchorNode === editable);
            if (inEditable) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(text);
              range.insertNode(node);
              range.setStartAfter(node);
              sel.removeAllRanges();
              sel.addRange(range);
              inserted = true;
            } else if (document.execCommand) {
              try { inserted = document.execCommand("insertText", false, text); } catch {}
            }
          }
        } catch {}
      }
      showToast(inserted ? "Ссылка вставлена в чат" : "Ссылка скопирована — вставьте в чат (Ctrl+V)");
    }

    // Monaco CDNs tried in order — jsdelivr is blocked/throttled on some
    // networks, unpkg and cdnjs are the fallbacks.
    const MONACO_CDNS = [
      "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs",
      "https://unpkg.com/monaco-editor@0.52.2/min/vs",
      "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    ];
    const LSP_PATH = "/lsp";

    // Map a file path to a Monaco language id (for syntax highlighting without LSP).
    function langFor(path) {
      const ext = (path || "").slice(path.lastIndexOf(".")).toLowerCase();
      const m = {
        ".bsl": "bsl", ".os": "bsl",
        ".md": "markdown", ".markdown": "markdown",
        ".json": "json", ".xml": "xml", ".yml": "yaml", ".yaml": "yaml",
        ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
        ".py": "python", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss",
        ".sh": "shell", ".sql": "sql", ".java": "java", ".cs": "csharp",
        ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c", ".cpp": "cpp", ".kt": "kotlin",
        ".ini": "ini", ".toml": "ini", ".bat": "bat",
      };
      return m[ext] || "plaintext";
    }

    async function fetchJson(url, opts) {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }

    // ── Monaco (CDN, with fallbacks) ──────────────────────────────────────
    // Some hosts (a sibling plugin bundle, an embedded webview, a bundler
    // polyfill) define globals that make monaco's AMD loader misdetect its
    // environment. The killer is `module`: monaco's env check is
    // `isNode = typeof module !== "undefined" && !!module.exports` — a page
    // with a global `module` object makes it take `module.exports = …`,
    // never installing its own `require` (window.require stays undefined and
    // `.config` crashes). A global `define` with `.amd` has a similar effect
    // (skips creating its loader). Neutralize them while the loader boots.
    let monacoPromise = null;
    function ensureMonaco() {
      if (monacoPromise) return monacoPromise;
      monacoPromise = (async () => {
        if (window.monaco) return window.monaco;
        let lastErr = null;
        for (const base of MONACO_CDNS) {
          const stashed = {};
          let ok = false;
          try {
            for (const k of ["require", "define", "process", "module", "doNotInitLoader"]) {
              if (k in window) {
                stashed[k] = window[k];
                try { delete window[k]; } catch { /* non-configurable */ }
                // Globals declared with top-level `var` in injected scripts are
                // non-configurable — delete silently fails. Overwrite instead
                // (they are writable) so monaco's env detection sees nothing.
                try { window[k] = undefined; } catch { /* non-writable — leave it */ }
              }
            }
            await new Promise((resolve, reject) => {
              const loader = document.createElement("script");
              loader.src = base + "/loader.js";
              loader.onload = () => resolve();
              loader.onerror = () => reject(new Error("loader.js не загрузился (" + base + ")"));
              document.head.appendChild(loader);
            });
            // Give back everything except require/define — monaco's own must
            // stay installed until editor.main is done loading.
            for (const k of Object.keys(stashed)) {
              if (k !== "require" && k !== "define") window[k] = stashed[k];
            }
            if (typeof window.require !== "function") {
              throw new Error(
                "AMD require не установлен (" + base + ") — process=" + typeof window.process +
                ", module=" + typeof window.module + ", define=" + typeof window.define,
              );
            }
            const monaco = await new Promise((resolve, reject) => {
              try {
                window.require.config({ paths: { vs: base } });
                window.require(
                  ["vs/editor/editor.main"],
                  () => resolve(window.monaco),
                  (err) => reject(err instanceof Error ? err : new Error(String(err || "AMD load failed"))),
                );
              } catch (e) {
                reject(e);
              }
            });
            if (monaco) {
              ok = true;
              // Editor is fully loaded — but monaco's AMD `require`/`define`
              // must STAY installed: the editor's worker bootstrap resolves
              // modules through them at runtime. Hand back only the non-AMD
              // globals (process/module/doNotInitLoader).
              for (const k of Object.keys(stashed)) {
                if (k !== "require" && k !== "define") window[k] = stashed[k];
              }
              return monaco;
            }
          } catch (e) {
            lastErr = e;
          } finally {
            // Failure: hand every displaced global back before the next attempt.
            if (!ok) {
              for (const k of Object.keys(stashed)) window[k] = stashed[k];
            }
          }
        }
        throw lastErr || new Error("monaco CDN unreachable");
      })();
      return monacoPromise;
    }

    // Official 1C TextMate grammar (the same one VS Code's 1C extension uses)
    // via monaco-textmate@3 + onigasm. The grammar JSON itself is served
    // same-origin by the host (/bsl/grammar/1c) — no runtime CDN dependency.
    // On any failure the hand-written Monarch grammar stays as the fallback.
    async function wireTmGrammar(monaco) {
      try {
        // monaco-textmate@3 uses onigasm INTERNALLY from a fixed jsdelivr URL
        // — its WASM must be initialized through that exact module instance,
        // so no CDN fallback for the module itself.
        const onigasm = await import("https://cdn.jsdelivr.net/npm/onigasm@2.2.2/+esm");
        let wasm = null;
        for (const u of [
          "https://cdn.jsdelivr.net/npm/onigasm@2.2.2/lib/onigasm.wasm",
          "https://esm.sh/onigasm@2.2.2/lib/onigasm.wasm",
        ]) {
          try {
            const r = await fetch(u);
            if (r.ok) { wasm = await r.arrayBuffer(); break; }
          } catch {}
        }
        if (!wasm) throw new Error("onigasm.wasm недоступен");
        await onigasm.loadWASM(wasm);
        let tm;
        try {
          tm = await import("https://cdn.jsdelivr.net/npm/monaco-textmate@3.0.1/+esm");
        } catch {
          tm = await import("https://esm.sh/monaco-textmate@3.0.1");
        }
        const [bslRes, queryRes] = await Promise.all([
          fetch("/bsl/grammar/1c"),
          fetch("/bsl/grammar/1c-query"),
        ]);
        if (!bslRes.ok) throw new Error("grammar HTTP " + bslRes.status);
        const grammarJson = await bslRes.json();
        const queryJson = queryRes.ok ? await queryRes.json() : null;
        // The BSL grammar references the 1C-query grammar by its official
        // scopeName ("source.sdbl" — a dependency for highlighting text-query
        // strings), so the locator must serve it; plus a minimal fallback for
        // any other unknown scope so the registry never hard-fails.
        const defs = new Map([[grammarJson.scopeName, { format: "json", content: grammarJson }]]);
        if (queryJson && queryJson.scopeName) defs.set(queryJson.scopeName, { format: "json", content: queryJson });
        const registry = new tm.Registry({
          getGrammarDefinition: async (scopeName) =>
            defs.get(scopeName) || { format: "json", content: { scopeName, patterns: [], repository: {} } },
        });
        const grammar = await registry.loadGrammar(grammarJson.scopeName);
        if (grammar) {
          // Monaco 0.52 legacy provider shape: the tokenize result must carry
          // {startIndex, scopes} tokens (most specific TM scope) and an
          // endState that implements equals()/clone(); the adapter then matches
          // scopes against the active theme (bsl-dark tokenColors).
          class TokenizerState {
            constructor(ruleStack) { this._ruleStack = ruleStack; }
            get ruleStack() { return this._ruleStack; }
            clone() { return new TokenizerState(this._ruleStack); }
            equals(other) { return !!(other && other instanceof TokenizerState && other._ruleStack === this._ruleStack); }
          }
          monaco.languages.setTokensProvider("bsl", {
            getInitialState: () => new TokenizerState(tm.INITIAL),
            tokenize: (line, state) => {
              const r = grammar.tokenizeLine(line, state.ruleStack);
              return {
                endState: new TokenizerState(r.ruleStack),
                tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: t.scopes[t.scopes.length - 1] })),
              };
            },
          });
        }
      } catch (e) {
        console.error("[dsh-bsl-editor] tm grammar", e);
      }
    }

    function bslMonarch() {
      return {
        defaultToken: "",
        tokenPostfix: ".bsl",
        ignoreCase: true,
        keywords: [
          "Процедура", "КонецПроцедуры", "Функция", "КонецФункции",
          "Если", "Тогда", "ИначеЕсли", "Иначе", "КонецЕсли",
          "Для", "Каждого", "Из", "Пока", "По", "Цикл", "КонецЦикла",
          "Попытка", "Исключение", "КонецПопытки", "ВызватьИсключение",
          "Возврат", "Перем", "Новый", "Экспорт", "Знач", "Не", "И", "Или",
          "Продолжить", "Прервать", "Выполнить", "Истина", "Ложь", "Неопределено",
        ],
        typeKeywords: ["Структура", "Соответствие", "Массив", "СписокЗначений", "ТаблицаЗначений"],
        operators: ["+", "-", "*", "/", "%", "=", "<>", "<", ">", "<=", ">=", "?", ":", ".", ",", ";", "(", ")", "[", "]"],
        symbols: /[=><!~?:&|+\-*/^%]+/,
        tokenizer: {
          root: [
            [/^[ \t]*#.*$/, "keyword.control.preprocessor"],
            [/[#&](\w+)/, "annotation"],
            [/"([^"]|"")*"/, "string"],
            [/\b\d+(\.\d+)?\b/, "number"],
            [/\b(Процедура|Функция)\b/, "keyword"],
            [/\b([А-Яа-яЁёA-Za-z_][А-Яа-яЁёA-Za-z_0-9]*)\s*(?=\()/, "function"],
            [/\b(Если|Тогда|Иначе|ИначеЕсли|КонецЕсли|Для|Каждого|Пока|Цикл|КонецЦикла|Попытка|Исключение|КонецПопытки|Возврат|Перем|Экспорт|Знач|Продолжить|Прервать|Выполнить)\b/, "keyword"],
            [/[А-Яа-яЁёA-Za-z_][А-Яа-яЁёA-Za-z_0-9]*/, "identifier"],
            [/\/\/.*$/, "comment"],
            [/[{}]/, "@brackets"],
            [/[<>()\[\]]/, "@brackets"],
          ],
        },
      };
    }

    // ── LSP client over native WebSocket ───────────────────────────────────
    class LspClient {
      constructor(url, rootUri) {
        this.url = url;
        this.rootUri = rootUri;
        this.id = 0;
        this.pending = new Map();
        this.onDiagnostics = null;
        this.ws = null;
      }
      async connect() {
        let lastErr;
        for (let attempt = 1; attempt <= 20; attempt++) {
          try {
            await this._connectOnce();
            return;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        throw lastErr;
      }
      _connectOnce() {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(this.url);
          this.ws = ws;
          let settled = false;
          const fail = (err) => {
            if (settled) return;
            settled = true;
            // Reject every in-flight request too — otherwise a close during
            // initialize/completion hangs the caller forever (infinite
            // "LSP подключение…").
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
            reject(err);
          };
          ws.onopen = async () => {
            try {
              await this.request("initialize", {
                processId: null,
                rootUri: this.rootUri,
                capabilities: {
                  textDocument: {
                    publishDiagnostics: { relatedInformation: true },
                    hover: { contentFormat: ["markdown"] },
                    completion: { completionItem: { snippetSupport: false } },
                    definition: {},
                    formatting: {},
                    synchronization: { didChange: 2 },
                  },
                },
              });
              this.notify("initialized", {});
              if (!settled) { settled = true; resolve(); }
            } catch (e) {
              fail(e);
            }
          };
          ws.onerror = () => fail(new Error("ws error"));
          ws.onmessage = (ev) => this._handle(JSON.parse(ev.data));
          ws.onclose = () => fail(new Error("ws closed"));
        });
      }
      _handle(msg) {
        if (msg.method === "textDocument/publishDiagnostics" && this.onDiagnostics) {
          this.onDiagnostics(msg.params.uri, msg.params.diagnostics);
        } else if (msg.id !== undefined && msg.method) {
          // Server -> client REQUEST (has `method` + `id`): window/showMessageRequest,
          // window/workDoneProgress/create, ... bsl-language-server BLOCKS the
          // initialize handshake until these are answered, so reply `null`.
          // Must be checked BEFORE `pending` — a response carries `id` but no `method`,
          // and server request ids can numerically collide with our request ids.
          try {
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
          } catch {}
        } else if (msg.id !== undefined && this.pending.has(msg.id)) {
          // RESPONSE to one of our requests (id, no method).
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      }
      request(method, params) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
          if (!this.ws || this.ws.readyState !== 1) {
            reject(new Error("LSP соединение закрыто"));
            return;
          }
          this.pending.set(id, { resolve, reject });
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      }
      notify(method, params) {
        // Never throw on a dead socket — file opening must not depend on LSP.
        if (!this.ws || this.ws.readyState !== 1) return;
        try {
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
        } catch {}
      }
    }

    // ── Editor view component ──────────────────────────────────────────────
    // A fixed-size, non-shrinking slot for a row icon: SVG icons default to
    // flex-shrink:1 and, on deep rows with long names, get squeezed smaller than
    // their neighbours. Pin every icon to the same 16×16 centred box.
    const iconBox = (child) => jsx("span", {
      style: { display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 16, height: 16 },
      children: child,
    });

    function EditorView() {
      const [children, setChildren] = useState(new Map()); // dirPath -> entries[]
      const [expanded, setExpanded] = useState(new Set()); // expanded dirPaths
      const [rootPath, setRootPath] = useState(""); // workspace root dir
      const [openPath, setOpenPath] = useState(null);
      const [openContent, setOpenContent] = useState("");
      const [gitFiles, setGitFiles] = useState(new Map());
      const [rootTitle, setRootTitle] = useState("");
      const [treeError, setTreeError] = useState("");
      const [monacoReady, setMonacoReady] = useState(false);
      const [search, setSearch] = useState("");
      const [searchResults, setSearchResults] = useState([]);
      const [highlightPath, setHighlightPath] = useState(null);
      const [treeWidth, setTreeWidth] = useState(280);

      // Metadata-tree mode: "files" (fs tree) | "meta" (1C metadata tree).
      const [mode, setMode] = useState("files");
      const [metaChildren, setMetaChildren] = useState(new Map()); // nodeKey -> items[]
      const [metaExpanded, setMetaExpanded] = useState(new Set()); // expanded nodeKeys
      const [metaInfo, setMetaInfo] = useState(null); // /bsl/meta/status result
      const [metaError, setMetaError] = useState("");
      const [metaLoading, setMetaLoading] = useState(false);
      const [metaHighlight, setMetaHighlight] = useState(null);
      const [editorNotice, setEditorNotice] = useState(null); // transient banner over the editor
      const [ctxMenu, setCtxMenu] = useState(null); // { x, y, item } — meta-tree context menu
      const [lspReady, setLspReady] = useState(false); // LSP WebSocket connected
      const [lspError, setLspError] = useState(""); // last LSP failure, shown in the status bar
      const [lspAttempt, setLspAttempt] = useState(0); // bump to retry the LSP connection
      const [monacoError, setMonacoError] = useState(""); // editor load failure, shown in the placeholder
      const [cfg, setCfg] = useState(null); // /bsl/config result (plugin settings)

      const joinPath = (parent, name) => parent + (parent.endsWith("/") || parent.endsWith("\\") ? "" : "\\") + name;

      const editorRef = useRef(null);
      const monacoRef = useRef(null);
      const modelRef = useRef(null);
      const lspRef = useRef(null);
      const autoRetriesRef = useRef(0); // bounded auto-reconnect counter for LSP
      const containerRef = useRef(null);
      const decorationIdsRef = useRef([]);
      const rootRef = useRef(null);
      const treeBodyRef = useRef(null);
      const draggingRef = useRef(false);
      const rootPathRef = useRef("");
      useEffect(() => { rootPathRef.current = rootPath; }, [rootPath]);

      // Fetch the workspace title. LSP is intentionally deferred — the editor
      // works as a file browser + Monaco (syntax highlighting) on its own.
      useEffect(() => {
        if (!document.querySelector("style[data-dsh-bsl-tree-css]")) {
          const st = document.createElement("style");
          st.setAttribute("data-dsh-bsl-tree-css", "1");
          st.textContent = ".dsh-bsl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-bsl-resizer{background:transparent;transition:background .12s}.dsh-bsl-resizer:hover{background:var(--dsw-alias-state-business-primary)}.dsh-bsl-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}";
          document.head.appendChild(st);
        }
        let alive = true;
        (async () => {
          try {
            const ws = await fetchJson("/bsl/workspaces");
            if (alive && ws.workspaces && ws.workspaces[0]) setRootTitle(ws.workspaces[0].title);
          } catch {}
        })();
        return () => { alive = false; };
      }, []);

      // Plugin settings from the host (editable in DSH Settings → «1С-редактор»).
      useEffect(() => {
        let alive = true;
        fetchJson("/bsl/config")
          .then((c) => { if (alive) setCfg(c); })
          .catch(() => {
            if (alive) setCfg({ lspEnabled: true, serverPort: 8025, serverBin: "", sourceExtensions: [".bsl", ".os"], workspaceDir: "" });
          });
        return () => { alive = false; };
      }, []);

      // LSP: ensure bsl-language-server is running (the host spawns it on
      // demand, JVM+Tomcat boot takes 2-10s) and connect the WebSocket client.
      // The editor stays fully usable meanwhile — providers are wired in a
      // separate effect once BOTH Monaco and LSP are ready. Bumping lspAttempt
      // (status-bar click) or changing settings re-runs this whole sequence.
      useEffect(() => {
        // Master switch: LSP off — stand down and show nothing.
        if (cfg && !cfg.lspEnabled) {
          setLspReady(false);
          setLspError("");
          return;
        }
        let alive = true;
        (async () => {
          try {
            const status0 = await fetchJson("/bsl/lsp-status");
            const port = cfg?.serverPort || status0.port || 8025;
            // lsp-start is idempotent: it probes the port and only spawns when
            // the server is actually missing (a stale "running" state can't
            // block a respawn). Always call it — it's the single source of truth.
            const started = await fetchJson("/bsl/lsp-start");
            if (!alive) return;
            if (started.state !== "running") throw new Error(started.reason || "LSP server not running");
            const wsInfo = await fetchJson("/bsl/workspaces");
            const rootUri = "file:///" + (wsInfo.root || "").replace(/\\/g, "/");
            const lsp = new LspClient(`ws://127.0.0.1:${port}${LSP_PATH}`, rootUri);
            lspRef.current = lsp;
            await lsp.connect();
            if (!alive) { lsp.ws?.close(); return; }
            autoRetriesRef.current = 0;
            lsp.ws.onclose = () => {
              if (!alive) return;
              setLspReady(false);
              // Auto-reconnect (bounded): the server may be restarted by a DSH
              // reload or crash on a huge config — the editor should self-heal
              // instead of waiting for a manual click.
              if (autoRetriesRef.current < 3) {
                autoRetriesRef.current += 1;
                setLspError("");
                setLspAttempt((n) => n + 1);
              } else {
                setLspError("LSP сервер отключился — нажмите для повтора");
              }
            };
            setLspReady(true);
            setLspError("");
          } catch (e) {
            console.error("[dsh-bsl-editor] lsp", e);
            if (alive) setLspError(String(e?.message || e));
          }
        })();
        return () => { alive = false; lspRef.current?.ws?.close(); lspRef.current = null; };
      }, [lspAttempt, cfg]);

      // create the Monaco editor once
      useEffect(() => {
        let alive = true;
        ensureMonaco().then((monaco) => {
          if (!alive || !containerRef.current) return;
          monacoRef.current = monaco;
          monaco.languages.register({ id: "bsl" });
          monaco.languages.setMonarchTokensProvider("bsl", bslMonarch());
          monaco.languages.setLanguageConfiguration("bsl", { comments: { lineComment: "//" } });
          try {
            monaco.editor.defineTheme("bsl-dark", {
              base: "vs-dark",
              inherit: true,
              rules: [
                { token: "keyword", foreground: "569CD6" },
                { token: "keyword.operator", foreground: "D4D4D4" },
                { token: "keyword.other.preprocessor", foreground: "C586C0" },
                { token: "storage.type", foreground: "569CD6" },
                { token: "storage.modifier", foreground: "C586C0" },
                { token: "support.function", foreground: "DCDCAA" },
                { token: "support.class", foreground: "4EC9B0" },
                { token: "entity.name.function", foreground: "DCDCAA" },
                { token: "entity.name.section", foreground: "DCDCAA" },
                { token: "string.quoted.double", foreground: "CE9178" },
                { token: "constant.numeric", foreground: "B5CEA8" },
                { token: "constant.language", foreground: "569CD6" },
                { token: "comment", foreground: "6A9955", fontStyle: "italic" },
                { token: "variable", foreground: "9CDCFE" },
                { token: "invalid", foreground: "F48771" },
              ],
              // monaco 0.52+ reads themeData.colors directly in the tokenTheme
              // getter — the field must exist even when inheriting everything
              // from the base theme (missing colors = crash on editor.create).
              colors: {},
            });
          } catch {}
          const composerClearance = (() => {
            try {
              const v = getComputedStyle(document.documentElement).getPropertyValue("--dsh-composer-height").trim();
              const n = parseInt(v, 10);
              return (Number.isFinite(n) && n > 0 ? n : 152) + 16;
            } catch { return 168; }
          })();
          const editor = monaco.editor.create(containerRef.current, {
            value: "",
            language: "bsl",
            theme: "bsl-dark",
            automaticLayout: true,
            minimap: { enabled: true },
            fontSize: 14,
            scrollBeyondLastLine: false,
            padding: { top: 0, bottom: composerClearance },
          });
          editorRef.current = editor;
          if (alive) setMonacoReady(true);
          // Official 1C TextMate grammar replaces the Monarch fallback once
          // the TM stack is ready (best-effort, never blocks the editor).
          wireTmGrammar(monaco);

          // Context-menu action: reference the current selection in the chat.
          editor.addAction({
            id: "bsl-ref-to-chat",
            label: "Добавить к обсуждению",
            contextMenuGroupId: "9_cutcopypaste",
            contextMenuOrder: 1.5,
            precondition: "editorHasSelection",
            run: (ed) => {
              const sel = ed.getSelection();
              const model = ed.getModel();
              if (!sel || sel.isEmpty() || !model) return;
              const full = (model.uri.fsPath || model.uri.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
              let rel = full;
              const r = (rootPathRef.current || "").replace(/\\/g, "/").replace(/^\/+/, "");
              if (r && rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
              const a = sel.startLineNumber, b = sel.endLineNumber;
              const ref = rel + (a === b ? ":" + a : ":" + a + "-" + b);
              sendToChat(ref);
            },
          });

          return () => { alive = false; editor.dispose(); };
        }).catch((e) => {
          console.error("[dsh-bsl-editor] monaco", e);
          if (alive) setMonacoError(String(e?.message || e));
        });
        return () => { alive = false; };
      }, []);

      // Layout: the editor root sets `data-conversation-composer-overlay` (same
      // mechanism as the Trajectory view). DSH then bounds the view area with
      // `flex:1 1 0; min-height:0; overflow:hidden` and floats the composer over
      // the bottom with a fade gradient — so we don't pin our own height; the tree
      // and Monaco just need bottom clearance to scroll above the composer.

      const loadDir = useCallback(async (path) => {
        try {
          const data = await fetchJson("/bsl/tree?path=" + encodeURIComponent(path || ""));
          const dir = data.path;
          setRootPath((prev) => prev || data.root || dir);
          setChildren((prev) => { const m = new Map(prev); m.set(dir, data.entries); return m; });
          setTreeError("");
          return dir;
        } catch (e) {
          setTreeError(e?.message || String(e));
          return null;
        }
      }, []);

      const toggle = useCallback(async (dirPath) => {
        if (expanded.has(dirPath)) {
          setExpanded((prev) => { const s = new Set(prev); s.delete(dirPath); return s; });
        } else {
          setExpanded((prev) => new Set(prev).add(dirPath));
          if (!children.has(dirPath)) await loadDir(dirPath);
        }
      }, [expanded, children, loadDir]);

      const refreshGit = useCallback(async () => {
        try {
          const data = await fetchJson("/bsl/git-status");
          if (data.ok) {
            const m = new Map();
            for (const f of data.files) m.set(f.path, f.status);
            setGitFiles(m);
          }
        } catch {}
      }, []);

      const openFile = useCallback(async (fullPath) => {
        setEditorNotice(null);
        try {
          const data = await fetchJson("/bsl/read?path=" + encodeURIComponent(fullPath));
          setOpenPath(data.path);
          setOpenContent(data.content);
          if (editorRef.current && monacoRef.current) {
            const monaco = monacoRef.current;
            const uri = monaco.Uri.parse("file:///" + data.path.replace(/\\/g, "/"));
            const lang = langFor(data.path);
            let model = monaco.editor.getModel(uri);
            if (!model) model = monaco.editor.createModel(data.content, lang, uri);
            else monaco.editor.setModelLanguage(model, lang);
            if (model.getValue() !== data.content) model.setValue(data.content);
            if (modelRef.current && modelRef.current !== model) {
              modelRef.current.dispose?.();
            }
            modelRef.current = model;
            editorRef.current.setModel(model);
            if (lspRef.current) {
              lspRef.current.notify("textDocument/didOpen", {
                textDocument: { uri: uri.toString(), languageId: "bsl", version: 1, text: data.content },
              });
            }
            refreshGitDecorations(data.path);
          }
        } catch (e) {
          console.error("[dsh-bsl-editor] open", e);
        }
      }, []);

      const refreshGitDecorations = useCallback(async (path) => {
        if (!editorRef.current || !monacoRef.current) return;
        const monaco = monacoRef.current;
        try {
          const data = await fetchJson("/bsl/git-diff?path=" + encodeURIComponent(path));
          const diff = data.diff || "";
          // map unified diff hunks to changed line decorations
          const changed = new Set();
          const re = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm;
          let m;
          while ((m = re.exec(diff)) !== null) {
            let newLine = parseInt(m[2], 10);
            for (const line of diff.slice(m.index).split("\n").slice(1)) {
              if (line.startsWith("@@")) break;
              if (line.startsWith("+")) { changed.add(newLine); newLine++; }
              else if (line.startsWith("-")) { /* deletion, no new-line */ }
              else if (line.startsWith(" ")) newLine++;
            }
          }
          const decorations = [...changed].map((ln) => ({
            range: new monaco.Range(ln, 1, ln, 1),
            options: { isWholeLine: true, linesDecorationsClassName: "bsl-git-changed", className: "bsl-git-changed-line" },
          }));
          const old = decorationIdsRef.current;
          decorationIdsRef.current = editorRef.current.deltaDecorations(old, decorations);
        } catch {}
      }, []);

      // LSP feature wiring: once Monaco exists AND the LSP client is connected,
      // register diagnostics/completion/hover/definition/formatting and sync
      // edits. Runs when EITHER becomes ready — Monaco boots from CDN while the
      // LSP server boots its JVM, so a single combined effect can't race.
      useEffect(() => {
        if (!monacoReady || !lspReady) return;
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        const lsp = lspRef.current;
        if (!monaco || !editor || !lsp) return;

        const disposables = [];

        lsp.onDiagnostics = (uri, diags) => {
          const model = monaco.editor.getModel(monaco.Uri.parse(uri));
          if (!model) return;
          const map = diags.map((d) => ({
            severity: d.severity === 1 ? monaco.MarkerSeverity.Error : d.severity === 2 ? monaco.MarkerSeverity.Warning : d.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint,
            message: d.message,
            startLineNumber: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLineNumber: d.range.end.line + 1,
            endColumn: d.range.end.character + 1,
          }));
          monaco.editor.setModelMarkers(model, "bsl", map);
        };

        disposables.push(monaco.languages.registerCompletionItemProvider("bsl", {
          triggerCharacters: [".", " "],
          provideCompletionItems: async (model, position) => {
            const uri = model.uri.toString();
            const items = await lsp.request("textDocument/completion", {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!items) return { suggestions: [] };
            const list = Array.isArray(items) ? items : items.items;
            return {
              suggestions: (list || []).map((it) => ({
                label: it.label,
                kind: monaco.languages.CompletionItemKind.Text,
                detail: it.detail,
                documentation: it.documentation?.value ?? it.documentation,
                insertText: it.insertText ?? it.label,
              })),
            };
          },
        }));

        disposables.push(monaco.languages.registerHoverProvider("bsl", {
          provideHover: async (model, position) => {
            const uri = model.uri.toString();
            const res = await lsp.request("textDocument/hover", {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!res) return null;
            const value = res.contents?.value ?? (typeof res.contents === "string" ? res.contents : "");
            return { contents: [{ value: String(value || "") }] };
          },
        }));

        disposables.push(monaco.languages.registerDefinitionProvider("bsl", {
          provideDefinition: async (model, position) => {
            const uri = model.uri.toString();
            const res = await lsp.request("textDocument/definition", {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!res) return null;
            const loc = Array.isArray(res) ? res[0] : res;
            if (!loc) return null;
            return {
              uri: monaco.Uri.parse(loc.uri),
              range: new monaco.Range(loc.range.start.line + 1, loc.range.start.character + 1, loc.range.end.line + 1, loc.range.end.character + 1),
            };
          },
        }));

        // Shift+F12 — all usages, including cross-module ones (BSL LS advertises
        // referencesProvider; the index needs the config to be loaded).
        disposables.push(monaco.languages.registerReferenceProvider("bsl", {
          provideReferences: async (model, position, context) => {
            const uri = model.uri.toString();
            const refs = await lsp.request("textDocument/references", {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: { includeDeclaration: !!context?.includeDeclaration },
            });
            return (refs || []).map((r) => ({
              uri: monaco.Uri.parse(r.uri),
              range: new monaco.Range(r.range.start.line + 1, r.range.start.character + 1, r.range.end.line + 1, r.range.end.character + 1),
            }));
          },
        }));

        disposables.push(monaco.languages.registerDocumentHighlightProvider("bsl", {
          provideDocumentHighlights: async (model, position) => {
            const uri = model.uri.toString();
            const res = await lsp.request("textDocument/documentHighlight", {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            return (res || []).map((h) => ({
              range: new monaco.Range(h.range.start.line + 1, h.range.start.character + 1, h.range.end.line + 1, h.range.end.character + 1),
              kind: h.kind === 1 ? monaco.languages.DocumentHighlightKind.Text : h.kind === 2 ? monaco.languages.DocumentHighlightKind.Read : monaco.languages.DocumentHighlightKind.Write,
            }));
          },
        }));

        disposables.push(monaco.languages.registerDocumentFormattingEditProvider("bsl", {
          provideDocumentFormattingEdits: async (model) => {
            const uri = model.uri.toString();
            const edits = await lsp.request("textDocument/formatting", {
              textDocument: { uri },
              options: { tabSize: 4, insertSpaces: true },
            });
            return (edits || []).map((e) => ({
              range: new monaco.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1),
              text: e.newText,
            }));
          },
        }));

        // didChange (full sync, debounced)
        let changeTimer = null;
        disposables.push(editor.onDidChangeModelContent(() => {
          const model = editor.getModel();
          const uri = model.uri.toString();
          clearTimeout(changeTimer);
          changeTimer = setTimeout(() => {
            lsp.notify("textDocument/didChange", {
              textDocument: { uri, version: model.getVersionId() },
              contentChanges: [{ text: model.getValue() }],
            });
            refreshGitDecorations();
          }, 400);
        }));

        // A file may already be open (opened before the LSP finished booting) —
        // sync it to the server now.
        const model = editor.getModel();
        if (model && /^file:/.test(model.uri.toString())) {
          lsp.notify("textDocument/didOpen", {
            textDocument: { uri: model.uri.toString(), languageId: "bsl", version: 1, text: model.getValue() },
          });
        }

        return () => {
          clearTimeout(changeTimer);
          disposables.forEach((d) => { if (d && typeof d.dispose === "function") d.dispose(); });
        };
      }, [monacoReady, lspReady]);

      useEffect(() => { loadDir(""); refreshGit(); }, [loadDir, refreshGit]);

      // Debounced search (files: /bsl/search, metadata: /bsl/meta/search).
      useEffect(() => {
        const q = search.trim();
        if (!q) { setSearchResults([]); return; }
        let alive = true;
        const t = setTimeout(async () => {
          try {
            const url = mode === "meta" ? "/bsl/meta/search?q=" : "/bsl/search?q=";
            const data = await fetchJson(url + encodeURIComponent(q));
            if (alive) setSearchResults(data.results || []);
          } catch {
            if (alive) setSearchResults([]);
          }
        }, 120);
        return () => { alive = false; clearTimeout(t); };
      }, [search, mode]);

      // Reveal a path in the tree: clear the search, load + expand every
      // directory from the root down to the target (inclusive), highlight it,
      // and scroll it into view so its nested files are one click away.
      const reveal = useCallback(async (fullPath) => {
        setSearch("");
        let rel = fullPath.replace(/\\/g, "/");
        const r = (rootPath || "").replace(/\\/g, "/");
        if (rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
        const segs = rel.split("/").filter(Boolean);
        let current = rootPath;
        const newExpanded = new Set(expanded);
        const loaded = new Set(children.keys());
        for (const seg of segs) {
          const dirPath = joinPath(current, seg);
          if (!loaded.has(dirPath)) await loadDir(dirPath);
          loaded.add(dirPath);
          newExpanded.add(dirPath);
          current = dirPath;
        }
        setExpanded(newExpanded);
        setHighlightPath(fullPath);
      }, [rootPath, expanded, children, loadDir]);

      // ── Metadata tree (1C): lazy load + expand/collapse ────────────────
      const loadMeta = useCallback(async (key) => {
        setMetaLoading(true);
        try {
          const data = await fetchJson("/bsl/meta/list?p=" + encodeURIComponent(key || ""));
          if (!data.ok) throw new Error(data.error || "meta error");
          setMetaChildren((prev) => { const m = new Map(prev); m.set(key || "", data.items || []); return m; });
          setMetaError("");
          return data;
        } catch (e) {
          setMetaError(e?.message || String(e));
          return null;
        } finally {
          setMetaLoading(false);
        }
      }, []);

      const metaToggle = useCallback(async (key) => {
        if (metaExpanded.has(key)) {
          setMetaExpanded((prev) => { const s = new Set(prev); s.delete(key); return s; });
        } else {
          setMetaExpanded((prev) => new Set(prev).add(key));
          if (!metaChildren.has(key)) await loadMeta(key);
        }
      }, [metaExpanded, metaChildren, loadMeta]);

      // On first switch to metadata mode: fetch status and the root group list.
      useEffect(() => {
        if (mode !== "meta" || metaInfo) return;
        let alive = true;
        (async () => {
          try {
            const st = await fetchJson("/bsl/meta/status");
            if (!alive) return;
            setMetaInfo(st);
            if (st.ok) {
              if (!metaChildren.has("")) await loadMeta("");
            }
          } catch (e) {
            if (alive) setMetaInfo({ ok: false, error: String(e) });
          }
        })();
        return () => { alive = false; };
      }, [mode, metaInfo, metaChildren, loadMeta]);

      // Reveal a metadata node: expand every ancestor segment, then highlight.
      // «Общие» is a virtual parent for common-type groups (Общие модули, …),
      // so its segment must be walked too — otherwise the row never renders
      // and the scroll/highlight silently misses.
      const revealMeta = useCallback(async (key) => {
        setSearch("");
        const segs = String(key || "").split("/").filter(Boolean);
        const rootItems = metaChildren.get("") || [];
        const common = rootItems.find((g) => g.key === "Общие");
        const commonDirs = new Set((common?.children || []).map((c) => c.key));
        const chain = [];
        for (const seg of segs) {
          if (chain.length === 0 && commonDirs.has(seg)) chain.push("Общие");
          chain.push(chain.length ? chain[chain.length - 1] + "/" + seg : seg);
        }
        const newExpanded = new Set(metaExpanded);
        const loaded = new Set(metaChildren.keys());
        for (const acc of chain) {
          if (!loaded.has(acc)) await loadMeta(acc);
          loaded.add(acc);
          newExpanded.add(acc);
        }
        setMetaExpanded(newExpanded);
        setMetaHighlight(key);
      }, [metaExpanded, metaChildren, loadMeta]);

      const META_FORMAT_LABEL = { edt: "EDT", xml: "XML-выгрузка", object: "пообъектная выгрузка" };

      // Scroll the highlighted row into view once it renders (after expand).
      useEffect(() => {
        if (!highlightPath) return;
        const list = treeBodyRef.current?.querySelectorAll("[data-path]");
        if (!list) return;
        for (const el of list) {
          if (el.dataset.path === highlightPath) {
            el.scrollIntoView({ block: "nearest", behavior: "smooth" });
            break;
          }
        }
      }, [highlightPath, expanded, children, search]);

      // Same for metadata-mode highlight — scroll ONLY when the highlighted
      // node changes (not on every expand/collapse, which made the view
      // "jump back" to a stale highlight).
      const metaScrollRef = useRef(null);
      useEffect(() => {
        if (!metaHighlight || metaHighlight === metaScrollRef.current) return;
        const list = treeBodyRef.current?.querySelectorAll("[data-meta-path]");
        let found = false;
        if (list) {
          for (const el of list) {
            if (el.dataset.metaPath === metaHighlight) {
              el.scrollIntoView({ block: "nearest", behavior: "smooth" });
              found = true;
              break;
            }
          }
        }
        // Only mark as scrolled when the row actually rendered — otherwise
        // retry on the next state change.
        if (found) metaScrollRef.current = metaHighlight;
      }, [metaHighlight, metaExpanded, metaChildren, search]);

      // Close the context menu on Escape.
      useEffect(() => {
        if (!ctxMenu) return;
        const onKey = (e) => { if (e.key === "Escape") setCtxMenu(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [ctxMenu]);

      // Drag the divider between tree and editor to resize the tree.
      const startDrag = useCallback((e) => {
        e.preventDefault();
        draggingRef.current = true;
        const rootLeft = rootRef.current?.getBoundingClientRect().left ?? 0;
        const onMove = (ev) => {
          if (!draggingRef.current) return;
          const w = Math.min(640, Math.max(180, ev.clientX - rootLeft));
          setTreeWidth(w);
        };
        const onUp = () => {
          draggingRef.current = false;
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }, []);

      const gitBadge = (fullPath, type) => {
        if (!fullPath || type !== "file") return null;
        let rel = fullPath.replace(/\\/g, "/");
        if (rootPath) {
          const r = rootPath.replace(/\\/g, "/");
          if (rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
        }
        const st = gitFiles.get(rel);
        if (!st) return null;
        return jsx("span", { style: { color: st === "M" ? "#e2c08d" : st === "A" ? "#4caf50" : st === "D" ? "#f44336" : "#8a8a8a", marginLeft: 6, fontSize: 11 }, children: st || "?" });
      };

      const renderLevel = (dirPath, depth) => {
        const list = children.get(dirPath) || [];
        return list.map((e) => {
          const isDir = e.type === "directory";
          const full = joinPath(dirPath, e.name);
          const isOpen = isDir && expanded.has(full);
          return jsxs(React.Fragment, {
            key: full,
            children: [
              jsx("div", {
                className: "dsh-bsl-row",
                "data-path": full,
                onClick: () => (isDir ? toggle(full) : openFile(full)),
                style: {
                  boxSizing: "border-box",
                  width: "100%",
                  maxWidth: "100%",
                  height: 34,
                  font: "var(--dsw-font-s-14)",
                  color: "var(--dsw-alias-label-primary)",
                  textAlign: "left",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  borderRadius: 8,
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px",
                  paddingLeft: depth * 22 + 6,
                  display: "flex",
                  background: full === highlightPath ? "var(--dsw-alias-interactive-bg-hover)" : undefined,
                  boxShadow: full === highlightPath ? "inset 2px 0 0 var(--dsw-alias-state-business-primary)" : undefined,
                },
                children: [
                  isDir
                    ? iconBox(coloredFolder(isOpen))
                    : iconBox(coloredFile(e.name)),
                  jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: e.name }),
                  gitBadge(full, e.type),
                ],
              }),
              isOpen && children.has(full) ? renderLevel(full, depth + 1) : null,
            ],
          });
        });
      };

      const renderSearchResults = () => {
        if (!search.trim()) return null;
        if (!searchResults.length) {
          return jsx("div", { style: { padding: "6px 10px", fontSize: 12, opacity: 0.6 }, children: "Ничего не найдено" });
        }
        if (mode === "meta") {
          // Metadata search results: { key, label, icon } → reveal in tree.
          return searchResults.map((r) => jsxs("div", {
            key: r.key ?? r.label,
            className: "dsh-bsl-row",
            onClick: () => (r.file ? (openFile(r.file), setMetaHighlight(r.file)) : revealMeta(r.key)),
            style: {
              boxSizing: "border-box", width: "100%", maxWidth: "100%", height: 34,
              font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
              textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
              borderRadius: 8, alignItems: "center", gap: 6, padding: "0 8px",
              display: "flex",
            },
            children: [
              iconBox(metaIcon(r.icon)),
              jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: r.label }),
              jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5, whiteSpace: "nowrap" }, children: r.path || r.key }),            ],
          }));
        }
        return searchResults.map((r) => {
          const isDir = r.type === "directory";
          return jsxs("div", {
            key: r.path,
            className: "dsh-bsl-row",
            onClick: () => (isDir ? reveal(r.path) : openFile(r.path)),
            style: {
              boxSizing: "border-box", width: "100%", maxWidth: "100%", height: 34,
              font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
              textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
              borderRadius: 8, alignItems: "center", gap: 6, padding: "0 8px",
              display: "flex",
            },
            children: [
              isDir
                ? iconBox(coloredFolder(true))
                : iconBox(coloredFile(r.name)),
              jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: r.name }),
              jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5, whiteSpace: "nowrap" }, children: r.rel }),
            ],
          });
        });
      };

      // 1C metadata icons come from the host's /bsl/icons route (dark set).
      const metaIcon = (name) => jsx("img", {
        src: "/bsl/icons/" + (name || "common") + ".svg",
        width: 16, height: 16,
        style: { flexShrink: 0, display: "block" },
        alt: "",
        onError: (e) => { e.currentTarget.style.visibility = "hidden"; },
      });

      const metaRowStyle = (active) => ({
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        height: 34,
        font: "var(--dsw-font-s-14)",
        color: "var(--dsw-alias-label-primary)",
        textAlign: "left",
        cursor: "pointer",
        whiteSpace: "nowrap",
        borderRadius: 8,
        alignItems: "center",
        gap: 6,
        padding: "0 8px",
        display: "flex",
        background: active ? "var(--dsw-alias-interactive-bg-hover)" : undefined,
        boxShadow: active ? "inset 2px 0 0 var(--dsw-alias-state-business-primary)" : undefined,
      });

      const renderMetaRows = (items, depth) => (items || []).map((item) => {
        const full = item.key;
        const nodeId = full ?? item.file; // leafs highlight by their file path
        const isOpen = full != null && metaExpanded.has(full);
        const isActive = metaHighlight != null && nodeId === metaHighlight;
        const onClick = item.file
          ? () => { openFile(item.file); setMetaHighlight(nodeId); }
          : full
          ? () => { metaToggle(full); setMetaHighlight(nodeId); }
          : item.xmlFile
          ? () => {
              // Empty editor with a centered notice — no floating popup.
              if (modelRef.current) { modelRef.current.dispose?.(); modelRef.current = null; }
              if (editorRef.current) editorRef.current.setModel(null);
              setEditorNotice("Модуль «" + item.label + "» не найден.\nОткройте XML правой кнопкой мыши.");
              setMetaHighlight(nodeId);
            }
          : undefined;
        const onCtx = (e) => {
          if (!item.file && !item.xmlFile) return;
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, item });
        };
        const sub = isOpen
          ? metaChildren.has(full)
            ? renderMetaLevel(full, depth + 1)
            : item.items && item.items.length
            ? renderMetaRows(item.items, depth + 1)
            : null
          : null;
        return jsxs(React.Fragment, {
          key: full ?? item.label + ":" + (item.file || ""),
          children: [
            jsx("div", {
              className: "dsh-bsl-row",
              "data-meta-path": nodeId ?? "",
              onClick,
              onContextMenu: onCtx,
              style: {
                ...metaRowStyle(isActive),
                paddingLeft: depth * 22 + 6,
              },
              children: [
                iconBox(metaIcon(item.icon)),
                jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: item.label }),
                item.hint ? jsx("span", { style: { marginLeft: 6, fontSize: 11, opacity: 0.55, flexShrink: 0, fontStyle: "italic" }, children: item.hint }) : null,
                item.count ? jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5 }, children: item.count }) : null,
                gitBadge(item.file, "file"),
              ],
            }),
            sub,
          ],
        });
      });

      const renderMetaLevel = (key, depth) => renderMetaRows(metaChildren.get(key) || [], depth);

      const renderMetaTree = () => {
        if (metaInfo && !metaInfo.ok) {
          return jsx("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: "Метаданные: " + (metaInfo.error || "не найдены") });
        }
        if (metaError) {
          return jsx("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: "Ошибка: " + metaError });
        }
        if (metaLoading && !metaChildren.has("")) {
          return jsx("div", { style: { padding: "4px 10px", fontSize: 12, opacity: 0.6 }, children: "Загрузка метаданных…" });
        }
        if (!metaChildren.has("")) return null;
        return renderMetaLevel("", 0);
      };

      return jsxs("div", { ref: rootRef, "data-conversation-composer-overlay": "", style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, width: "100%", background: "var(--dsw-alias-bg-base)", overflow: "hidden" }, children: [
        // Status bar — top strip, in flow, visible in both files and metadata
        // modes. Click retries a failed LSP connection; settings live in
        // DSH Settings → «1С-редактор».
        jsx("div", {
          onClick: () => { if (!lspReady) setLspAttempt((n) => n + 1); },
          title: lspReady ? "bsl-language-server подключён" : lspError ? "Нажмите, чтобы повторить подключение (настройки: Settings → 1С-редактор)" : "Запуск bsl-language-server…",
          style: {
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 24,
            padding: "0 12px",
            fontSize: 11,
            color: cfg && !cfg.lspEnabled ? "#8a8a8a" : lspReady ? "#4caf50" : lspError ? "#f44336" : "#ffb300",
            background: "var(--dsw-alias-bg-layer-2)",
            borderBottom: "1px solid var(--dsw-alias-border-l2)",
            cursor: lspReady ? "default" : "pointer",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
          children: cfg && !cfg.lspEnabled ? "LSP выключен в настройках" : lspReady ? "● LSP готов" : lspError ? "✕ LSP: " + lspError + " — нажмите для повтора" : "○ LSP подключение…",
        }),
        jsxs("div", { style: { display: "flex", flex: 1, minHeight: 0, minWidth: 0 }, children: [
          jsxs("div", { style: { width: treeWidth, display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }, children: [
          jsxs("div", { style: { padding: "2px 6px 6px", flexShrink: 0 }, children: [
            jsx("div", { style: { padding: "0 4px 6px", fontSize: 12, opacity: 0.7 }, children: mode === "meta"
              ? (metaInfo?.ok ? (metaInfo.configName || "Конфигурация") + " · " + (META_FORMAT_LABEL[metaInfo.format] || metaInfo.format) : "Метаданные 1С")
              : (rootTitle || "Проект") }),
            jsxs("div", { style: { display: "flex", gap: 4, padding: "0 4px 8px" }, children: [
              jsx("button", {
                onClick: () => { setMode("files"); setEditorNotice(null); },
                style: {
                  flex: 1, height: 26, border: "none", borderRadius: 8, cursor: "pointer",
                  font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
                  background: mode === "files" ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  opacity: mode === "files" ? 1 : 0.6,
                },
                children: "Файлы",
              }),
              jsx("button", {
                onClick: () => { setMode("meta"); setEditorNotice(null); },
                style: {
                  flex: 1, height: 26, border: "none", borderRadius: 8, cursor: "pointer",
                  font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
                  background: mode === "meta" ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  opacity: mode === "meta" ? 1 : 0.6,
                },
                children: "Метаданные",
              }),
            ]}),
            jsx("input", {
              type: "text",
              placeholder: mode === "meta" ? "Поиск по метаданным…" : "Поиск по имени файла…",
              value: search,
              onChange: (e) => setSearch(e.target.value),
              style: {
                boxSizing: "border-box", width: "100%", height: 28,
                padding: "0 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)",
                background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)",
                font: "var(--dsw-font-s-14)", outline: "none",
              },
            }),
          ]}),
          jsx("div", { ref: treeBodyRef, style: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 6px 8px", paddingBottom: "calc(var(--dsh-composer-height, 152px) + 16px)" }, children: search.trim()
            ? renderSearchResults()
            : mode === "meta"
            ? renderMetaTree()
            : jsxs(React.Fragment, { children: [
                treeError ? jsx("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: "Ошибка: " + treeError }) : null,
                !rootPath && !treeError ? jsx("div", { style: { padding: "4px 10px", fontSize: 12, opacity: 0.6 }, children: "Загрузка…" }) : null,
                renderLevel(rootPath, 0),
              ] }) }),
        ]}),
        jsx("div", {
          onMouseDown: startDrag,
          className: "dsh-bsl-resizer",
          style: { width: 4, flexShrink: 0, cursor: "col-resize", minHeight: 0 },
        }),
                jsx("div", { ref: containerRef, style: { flex: 1, minWidth: 0, position: "relative" }, children: [
          !monacoReady ? jsx("div", { style: { padding: 16, opacity: 0.6, fontSize: 13, whiteSpace: "pre-wrap" }, children: monacoError ? "Ошибка загрузки редактора:\n" + monacoError : "Загрузка редактора…" }) : null,
          editorNotice ? jsx("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, padding: 24, textAlign: "center", font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-secondary, #8a94a6)", opacity: 0.8, pointerEvents: "none", whiteSpace: "pre-wrap" }, children: editorNotice }) : null,
        ]}),
        ]}),
        ctxMenu ? jsxs(React.Fragment, { children: [
          jsx("div", { style: { position: "fixed", inset: 0, zIndex: 2147482900, background: "transparent" }, onMouseDown: () => setCtxMenu(null), onContextMenu: (e) => { e.preventDefault(); setCtxMenu(null); } }),
          jsx("div", {
            onMouseDown: (e) => e.stopPropagation(),
            style: {
              position: "fixed",
              left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 210),
              top: Math.min(ctxMenu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 130),
              minWidth: 190,
              zIndex: 2147482901,
              background: "var(--dsw-alias-bg-layer-2)",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 10,
              boxShadow: "0 8px 30px rgba(0,0,0,.45)",
              padding: 4,
              font: "var(--dsw-font-s-14)",
              color: "var(--dsw-alias-label-primary)",
            },
            children: [
              ctxMenu.item.file ? jsx("div", { className: "dsh-bsl-menu-item", onClick: () => { openFile(ctxMenu.item.file); setCtxMenu(null); }, style: { padding: "6px 10px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }, children: "Открыть файл" }) : null,
              ctxMenu.item.xmlFile ? jsx("div", { className: "dsh-bsl-menu-item", onClick: () => { openFile(ctxMenu.item.xmlFile); setCtxMenu(null); }, style: { padding: "6px 10px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }, children: "Открыть XML" }) : null,
            ],
          }),
        ]}) : null,
      ]});
    }

    class EditorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      render() {
        if (this.state.err) {
          return jsx("div", {
            style: { padding: 16, color: "#f44336", fontSize: 13, whiteSpace: "pre-wrap", fontFamily: "monospace" },
            children: "RENDER ERROR: " + (this.state.err?.message || String(this.state.err)) + "\n\n" + (this.state.err?.stack || ""),
          });
        }
        return jsx(EditorView, {});
      }
    }

    // Settings section shown in DSH Settings (nav item «1С-редактор») — the
    // single config source is the host (/bsl/config, persisted on save).
    function PluginSettingsSection() {
      const [cfg, setCfg] = React.useState(null);
      const [form, setForm] = React.useState({ lspEnabled: true, serverPort: 8025, serverBin: "" });
      const [saved, setSaved] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        fetchJson("/bsl/config").then((c) => { if (alive) setCfg(c); }).catch(() => {});
        return () => { alive = false; };
      }, []);
      React.useEffect(() => {
        if (cfg) setForm({ lspEnabled: cfg.lspEnabled !== false, serverPort: cfg.serverPort || 8025, serverBin: cfg.serverBin || "" });
      }, [cfg]);
      const save = async () => {
        try {
          await fetchJson("/bsl/config-save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lspEnabled: form.lspEnabled, serverPort: form.serverPort, serverBin: form.serverBin }),
          });
          setCfg((c) => ({ ...(c || {}), lspEnabled: form.lspEnabled, serverPort: form.serverPort, serverBin: form.serverBin }));
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        } catch (e) {
          console.error("[dsh-bsl-editor] settings save", e);
        }
      };
      const inputStyle = { boxSizing: "border-box", width: "100%", height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "inherit", font: "var(--dsw-font-s-14)" };
      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }, children: [
        jsx("div", { style: { opacity: 0.7 }, children: "Плагин 1С-редактора: файловое дерево, метаданные, Monaco + bsl-language-server" }),
        jsxs("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, children: [
          jsx("input", { type: "checkbox", checked: form.lspEnabled, onChange: (e) => setForm((f) => ({ ...f, lspEnabled: e.target.checked })) }),
          "LSP (диагностика, автодополнение, переходы)",
        ]}),
        jsxs("label", { style: { display: "block" }, children: [
          jsx("div", { style: { marginBottom: 4, opacity: 0.7 }, children: "Порт сервера" }),
          jsx("input", { type: "number", value: form.serverPort, onChange: (e) => setForm((f) => ({ ...f, serverPort: Number(e.target.value) || 8025 })), style: inputStyle }),
        ]}),
        jsxs("label", { style: { display: "block" }, children: [
          jsx("div", { style: { marginBottom: 4, opacity: 0.7 }, children: "Путь к bsl-language-server.exe" }),
          jsx("input", { type: "text", value: form.serverBin, onChange: (e) => setForm((f) => ({ ...f, serverBin: e.target.value })), placeholder: "(пусто = стандартное место установки)", style: inputStyle }),
          jsx("div", { style: { marginTop: 3, opacity: 0.55, fontSize: 11, lineHeight: 1.4 }, children: "Укажите полный путь к exe, если сервер установлен не туда, где ожидается. Стандартное место после установки bsl-language-server_win.zip:" }),
          jsx("code", { style: { display: "block", marginTop: 2, opacity: 0.7, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }, children: "%LOCALAPPDATA%\\Programs\\bsl-language-server\\bsl-language-server\\bsl-language-server.exe" }),
        ]}),
        jsx("div", { style: { display: "flex", alignItems: "center", gap: 10 }, children: [
          jsx("button", { onClick: save, style: { height: 28, padding: "0 16px", border: "none", borderRadius: 8, cursor: "pointer", background: "var(--dsw-alias-state-business-primary, #3964fe)", color: "#fff", font: "var(--dsw-font-s-14)" }, children: "Сохранить" }),
          saved ? jsx("span", { style: { color: "#4caf50", fontSize: 12 }, children: "Сохранено" }) : null,
          jsx("span", { style: { opacity: 0.6, fontSize: 11 }, children: "Соединение LSP обновится при открытии вкладки редактора" }),
        ]}),
      ]});
    }

    function apply(ctx) {
      ctx.slots.inject(
        "conversation.view",
        () => ctx.slots.register(
          { name: "conversation.view", id: "dsh-bsl-editor", order: 15, label: () => "Editor", registrant: "dsh-bsl-editor" },
          EditorBoundary,
        ),
      );
      ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register(
          { name: "settings.section", id: "dsh-bsl-editor", order: 50, label: () => "1С-редактор", registrant: "dsh-bsl-editor" },
          PluginSettingsSection,
        ),
      );
    }

    const inject = ["slots"];
    return { apply, inject };
  },
});
