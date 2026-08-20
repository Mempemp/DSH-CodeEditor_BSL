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

    const MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";
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

    // ── Monaco (CDN) ──────────────────────────────────────────────────────
    let monacoPromise = null;
    function ensureMonaco() {
      if (monacoPromise) return monacoPromise;
      monacoPromise = new Promise((resolve, reject) => {
        if (window.monaco) return resolve(window.monaco);
        const loader = document.createElement("script");
        loader.src = MONACO_BASE + "/loader.js";
        loader.onload = () => {
          window.require.config({ paths: { vs: MONACO_BASE } });
          window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
        };
        loader.onerror = () => reject(new Error("monaco CDN unreachable"));
        document.head.appendChild(loader);
      });
      return monacoPromise;
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
              resolve();
            } catch (e) {
              reject(e);
            }
          };
          ws.onerror = (e) => reject(new Error("ws error"));
          ws.onmessage = (ev) => this._handle(JSON.parse(ev.data));
          ws.onclose = () => {};
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
          this.pending.set(id, { resolve, reject });
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      }
      notify(method, params) {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
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

      const joinPath = (parent, name) => parent + (parent.endsWith("/") || parent.endsWith("\\") ? "" : "\\") + name;

      const editorRef = useRef(null);
      const monacoRef = useRef(null);
      const modelRef = useRef(null);
      const lspRef = useRef(null);
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
          st.textContent = ".dsh-bsl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-bsl-resizer{background:transparent;transition:background .12s}.dsh-bsl-resizer:hover{background:var(--dsw-alias-state-business-primary)}";
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

      // create the Monaco editor once
      useEffect(() => {
        let alive = true;
        ensureMonaco().then((monaco) => {
          if (!alive || !containerRef.current) return;
          monacoRef.current = monaco;
          monaco.languages.register({ id: "bsl" });
          monaco.languages.setMonarchTokensProvider("bsl", bslMonarch());
          monaco.languages.setLanguageConfiguration("bsl", { comments: { lineComment: "//" } });
          const editor = monaco.editor.create(containerRef.current, {
            value: "",
            language: "bsl",
            theme: "vs-dark",
            automaticLayout: true,
            minimap: { enabled: true },
            fontSize: 14,
          });
          editorRef.current = editor;
          if (alive) setMonacoReady(true);

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

          const disposables = [];

          if (lspRef.current) {
            lspRef.current.onDiagnostics = (uri, diags) => {
              const model = editor.getModel();
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
                const items = await lspRef.current.request("textDocument/completion", {
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
                const res = await lspRef.current.request("textDocument/hover", {
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
                const res = await lspRef.current.request("textDocument/definition", {
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

            disposables.push(monaco.languages.registerDocumentFormattingEditProvider("bsl", {
              provideDocumentFormattingEdits: async (model) => {
                const uri = model.uri.toString();
                const edits = await lspRef.current.request("textDocument/formatting", {
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
                lspRef.current.notify("textDocument/didChange", {
                  textDocument: { uri, version: model.getVersionId() },
                  contentChanges: [{ text: model.getValue() }],
                });
                refreshGitDecorations();
              }, 400);
            }));
          }

          disposables.forEach(() => {});
          return () => { alive = false; editor.dispose(); };
        }).catch((e) => console.error("[dsh-bsl-editor] monaco", e));
        return () => { alive = false; };
      }, []);

      // Pin the editor root to the DSH scroll body's actual height. DSH lays the
      // conversation view out inside `.scrollBody` (overflow: hidden auto); in the
      // "active" composer phase the intermediate `.viewArea` switches to
      // `flex: 1 0 auto; min-height: auto` (it grows to content), which would let
      // our tree + Monaco grow unbounded and fight the browser scrollbar. Measuring
      // the nearest scroll ancestor and pinning our height to it makes the tree the
      // ONLY scroller in every phase.
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        let scrollAncestor = null;
        const findScroll = () => {
          let n = el.parentElement;
          while (n) {
            const oy = window.getComputedStyle(n).overflowY;
            if (oy === "auto" || oy === "scroll") return n;
            n = n.parentElement;
          }
          return null;
        };
        const fit = () => {
          if (!scrollAncestor) scrollAncestor = findScroll();
          if (!scrollAncestor) return;
          // The composer seat is the scroll body's trailing child; reserve its
          // height so the editor fills everything above it and never pushes the
          // browser scrollbar. (Slot anchors are display:contents, so the view
          // area lays out as a direct flex child of the scroll body.)
          let reserve = 0;
          for (const c of scrollAncestor.children) {
            if (!c.contains(el)) reserve = Math.max(reserve, c.offsetHeight);
          }
          const h = Math.max(0, scrollAncestor.clientHeight - reserve);
          if (h > 0 && el.style.height !== h + "px") el.style.height = h + "px";
        };
        fit();
        const ro = new ResizeObserver(fit);
        if (scrollAncestor) ro.observe(scrollAncestor);
        if (el.parentElement && el.parentElement !== scrollAncestor) ro.observe(el.parentElement);
        window.addEventListener("resize", fit);
        return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
      }, []);

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

      useEffect(() => { loadDir(""); refreshGit(); }, [loadDir, refreshGit]);

      // Debounced file-name search (backed by the host's /bsl/search route).
      useEffect(() => {
        const q = search.trim();
        if (!q) { setSearchResults([]); return; }
        let alive = true;
        const t = setTimeout(async () => {
          try {
            const data = await fetchJson("/bsl/search?q=" + encodeURIComponent(q));
            if (alive) setSearchResults(data.results || []);
          } catch {
            if (alive) setSearchResults([]);
          }
        }, 120);
        return () => { alive = false; clearTimeout(t); };
      }, [search]);

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
        if (type !== "file") return null;
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

      return jsxs("div", { ref: rootRef, style: { display: "flex", height: "100%", minHeight: 0, minWidth: 0, width: "100%", background: "var(--dsw-alias-bg-base)", overflow: "hidden" }, children: [
        jsxs("div", { style: { width: treeWidth, display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }, children: [
          jsxs("div", { style: { padding: "2px 6px 6px", flexShrink: 0 }, children: [
            jsx("div", { style: { padding: "0 4px 6px", fontSize: 12, opacity: 0.7 }, children: rootTitle || "Проект" }),
            jsx("input", {
              type: "text",
              placeholder: "Поиск по имени файла…",
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
          jsx("div", { ref: treeBodyRef, style: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 6px 8px" }, children: search.trim()
            ? renderSearchResults()
            : jsxs(React.Fragment, { children: [
                jsx("div", { style: { padding: "0 10px 4px", fontSize: 11, color: "#8a8a8a" }, children: "LSP: выключен" }),
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
          !monacoReady ? jsx("div", { style: { padding: 16, opacity: 0.6, fontSize: 13 }, children: "Загрузка редактора…" }) : null,
        ]}),
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

    function apply(ctx) {
      ctx.slots.inject(
        "conversation.view",
        () => ctx.slots.register(
          { name: "conversation.view", id: "dsh-bsl-editor", order: 15, label: () => "Editor", registrant: "dsh-bsl-editor" },
          EditorBoundary,
        ),
      );
    }

    const inject = ["slots"];
    return { apply, inject };
  },
});
