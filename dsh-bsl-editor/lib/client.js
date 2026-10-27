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

    // Сколько висит подсказка сверху, если человек её не закрыл. Дольше — мешает:
    // сообщение о результате человек читает один раз.
    const NOTICE_MS = 5000;
    // Сколько подсказка затухает, прежде чем её уберут с экрана. Тот же порядок,
    // что у появления: 200 мс — переход виден, но не задерживает.
    const NOTICE_FADE_MS = 200;
    // Крестик закрытия у плашки сообщения.
    const NOTICE_CLOSE_CSS = { pointerEvents: "auto", flexShrink: 0, cursor: "pointer", opacity: 0.55, padding: "0 2px", lineHeight: 1 };

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

    // Client cordis ctx (captured in apply) — reach the composer through its
    // public provide-channel instead of poking at the DOM.
    let chatCtx = null;

    // Send a code reference into the DSH chat. Since dsh 0.1.2 the composer
    // draft lives in a shell-owned Lexical editor — raw DOM insertion into the
    // contenteditable silently does nothing (no error, draft unchanged), which
    // is why the old textarea/DOM path "succeeded" without sending anything.
    // Primary path: conversation.input.setDraft (same provide-channel that
    // dsh-better-sidebar uses). Fallback: clipboard + composer focus.
    function sendToChat(sessionId, text) {
      const inserted = (() => {
        try {
          if (!chatCtx || !sessionId) return false;
          if (typeof chatCtx.sessions?.scope !== "function") return false;
          const actx = chatCtx.sessions.scope(sessionId);
          const conversation = chatCtx.get("conversation");
          if (!actx || !conversation) return false;
          const input = conversation.input && typeof conversation.input.for === "function"
            ? conversation.input.for(actx)
            : undefined;
          if (!input || typeof input.setDraft !== "function") return false;
          const snap = input.state && typeof input.state.getSnapshot === "function"
            ? input.state.getSnapshot()
            : null;
          const draft = snap && typeof snap === "object" ? snap.draft || "" : "";
          // Ссылка с ведущим переносом: в непустом черновике не приклеивается
          // к предыдущему тексту.
          input.setDraft(draft ? draft + "\n" + text : text);
          return true;
        } catch (e) {
          console.warn("[dsh-bsl-editor] composer insert failed:", e);
          return false;
        }
      })();
      if (inserted) {
        showToast("Ссылка вставлена в чат");
        return;
      }
      // Fallback: clipboard всегда (надёжно), плюс фокус на композер.
      const ref = "\n" + text;
      try { navigator.clipboard?.writeText(ref); } catch {}
      const seat = document.querySelector("[data-composer-seat]");
      const editable = (seat || document).querySelector('[contenteditable="true"], textarea, [role="textbox"]');
      if (editable) { try { editable.focus(); } catch {} }
      showToast("Ссылка скопирована — вставьте в чат (Ctrl+V)");
    }

    // Monaco: сначала same-origin vendor (/bsl/vendor), затем CDN как запасной.
    // Vendor-файлы кладутся в resources/vendor при сборке плагина.
    const MONACO_BASES = [
      "/bsl/vendor",
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

    // Причину называет хост — её надо прочитать и на ошибке: без этого на экране
    // оставалось голое «HTTP 400», по которому нельзя понять, что случилось
    // (нет git, папка не выгрузка 1С, файл не текстовый, в индексе пусто).
    async function errorFromResponse(res) {
      let body = null;
      try { body = await res.json(); } catch {}
      const err = new Error(String((body && (body.error || body.detail)) || ("HTTP " + res.status)));
      err.status = res.status;
      err.body = body;
      return err;
    }

    async function fetchJson(url, opts) {
      const res = await fetch(url, opts);
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    }

    // Identifier (with dotted module prefixes) under the cursor, e.g.
    // «АБСП_HTTPСервисЗапросы.ОбработатьЗапрос» for F12.
    function wordAt(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const left = line.slice(0, position.column - 1);
      const right = line.slice(position.column - 1);
      const ml = left.match(/[\wА-Яа-яЁё]+(?:\.[\wА-Яа-яЁё]+)*\.?$/);
      const mr = right.match(/^[\wА-Яа-яЁё]*/);
      const w = (ml ? ml[0] : "") + (mr ? mr[0] : "");
      return w.replace(/\.$/, "").trim() || null;
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
        for (const base of MONACO_BASES) {
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
                // Worker: same-origin vendor, чтобы воркеры не зависели от CDN.
                // Внутри blob-воркера относительные URL не резолвятся —
                // подставляем полный origin.
                if (base === "/bsl/vendor") {
                  const origin = location.origin;
                  window.MonacoEnvironment = {
                    getWorkerUrl: () => URL.createObjectURL(new Blob(
                      ["self.MonacoEnvironment={baseUrl:'" + origin + "/bsl/vendor/'};importScripts('" + origin + "/bsl/vendor/workerMain.js');"],
                      { type: "text/javascript" })),
                  };
                }
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
    //
    // onigasm.loadWASM may run exactly ONCE per page, but the editor mounts
    // again on every session switch (DSH recreates the component), so the
    // whole TM stack (onigasm + grammar registry) is a module-level singleton:
    // the first wireTmGrammar call loads it, later calls reuse the loaded
    // grammar and only re-register the tokens provider on the new Monaco.
    let tmStackPromise = null;
    // onigasm's loadWASM is strictly once per page: its ESM module is cached
    // by the browser, so a RETRY after a partial failure would hit an already
    // initialized instance and throw "subsequent calls are not allowed",
    // poisoning every later mount. Keep this promise forever — only the
    // grammar/registry half of the stack is allowed to retry.
    let onigasmReadyPromise = null;
    // ESM-модули сначала с same-origin vendor, затем CDN.
    async function importFirst(urls) {
      let lastErr = null;
      for (const u of urls) {
        try { return await import(/* @vite-ignore */ u); } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("all sources failed");
    }
    function getOnigasmReady() {
      if (!onigasmReadyPromise) {
        onigasmReadyPromise = (async () => {
          const onigasm = await importFirst([
            "/bsl/vendor/onigasm-esm.js?v=2",
            "https://cdn.jsdelivr.net/npm/onigasm@2.2.2/+esm",
          ]);
          const wasmUrls = [
            "/bsl/vendor/onigasm.wasm?v=2",
            "https://cdn.jsdelivr.net/npm/onigasm@2.2.2/lib/onigasm.wasm",
            "https://esm.sh/onigasm@2.2.2/lib/onigasm.wasm",
          ];
          let wasm = null;
          for (const u of wasmUrls) {
            try {
              const r = await fetch(u);
              if (r.ok) { wasm = await r.arrayBuffer(); break; }
            } catch {}
          }
          if (!wasm) throw new Error("onigasm.wasm недоступен");
          try {
            await onigasm.loadWASM(wasm);
          } catch (e) {
            // Already initialized by a previous page-lifetime attempt — fine.
            if (!/subsequent calls|already/i.test(String(e?.message || e))) throw e;
          }
          return onigasm;
        })();
        // A failed attempt (wasm not reachable yet) may be retried later:
        // since "subsequent calls" is swallowed above, a retry can only hit
        // an uninitialized instance — safe to loadWASM again.
        onigasmReadyPromise.catch(() => { onigasmReadyPromise = null; });
      }
      return onigasmReadyPromise;
    }
    function getTmStack() {
      if (!tmStackPromise) {
        tmStackPromise = (async () => {
          const onigasm = await getOnigasmReady();
          const tm = await importFirst([
            "/bsl/vendor/monaco-textmate-esm.js?v=2",
            "https://cdn.jsdelivr.net/npm/monaco-textmate@3.0.1/+esm",
            "https://esm.sh/monaco-textmate@3.0.1",
          ]);
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
          if (!grammar) throw new Error("grammar load failed");
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
          return { tm, grammar, TokenizerState };
        })();
        // A failed first attempt must not poison the singleton forever —
        // the next mount (or a transient CDN blip) gets a fresh try.
        tmStackPromise.catch(() => { tmStackPromise = null; });
      }
      return tmStackPromise;
    }

    async function wireTmGrammar(monaco) {
      try {
        const { tm, grammar, TokenizerState } = await getTmStack();
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

    // Editor state survives session switches: DSH remounts the conversation
    // view under key={sessionId} on every chat switch (component-local state
    // is destroyed by construction), so each session's UI state lives in a
    // module-level map keyed by sessionId and is snapshotted on unmount.
    const defaultPersist = () => ({
      mode: "files",
      children: new Map(),      // dirPath -> entries[]
      expanded: new Set(),      // expanded dirPaths
      rootPath: "",
      openPath: null,
      openContent: "",
      dirty: false,
      search: "",
      highlightPath: null,
      treeWidth: 280,
      gitFilter: null,          // null | "*" — null = все файлы, "*" = только изменённые
      tabs: [],                 // открытые вкладки (absolute paths, в порядке открытия)
      openBuffers: new Map(),   // path -> unsaved content (для табов с правками)
      metaChildren: new Map(),  // nodeKey -> items[]
      metaExpanded: new Set(),  // expanded nodeKeys
      metaInfo: null,
      metaError: "",
      metaHighlight: null,
      cursor: null,             // { lineNumber, column } — Monaco position
      scrollTop: 0,             // Monaco vertical scroll
      treeScrollTop: 0,         // file/metadata tree vertical scroll
    });
    const editorPersistBySession = new Map(); // sessionId -> persist snapshot

    // Мост apply ↔ EditorView: перехватчик openPath живёт на уровне модуля,
    // а openFile/reveal — внутри компонента. EditorView присваивает bridge
    // в эффекте после монтирования и чистит при размонтировании.
    let editorBridge = null;
    // Открытия, пришедшие когда вкладка Editor не смонтирована (пользователь
    // в чате): применяются при следующем монтировании EditorView.
    let pendingOpens = [];

    // Канонический путь вкладок: обратные слеши → прямые, диск в верхний регистр.
    function normPath(p) {
      let s = String(p || "").replace(/\\/g, "/");
      if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
      return s;
    }

    // Корень воркспейса плагина (/bsl/workspaces → root), кэшируется.
    let wsRootCache = "";
    async function getWsRoot() {
      if (wsRootCache) return wsRootCache;
      try {
        const data = await fetchJson("/bsl/workspaces");
        wsRootCache = data.root ? String(data.root) : "";
      } catch {}
      return wsRootCache;
    }

    // Путь из чата → абсолютный канонический путь внутри корня, либо null.
    // Относительные пути резолвятся от cwd активной сессии (её же использует
    // чат в resolveWorkspacePath), с откатом на корень воркспейса; абсолют —
    // как есть. Проверка принадлежности корню — как в resolveInside хоста.
    async function resolveChatPath(raw, base) {
      let p = String(raw ?? "").trim();
      if (!p) return null;
      p = p.replace(/^file:\/\/\//, "");
      const root = await getWsRoot();
      if (!root || !/^[a-zA-Z]:[\\/]/.test(root)) return null;
      const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
      const baseNorm = base && /^[a-zA-Z]:[\\/]/.test(base)
        ? String(base).replace(/\\/g, "/").replace(/\/+$/, "")
        : rootNorm;
      let abs = p.replace(/\\/g, "/");
      if (!/^[a-zA-Z]:\//.test(abs)) {
        abs = baseNorm + "/" + abs.replace(/^\.\//, "").replace(/^\/+/, "");
      }
      // Схлопнуть "." и "..", затем проверить, что путь не вышел за корень.
      const parts = [];
      for (const seg of abs.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg && seg !== ".") parts.push(seg);
      }
      abs = parts.join("/");
      if (!(abs.toLowerCase() === rootNorm.toLowerCase() || abs.toLowerCase().startsWith(rootNorm.toLowerCase() + "/"))) return null;
      return normPath(abs);
    }

    // Тихий клик по табу «Editor» (таб-бар рендерится только когда вкладок > 1).
    function switchToEditorTab() {
      const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
      for (const t of tabs) {
        if ((t.textContent || "").trim() === "Editor") { t.click(); return; }
      }
    }

    // Короткий хеш содержимого изменения (FNV-1a): по нему изменение опознаётся между
    // перерисовками — номера строк при правках выше по файлу «плывут», а текст
    // изменения остаётся тем же.
    function hashChunk(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    }

    // Слияние отметок «просмотрено». Ответ сервера НЕ затирает то, что уже
    // отмечено здесь: запрос мог уйти раньше нашей записи отметки (запись —
    // «выстрелил и забыл»), и тогда принятый изменение возвращался в счётчик, а
    // следующая запись уносила на диск уже урезанный набор. Смена HEAD —
    // единственный законный сброс: сравнивать становится не с чем.
    function mergeReviewedHashes(prevHashes, prevHeadSha, serverHashes, serverHeadSha) {
      const merged = new Set(Array.isArray(serverHashes) ? serverHashes : []);
      if (serverHeadSha && prevHeadSha && serverHeadSha !== prevHeadSha) return merged;
      for (const id of prevHashes || []) merged.add(id);
      return merged;
    }

    // Русская форма слова при числе: 1 изменение, 2 изменения, 5 изменений.
    function pluralRu(n, one, few, many) {
      const n10 = n % 10;
      const n100 = n % 100;
      if (n10 === 1 && n100 !== 11) return one;
      if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
      return many;
    }
    const changesWord = (n) => pluralRu(n, "изменение", "изменения", "изменений");

    // Что сказать человеку про «В индекс». Слова здесь те же, что на экране:
    // «изменение» — блок правки, который отмечают кнопкой «Принять», «индекс» —
    // то, куда ведёт сама кнопка. Своих внутренних слов («изменение», «не совпало»)
    // в тексте нет: человек не знает, что так что-то называется внутри, и
    // читает их как вырванные из контекста.
    function stageReasonText(data) {
      const d = data || {};
      const parts = [];
      if (d.staged) parts.push(d.untracked ? "Новый файл добавлен в индекс целиком" : "В индекс отправлено " + d.staged + " " + changesWord(d.staged));
      if (d.inIndex) parts.push(d.staged ? "ещё " + d.inIndex + " " + changesWord(d.inIndex) + " были в индексе раньше" : d.inIndex + " " + changesWord(d.inIndex) + " уже в индексе");
      if (d.skipped) parts.push(d.skipped + " " + changesWord(d.skipped) + " отправить не удалось — файл правился после просмотра, обновите вид и отметьте их заново");
      if (parts.length) return parts.join("; ");
      if (d.reason === "no-marks") return "Нет просмотренных изменений — отметьте их кнопкой «Принять»";
      if (d.reason === "no-match") return "Отправлять нечего: изменений, которые вы отметили, в файле уже нет — обновите вид и отметьте заново";
      return "Отправлять нечего";
    }

    // То же для кнопки по всем изменённым файлам.
    function stageAllReasonText(data) {
      const d = data || {};
      if (Array.isArray(d.failed) && d.failed.length) return "Не удалось отправить: " + d.failed.join("; ");
      const parts = [];
      if (d.staged) parts.push("В индекс отправлено " + d.staged + " " + changesWord(d.staged));
      if (d.skipped) parts.push(d.skipped + " " + changesWord(d.skipped) + " отправить не удалось — файлы правились после просмотра, обновите вид");
      if (parts.length) return parts.join("; ");
      if (d.already && !d.noMarks) return "Все просмотренные изменения уже в индексе";
      if (d.noMarks) return "Нет просмотренных изменений — отметьте их кнопкой «Принять»";
      if (d.inIndex) return d.inIndex + " " + changesWord(d.inIndex) + " уже в индексе";
      if (d.noMatch) return "Просмотренные изменения отправить не удалось — файлы правились после просмотра, обновите вид";
      return "Отправлять нечего";
    }

    // Разбор unified diff на изменения. Каждый изменение знает: свой номер внутри
    // источника (для отката), строку «@@» (сверка перед откатом), строки новой
    // версии с добавленным текстом, блоки удалённых строк и хеш содержимого
    // (отметка «просмотрено»). source: "index" — изменение из индекса (git add),
    // "worktree" — из рабочей копии; откатываются они по-разному.
    function parseDiffHunks(diff, source) {
      const lines = String(diff || "").split("\n");
      // Дифф кончается переводом строки: в конце остаётся пустой «хвост». Если его
      // не отбросить, он прилипает к ПОСЛЕДНЕМУ изменению в файле — и у того же
      // изменения в другом диффе (там оно не последнее) отпечаток получается другим.
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const hunks = [];
      let cur = null;
      let index = -1;
      for (const l of lines) {
        if (l.startsWith("@@")) {
          const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
          if (!m) continue;
          index += 1;
          const newStart = parseInt(m[3], 10);
          cur = {
            source,
            index,
            header: l,
            newStart,
            newLine: newStart,
            added: [],        // текст добавленных строк
            addedLines: [],   // их номера в новой версии
            delRuns: [],      // [{ afterLine, lines[] }] — блоки удалённых строк
            // Тело изменения — строки БЕЗ заголовка «@@»: по нему считается
            // отпечаток отметки. Номера в заголовке у двух диффов разные (один
            // считается от индекса, другой от HEAD), поэтому отпечаток вместе с
            // заголовком не находил своё же изменение в индексе после отправки.
            text: [],
          };
          hunks.push(cur);
          continue;
        }
        if (!cur) continue;
        cur.text.push(l);
        if (l.startsWith("+")) {
          cur.addedLines.push(cur.newLine);
          cur.added.push(l.slice(1));
          cur.newLine += 1;
          cur.prevKind = "+";
        } else if (l.startsWith("-")) {
          // Подряд идущие удалённые строки — ОДИН блок: он рисуется одной
          // зоной, а разрыв блока даёт отдельную зону на своём месте.
          if (cur.prevKind !== "-") cur.delRuns.push({ afterLine: cur.newLine, lines: [] });
          cur.delRuns[cur.delRuns.length - 1].lines.push(l.slice(1));
          cur.prevKind = "-";
        } else if (l.startsWith(" ")) {
          cur.newLine += 1;
          cur.prevKind = " ";
        }
      }
      for (const h of hunks) {
        // Якорь изменения (кнопки и стрелки) — первая ИЗМЕНЁННАЯ строка: у изменения с
        // добавлениями это первая добавленная, у чистого удаления — строка под
        // красным блоком. Заголовок @@ отсчитывается от первой строки КОНТЕКСТА
        // (git даёт три), поэтому по нему якорь уводил на три строки выше.
        h.anchorLine = h.addedLines.length
          ? Math.min(...h.addedLines)
          : Math.max(1, h.delRuns.length ? h.delRuns[0].afterLine : h.newStart);
        // Хеш отметки — по СОДЕРЖИМОСТИ изменения, без источника: одна и та же
        // правка в индексе и в рабочей копии должна считаться одной и той же,
        // иначе после индексации она снова выглядит непросмотренной.
        h.id = hashChunk(h.delRuns.map((r) => r.lines.join("\n")).join("\u0001") + "\u0000" + h.added.join("\n"));
        // Тело изменения (без заголовка «@@») — по нему хост отбирает, что
        // уходит в индекс, и по нему же отмечает уже отправленное.
        h.text = h.text.join("\n");
      }
      return hunks;
    }

    // Раскладка кнопок «Отклонить/Принять» по вертикали. Правки, стоящие вплотную
    // (лишняя пустая строка, перенос строки из таба), дают по паре кнопок на каждую,
    // и пары наезжали друг на друга — это читается как сломанный интерфейс.
    // items: [{ top, h }] — желаемое место и высота кнопок каждого изменения.
    // Возвращает для каждого изменения итоговое место и признак «помещается в окно».
    // Функция чистая: её считает тест tests/_layout.mjs.
    function layoutHunkWidgets(items, viewH, gap = 2) {
      const order = items.map((it, i) => ({ i, top: it.top, h: it.h })).sort((a, b) => a.top - b.top || a.i - b.i);
      const out = new Array(items.length);
      let floor = -Infinity;
      for (const p of order) {
        const top = Math.max(p.top, floor);
        out[p.i] = { top, show: top >= 0 && top + p.h <= viewH - 1 };
        floor = top + p.h + gap;
      }
      return out;
    }

    function EditorView(props) {
      // DSH hands every session-scoped entry its sessionId as a prop; the
      // persisted state is looked up per session so each chat keeps its own
      // editor context (file, tree, caret) across switches.
      const sessionId = props.sessionId;
      let editorPersist = sessionId ? editorPersistBySession.get(sessionId) : null;
      if (!editorPersist) {
        editorPersist = defaultPersist();
        if (sessionId) editorPersistBySession.set(sessionId, editorPersist);
      }
      const [children, setChildren] = useState(() => new Map(editorPersist.children)); // dirPath -> entries[]
      const [expanded, setExpanded] = useState(() => new Set(editorPersist.expanded)); // expanded dirPaths
      const [rootPath, setRootPath] = useState(editorPersist.rootPath); // workspace root dir
      const [openPath, setOpenPath] = useState(editorPersist.openPath);
      const [openContent, setOpenContent] = useState(editorPersist.openContent);
      const [dirty, setDirty] = useState(editorPersist.dirty);
      const [saving, setSaving] = useState(false);
      const [saveError, setSaveError] = useState("");
      const [gitFiles, setGitFiles] = useState(new Map());
      // Почему список изменений пуст: "no-git" | "no-repo" | "status-failed" | "".
      // Без этого пустой список читается как «изменений нет», хотя git может
      // быть просто не найден.
      const [gitWhy, setGitWhy] = useState("");
      const [gitLoading, setGitLoading] = useState(false); // читаем список изменений
      const [gitDetail, setGitDetail] = useState(""); // что сказал сам git
      const [gitInitBusy, setGitInitBusy] = useState(false);
      const [gitInitError, setGitInitError] = useState("");
      const [rootTitle, setRootTitle] = useState("");
      const [treeError, setTreeError] = useState("");
      const [loadingDirs, setLoadingDirs] = useState(() => new Set()); // какие каталоги читаются прямо сейчас
      const [refreshBusy, setRefreshBusy] = useState(false); // идёт «Обновить дерево»
      const [monacoReady, setMonacoReady] = useState(false);
      const [search, setSearch] = useState(editorPersist.search);
      const [searchResults, setSearchResults] = useState([]);
      const [highlightPath, setHighlightPath] = useState(editorPersist.highlightPath);
      const [treeWidth, setTreeWidth] = useState(editorPersist.treeWidth);
      const [gitFilter, setGitFilter] = useState(editorPersist.gitFilter);
      const [tabs, setTabs] = useState(editorPersist.tabs);

      // Metadata-tree mode: "files" (fs tree) | "meta" (1C metadata tree).
      const [mode, setMode] = useState(editorPersist.mode);
      const [metaChildren, setMetaChildren] = useState(() => new Map(editorPersist.metaChildren)); // nodeKey -> items[]
      const [metaExpanded, setMetaExpanded] = useState(() => new Set(editorPersist.metaExpanded)); // expanded nodeKeys
      const [metaInfo, setMetaInfo] = useState(editorPersist.metaInfo); // /bsl/meta/status result
      const [metaError, setMetaError] = useState(editorPersist.metaError);
      const [metaLoadingKey, setMetaLoadingKey] = useState(null); // какой узел метаданных читается
      const [metaLoading, setMetaLoading] = useState(false);
      const [metaHighlight, setMetaHighlight] = useState(editorPersist.metaHighlight);
      const [editorNotice, setEditorNotice] = useState(null); // transient banner over the editor
      const [noticeSticky, setNoticeSticky] = useState(false); // у плашки есть кнопка действия
      const [noticeLeaving, setNoticeLeaving] = useState(false); // плашка затухает перед уборкой
      // Подсказка сверху гаснет сама: плашка, которая висит, пока её не сменит
      // следующее действие, читается как поломка («ошибка появилась и висит не
      // уходя»). Не гаснет только карточка с кнопкой — она ждёт решения человека.
      // И появление, и исчезновение — с переходом: рывок на экране читается как
      // сбой отрисовки.
      const noticeTimerRef = useRef(null); // авто-скрытие
      const noticeFadeRef = useRef(null); // затухание перед уборкой
      const fadeNoticeOut = useCallback(() => {
        if (noticeFadeRef.current) clearTimeout(noticeFadeRef.current);
        setNoticeLeaving(true);
        noticeFadeRef.current = setTimeout(() => {
          noticeFadeRef.current = null;
          setEditorNotice(null);
          setNoticeLeaving(false);
        }, NOTICE_FADE_MS);
      }, []);
      // sticky — сообщение, которое гаснет только по решению человека (у него
      // есть кнопка действия: «Перезагрузить с диска»).
      const showNotice = useCallback((text, sticky = false) => {
        if (noticeTimerRef.current) {
          clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = null;
        }
        if (noticeFadeRef.current) {
          clearTimeout(noticeFadeRef.current);
          noticeFadeRef.current = null;
        }
        setNoticeLeaving(false); // новое сообщение отменяет затухание прежнего
        setEditorNotice(text || null);
        setNoticeSticky(!!text && !!sticky);
        if (!text || sticky) return;
        noticeTimerRef.current = setTimeout(() => {
          noticeTimerRef.current = null;
          fadeNoticeOut();
        }, NOTICE_MS);
      }, [fadeNoticeOut]);
      const closeNotice = useCallback(() => {
        externalReloadRef.current = null;
        if (noticeTimerRef.current) {
          clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = null;
        }
        fadeNoticeOut();
      }, [fadeNoticeOut]);
      useEffect(() => () => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        if (noticeFadeRef.current) clearTimeout(noticeFadeRef.current);
      }, []);
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
      const dirtySubRef = useRef(null); // monaco model onDidChangeContent subscription
      const lspRef = useRef(null);
      const autoRetriesRef = useRef(0); // bounded auto-reconnect counter for LSP
      const containerRef = useRef(null);
      const addedDecoIdsRef = useRef([]);
      const diffZoneIdsRef = useRef([]);
      const rootRef = useRef(null);
      const treeBodyRef = useRef(null);
      const draggingRef = useRef(false);
      const rootPathRef = useRef("");
      const openPathRef = useRef(editorPersist.openPath || "");
      const mouseInEditorRef = useRef(false);
      const staticNavRef = useRef(null); // { word, targets, index } for F12 cycling
      const f12BoundRef = useRef(null); // editor.addCommand id — bind F12 once
      const diffNavRef = useRef({ anchors: [], index: -1 }); // якоря изменений + текущий индекс (вне useState — без ререндеров)
      const diffWidgetRef = useRef(null); // overlay-виджет навигации { dom, label }
      const navigateDiffRef = useRef(null);
      // Изменения диффа открытого файла — сырьё для вида: «принять»/«отклонить»
      // перерисовывают вид отсюда, без нового запроса к git.
      const diffHunksRef = useRef([]);
      // Отметки «просмотрено»: headSha + хеши принятых изменений + показывать ли
      // их (по умолчанию скрыты — в файле видно только непросмотренное).
      const reviewedRef = useRef({ headSha: "", hashes: new Set(), show: false });
      const hunkWidgetsRef = useRef([]); // overlay-виджеты «Отклонить/Принять» по изменениям
      // Пока запрос к хосту в пути, кнопки изменений выключены: нажатие вторым
      // порядком отправляло устаревший номер изменения, хост отвечал «файл
      // изменился — обновите вид», и это читалось как сломанный интерфейс.
      const hunkBusyRef = useRef(false);
      const placeHunkWidgetsRef = useRef(null); // расстановка этих кнопок по строкам
      const acceptHunkRef = useRef(null);
      const rejectHunkRef = useRef(null);
      const resetDiffViewRef = useRef(null); // снять вид диффа (и шапку) — зовётся при закрытии файла
      const rejectAllTimerRef = useRef(null); // сброс «подтверждения» для «Отклонить все»
      const rejectAllArmedRef = useRef(false); // первый клик по «Отклонить все» уже сделан
      const [diffState, setDiffState] = useState({ total: 0, unresolved: 0, reviewed: 0, show: false });
      const [commitOpen, setCommitOpen] = useState(false);
      const [commitMsg, setCommitMsg] = useState("");
      const [commitBusy, setCommitBusy] = useState(false);
      const [commitError, setCommitError] = useState("");
      const [commitFiles, setCommitFiles] = useState([]);
      const [stageAllBusy, setStageAllBusy] = useState(false);
      const [rejectAllArmed, setRejectAllArmed] = useState(false);
      useEffect(() => { rootPathRef.current = rootPath; }, [rootPath]);
      useEffect(() => { openPathRef.current = openPath; }, [openPath]);
      const dirtyRef = useRef(false);
      useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

      // Mirror the whole UI state into editorPersist so an unmount/remount
      // (session switch) restores exactly where the user left off.
      useEffect(() => {
        editorPersist.mode = mode;
        editorPersist.children = children;
        editorPersist.expanded = expanded;
        editorPersist.rootPath = rootPath;
        editorPersist.openPath = openPath;
        // Keep the buffer only when there are unsaved edits — otherwise the
        // file is re-read from disk on restore, and we don't hold a stale
        // copy of every visited file in memory.
        editorPersist.openContent = dirty ? openContent : "";
        editorPersist.dirty = dirty;
        editorPersist.search = search;
        editorPersist.highlightPath = highlightPath;
        editorPersist.treeWidth = treeWidth;
        editorPersist.gitFilter = gitFilter;
        // Tabs + per-tab dirty buffers survive session switches.
        editorPersist.tabs = tabs;
        editorPersist.openBuffers = openBuffersRef.current;
        editorPersist.metaChildren = metaChildren;
        editorPersist.metaExpanded = metaExpanded;
        editorPersist.metaInfo = metaInfo;
        editorPersist.metaError = metaError;
        editorPersist.metaHighlight = metaHighlight;
      }, [mode, children, expanded, rootPath, openPath, openContent, dirty, search, highlightPath, treeWidth, gitFilter, metaChildren, metaExpanded, metaInfo, metaError, metaHighlight]);

      // Snapshot the Monaco caret + scroll position at unmount time. This
      // effect's cleanup runs BEFORE the Monaco effect's cleanup (declared
      // earlier), so the editor instance is still alive when we read it.
      useEffect(() => {
        return () => {
          const ed = editorRef.current;
          if (ed && typeof ed.isDisposed === "function" && !ed.isDisposed()) {
            const pos = ed.getPosition();
            if (pos) editorPersist.cursor = { lineNumber: pos.lineNumber, column: pos.column };
            editorPersist.scrollTop = ed.getScrollTop() || 0;
          }
          const treeBody = treeBodyRef.current;
          if (treeBody) editorPersist.treeScrollTop = treeBody.scrollTop || 0;
        };
      }, []);

      // Fetch the workspace title. LSP is intentionally deferred — the editor
      // works as a file browser + Monaco (syntax highlighting) on its own.
      useEffect(() => {
        if (!document.querySelector("style[data-dsh-bsl-tree-css]")) {
          const st = document.createElement("style");
          st.setAttribute("data-dsh-bsl-tree-css", "1");
          st.textContent = ".dsh-bsl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-bsl-resizer{background:transparent;transition:background .12s}.dsh-bsl-resizer:hover{background:var(--dsw-alias-state-business-primary)}.dsh-bsl-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}"
            + ".bsl-git-added-line{background:rgba(46,160,67,.15);box-shadow:inset 2px 0 0 rgba(46,160,67,.4)}"
            + ".bsl-git-del-zone{background:rgba(248,81,73,.12);overflow:hidden}"
            + ".bsl-git-del-line{color:#f88f8a;font-family:var(--monaco-monospace-font,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:14px;line-height:20px;white-space:pre;text-overflow:clip;overflow:hidden}"
            // Принятый (просмотренный) изменение — приглушённый серый: подсветка не
            // мозолит глаза, но правку ещё видно.
            + ".bsl-git-reviewed-line{background:rgba(138,148,166,.13);box-shadow:inset 2px 0 0 rgba(138,148,166,.35)}"
            + ".bsl-git-reviewed-zone{background:rgba(138,148,166,.10)}"
            + ".bsl-git-reviewed-zone .bsl-git-del-line{color:#9aa3b2}"
            // Кнопки у изменения — overlay-виджеты: по горизонтали прижимаются
            // вправо (за вычетом миникарты, её ширину плагин кладёт в
            // --bsl-hunk-right), по вертикали их ставит placeHunkWidgets.
            + ".bsl-hunk-actions{position:absolute;left:auto!important;right:var(--bsl-hunk-right,26px)!important;display:inline-flex;align-items:center;gap:6px;padding-bottom:3px;pointer-events:auto}"
            + ".bsl-hunk-btn{font-family:var(--dsw-font-family,inherit);font-size:12px;font-weight:500;line-height:18px;height:20px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-2,#22242a);color:var(--dsw-alias-label-secondary,#8a94a6);cursor:pointer;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.25)}"
            + ".bsl-hunk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
            + ".bsl-hunk-btn--reject:hover{background:rgba(248,81,73,.18);border-color:rgba(248,81,73,.55);color:#f88f8a}"
            + ".bsl-hunk-btn--accept:hover{background:rgba(46,160,67,.18);border-color:rgba(46,160,67,.55);color:#7ee2a8}"
            + ".bsl-hunk-btn--armed{background:rgba(248,81,73,.22)!important;border-color:rgba(248,81,73,.6)!important;color:#f88f8a!important}"
            + ".bsl-git-flash{animation:bsl-git-flash-kf .6s ease-out}@keyframes bsl-git-flash-kf{from{background:rgba(255,220,90,.35)}to{background:transparent}}"
            // Ожидание чтения: на большой выгрузке папка открывается секундами,
            // и без индикатора клик выглядел как «ничего не произошло».
            + "@keyframes bsl-spin-kf{to{transform:rotate(360deg)}}"
            + ".bsl-spin{animation:bsl-spin-kf .8s linear infinite}"
            + ".bsl-spinner{display:inline-block;flex-shrink:0;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;opacity:.7;animation:bsl-spin-kf .8s linear infinite}"
            + ".bsl-loading{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;opacity:.65}"
            // Плашка MCP-менеджера (чужой плагин, классы dm-*) висит в том же
            // правом верхнем углу, где стоят кнопки файла, и закрывает их.
            // Сдвигаем плашку ниже полосы вкладок: своей настройкой плагин
            // положение не сохраняет. Панель двигаем вместе с плашкой, иначе
            // они разъезжаются.
            + ".bsl-hunk-btn:disabled{opacity:.5;cursor:default}"
            + ".bsl-commit-box{display:flex;flex-direction:column;gap:6px;margin:0 4px 8px;padding:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#22242a)}"
            + ".bsl-commit-list{max-height:110px;overflow:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#8a94a6)}"
            + ".bsl-commit-row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
            + ".bsl-commit-msg{box-sizing:border-box;width:100%;min-height:54px;resize:vertical;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-1,#1b1d22);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.4}"
            + ".bsl-commit-error{font-size:12px;color:#f44336}"
            + ".bsl-commit-note{font-size:12px;color:var(--dsw-alias-label-secondary,#8a94a6)}"
            // Иконки метаданных нарисованы светлыми глифами (#F0EFF1 на #656565):
            // на тёмном фоне читаются, на светлом сливаются с ним. Инверсия
            // яркости держит их контраст (#313131 на #929292) и не трогает
            // тёмную тему.
            + "body:not([data-ds-dark-theme]) .bsl-meta-icon{filter:invert(.85)}"
            + ".dm-float,.dm-float-panel{top:84px!important}"
            // Подсказка редактора: тонкой полоской сверху, под полосой вкладок, и
            // сама гаснет (NOTICE_MS). По центру поверх кода она закрывала ровно ту
            // строку, к которой относилась, и читалась как помеха.
            + ".bsl-notice{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:10;max-width:calc(100% - 24px);display:flex;justify-content:center;pointer-events:none}"
            + ".bsl-notice-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:10px;padding:6px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 14px rgba(0,0,0,.35);text-align:left;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);white-space:pre-wrap;animation:bsl-notice-in .16s ease-out}"
            // Затухание перед уборкой: исчезать рывком — то же самое, что появляться
            // рывком. Анимируется сама плашка, а не контейнер: у контейнера
            // transform:translateX(-50%), и keyframes с transform:none сносят центровку.
            + ".bsl-notice-leaving .bsl-notice-pill{animation:bsl-notice-out .2s ease-in forwards}"
            + "@keyframes bsl-notice-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}"
            + "@keyframes bsl-notice-out{to{opacity:0;transform:translateY(-6px)}}";
          document.head.appendChild(st);
        }
        let alive = true;
        (async () => {
          try {
            const ws = await fetchJson("/bsl/workspaces");
            if (alive && ws.title) setRootTitle(ws.title);
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
            if (alive) setCfg({ lspEnabled: false, serverPort: 8025, serverBin: "", sourceExtensions: [".bsl", ".os"], workspaceDir: "" });
          });
        return () => { alive = false; };
      }, []);

      // LSP: ensure bsl-language-server is running (the host spawns it on
      // demand, JVM+Tomcat boot takes 2-10s) and connect the WebSocket client.
      // The editor stays fully usable meanwhile — providers are wired in a
      // separate effect once BOTH Monaco and LSP are ready. Bumping lspAttempt
      // (status-bar click) or changing settings re-runs this whole sequence.
      useEffect(() => {
        // Master switch: LSP off — or config not loaded yet — stand down.
        // (cfg === null on first mount: the fetch below is still in flight;
        // starting the server before knowing the switch state would spawn
        // BSL even with lspEnabled: false.)
        if (!cfg || !cfg.lspEnabled) {
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
                { token: "keyword", foreground: "F92672" },
                { token: "keyword.operator", foreground: "F92672" },
                { token: "keyword.other.preprocessor", foreground: "F92672" },
                { token: "storage.type", foreground: "66D9EF", fontStyle: "italic" },
                { token: "storage.modifier", foreground: "F92672" },
                { token: "support.function", foreground: "66D9EF" },
                { token: "support.class", foreground: "66D9EF" },
                { token: "entity.name.function", foreground: "A6E22E" },
                { token: "entity.name.section", foreground: "A6E22E" },
                { token: "string.quoted.double", foreground: "E6DB74" },
                { token: "constant.numeric", foreground: "AE81FF" },
                { token: "constant.language", foreground: "AE81FF" },
                { token: "comment", foreground: "88846F", fontStyle: "italic" },
                { token: "variable", foreground: "F8F8F2" },
                { token: "invalid", foreground: "F44747" },
              ],
              // Monokai (VS Code theme-monokai) editor surface colors. The
              // field must exist even when inheriting everything from the base
              // theme (missing colors = crash on editor.create in 0.52+).
              colors: {
                "editor.background": "#272822",
                "editor.foreground": "#F8F8F2",
                "editorLineNumber.foreground": "#90908A",
                "editorCursor.foreground": "#F8F8F0",
                "editor.selectionBackground": "#878B9180",
                "editor.lineHighlightBackground": "#3E3D32",
                "editorWhitespace.foreground": "#464741",
                "editorIndentGuide.background": "#464741",
                "editorIndentGuide.activeBackground": "#767771",
                "editorGutter.background": "#272822",
              },
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
            // Кириллица в русском BSL-коде для Monaco — «ambiguous unicode»
            // (А/В/С/Е/О/Р похожи на латинские) и «non-basic ASCII», поэтому над
            // редактором висит баннер на каждом файле с русскими комментариями и
            // строками запросов. Обе проверки выключаем. Подсветку невидимых
            // символов (неразрывный пробел, zero-width) оставляем включённой:
            // в 1С они действительно ломают код и ищутся глазами плохо.
            // Опция принимается ТОЛЬКО вложенным объектом (IUnicodeHighlightOptions
            // из monaco.d.ts): плоские ключи вида "unicodeHighlight.ambiguousCharacters"
            // валидатор опций молча игнорирует, и баннер остаётся.
            unicodeHighlight: {
              ambiguousCharacters: false,
              nonBasicASCII: false,
              invisibleCharacters: true,
            },
          });
          editorRef.current = editor;
          if (alive) setMonacoReady(true);
          // No file selected yet: detach the empty model and show a hint
          // instead of a lonely first line.
          if (!openPathRef.current) {
            editor.setModel(null);
            showNotice("Выберите файл из дерева");
          }
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
              sendToChat(sessionId, ref);
            },
          });

          // Ctrl+A (и другие хоткеи с модификатором): когда мышь над областью
          // редактора, но фокус в дереве/поиске — отправлять команду в Monaco,
          // а не в DSH (иначе Ctrl+A выделяет всю страницу).
          const editorHost = containerRef.current;
          const onEditorEnter = () => { mouseInEditorRef.current = true; };
          const onEditorLeave = () => { mouseInEditorRef.current = false; };
          editorHost.addEventListener("mouseenter", onEditorEnter);
          editorHost.addEventListener("mouseleave", onEditorLeave);
          const onGlobalKey = (e) => {
            if (!mouseInEditorRef.current) return;
            const k = e.key.toLowerCase();
            if (!(e.ctrlKey || e.metaKey) || (k !== "a" && k !== "s")) return;
            if (editorHost.contains(document.activeElement)) return; // фокус уже в Monaco
            e.preventDefault();
            e.stopPropagation();
            if (k === "a") {
              const ed = editorRef.current;
              if (!ed) return;
              ed.focus();
              ed.trigger("keyboard", "editor.action.selectAll", null);
            } else {
              saveFileRef.current?.();
            }
          };
          window.addEventListener("keydown", onGlobalKey, true);
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFileRef.current?.());
          editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.ArrowDown, () => navigateDiffRef.current?.(1));
          editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.ArrowUp, () => navigateDiffRef.current?.(-1));

          // Keep the persisted caret/scroll fresh in real time, not just at
          // unmount: view switches inside a session (Editor ↔ Chat) tear the
          // component down through a path where unmount cleanup can be missed,
          // so the snapshot must already be current when that happens.
          const scrollSub = editor.onDidScrollChange((e) => { editorPersist.scrollTop = e.scrollTop || 0; });
          // Скролл/клик по файлу: актуализировать счётчик дифф-навигатора
          // (ближайший якорь выше центра видимой области). Не во время
          // программного перехода (gotoAnchor сам ставит index).
          let syncingNav = false;
          const syncNavSub = editor.onDidScrollChange(() => {
            if (syncingNav) return;
            syncingNav = true;
            try { syncDiffNavRef.current?.(); placeHunkWidgetsRef.current?.(); } finally { syncingNav = false; }
          });
          // Кнопки изменений держатся за строку сами (overlay-виджет строки не
          // знает), поэтому их надо переставлять и при смене размеров редактора.
          const layoutSub = editor.onDidLayoutChange(() => { placeHunkWidgetsRef.current?.(); });
          const cursorSub = editor.onDidChangeCursorPosition((e) => {
            editorPersist.cursor = { lineNumber: e.position.lineNumber, column: e.position.column };
          });

          return () => { alive = false; scrollSub.dispose(); syncNavSub.dispose(); layoutSub.dispose(); cursorSub.dispose(); editor.dispose(); editorHost.removeEventListener("mouseenter", onEditorEnter); editorHost.removeEventListener("mouseleave", onEditorLeave); window.removeEventListener("keydown", onGlobalKey, true); };
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
        const key = path || "";
        setLoadingDirs((prev) => { const s = new Set(prev); s.add(key); return s; });
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
        } finally {
          setLoadingDirs((prev) => { const s = new Set(prev); s.delete(key); return s; });
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

      // Зеркало gitFiles для кода вне React-рендера (разметка диффа и
      // распознавание «файл ещё не в git»).
      const gitFilesRef = useRef(new Map());
      const refreshGit = useCallback(async (fresh = false) => {
        setGitLoading(true);
        try {
          // fresh=true — из кнопки «Обновить дерево»: кэш статусов на хосте
          // сбрасывается, иначе список изменённых пятисекундной давности.
          const data = await fetchJson("/bsl/git-status" + (fresh ? "?fresh=1" : ""));
          setGitWhy(data.ok ? "" : String(data.reason || ""));
          setGitDetail(data.ok ? "" : String(data.detail || ""));
          if (data.ok) {
            const m = new Map();
            for (const f of data.files) m.set(f.path, f.status);
            gitFilesRef.current = m;
            setGitFiles(m);
          }
        } catch (e) {
          // Хост отвечает 200 с причиной; 400/500 приходит исключением, но и в нём
          // есть reason/detail — иначе список молча показывал «Нет изменённых файлов».
          const body = e && e.body;
          setGitWhy(String((body && body.reason) || ""));
          setGitDetail(String((body && (body.detail || body.error)) || (e && e.message) || e || ""));
        } finally {
          setGitLoading(false);
        }
      }, []);

      // ── Tabs: multiple open files, per-tab unsaved buffers ──────────────
      // Monaco models hold each file's content (and unsaved edits) under a
      // stable URI, so switching tabs is just editor.setModel() — buffers
      // survive both tab switches and session switches. openBuffersRef
      // mirrors which tabs are dirty and keeps their text for persistence.
      const openBuffersRef = useRef(editorPersist.openBuffers instanceof Map ? editorPersist.openBuffers : new Map()); // path -> unsaved content
      const [tabDirty, setTabDirty] = useState(() => new Set(openBuffersRef.current.keys()));
      const markTabDirty = useCallback((path, isDirty, content) => {
        if (isDirty) openBuffersRef.current.set(path, content);
        else openBuffersRef.current.delete(path);
        setTabDirty((prev) => { const s = new Set(prev); isDirty ? s.add(path) : s.delete(path); return s; });
      }, []);
      // Tabs are keyed by a canonical absolute path: forward slashes, drive
      // letter upper-cased. The same file reached via tree (backslashes),
      // search results or the git list must land on ONE tab, and `openPath`
      // (the server's normalized path) must equal that key for highlighting.
      const addTab = useCallback((raw) => {
        const path = normPath(raw);
        setTabs((prev) => prev.includes(path) ? prev : [...prev, path]);
        return path;
      }, []);

      // Per-tab Monaco view state (scroll + cursor): saved on leave, restored
      // on return — switching tabs must feel like switching browser tabs.
      const viewStatesRef = useRef(new Map()); // normPath -> monaco view state

      // mtime на диске на момент загрузки модели — для hot-reload вкладок.
      const modelMtimesRef = useRef(new Map()); // normPath -> mtimeMs
      // Флаг BOM файла (UTF-8 с BOM у 1С): запоминается при чтении и
      // передаётся в /bsl/write, чтобы сохранить кодировку файла.
      const bomRef = useRef(new Map()); // normPath -> bool
      // Кодировка файла при чтении (utf-8 | windows-1251) — передаётся в
      // /bsl/write, чтобы cp1251-файлы 1С не портились при пересохранении.
      const encRef = useRef(new Map()); // normPath -> string
      // Программная навигация (F12) сама ставит позицию — view-state
      // восстанавливать не нужно (он перекрыл бы целевой переход).
      const suppressViewRestoreRef = useRef(false);
      // Путь файла, ожидающего автопереход к первому диффу после открытия.
      const freshOpenPathRef = useRef(null);
      const gotoAnchorRef = useRef(null);
      const syncDiffNavRef = useRef(null);

      // Файл изменился извне (агент/внешний редактор): чистый буфер тихо
      // перечитываем, грязный — баннер с кнопкой перезагрузки.
      // refreshGitDecorations объявлен ниже (TDZ) — доступ через ref.
      const refreshGitDecorationsRef = useRef(null);
      const checkExternalChange = useCallback(async (fullPath, model) => {
        const known = modelMtimesRef.current.get(fullPath);
        let disk;
        try {
          disk = await fetchJson("/bsl/stat?path=" + encodeURIComponent(fullPath));
        } catch { return; }
        const mtime = disk.mtimeMs ?? null;
        if (mtime == null) return;
        if (known != null && Math.abs(mtime - known) < 1) return;
        // known == null — refs пересозданы ремоунтом EditorView; модель жива,
        // но база для сравнения утрачена. Сверяем КОНТЕНТ с диском напрямую.
        const data = await fetchJson("/bsl/read?path=" + encodeURIComponent(fullPath));
        modelMtimesRef.current.set(fullPath, mtime);
        bomRef.current.set(fullPath, !!data.bom);
        encRef.current.set(fullPath, data.encoding || "utf-8");
        if (data.content === model.getValue()) return;
        const isDirty = openBuffersRef.current.has(fullPath);
        if (isDirty) {
          // Ссылку на перезагрузку ставим ДО плашки: пока она стоит, сообщение
          // не гаснет само — оно ждёт решения человека.
          externalReloadRef.current = async () => {
            try {
              const data = await fetchJson("/bsl/read?path=" + encodeURIComponent(fullPath));
              const ed = editorRef.current;
              const st = ed?.saveViewState?.();
              programmaticSetRef.current += 1;
              try { model.setValue(data.content); } finally { programmaticSetRef.current -= 1; }
              if (ed && st) {
                requestAnimationFrame(() => {
                  const e2 = editorRef.current;
                  if (e2 && !e2.isDisposed?.() && modelRef.current === model) { try { e2.restoreViewState(st); } catch {} }
                });
              }
              setOpenContent(data.content);
              markTabDirty(fullPath, false);
              setDirty(false);
              showNotice(null);
              refreshGitDecorationsRef.current?.(fullPath);
            } catch {}
          };
          showNotice("Файл изменён на диске. Ваши правки сохранены в буфере.", true);
        } else {
          const data = await fetchJson("/bsl/read?path=" + encodeURIComponent(fullPath));
          // Контент совпал (mtime обновился без изменения текста) —
          // перечитывать не нужно: setValue сбросил бы историю undo.
          if (data.content === model.getValue()) return;
          const ed = editorRef.current;
          const st = ed?.saveViewState?.();
          programmaticSetRef.current += 1;
          try { model.setValue(data.content); } finally { programmaticSetRef.current -= 1; }
          if (ed && st) {
            requestAnimationFrame(() => {
              const e2 = editorRef.current;
              if (e2 && !e2.isDisposed?.() && modelRef.current === model) { try { e2.restoreViewState(st); } catch {} }
            });
          }
          setOpenContent(data.content);
          refreshGitDecorationsRef.current?.(fullPath);
        }
      }, [markTabDirty]);
      const externalReloadRef = useRef(null);
      // Программная подмена текста (hot-reload/revert): onDidChangeContent
      // не должен считать её правкой пользователя.
      const programmaticSetRef = useRef(0);

      const openFile = useCallback(async (rawPath) => {
        // Canonical form up front: every consumer (tabs, refs, dirty map)
        // works with one spelling of the path.
        const fullPath = normPath(rawPath);
        // Drive ALL consumers (tab highlight, refs, view-state keys) from this
        // one value — it must update on every switch, not only on first open.
        setOpenPath(fullPath);
        showNotice(null);
        try {
          addTab(fullPath);
          const monaco = monacoRef.current;
          const ed = editorRef.current;
          if (!monaco || !ed) return;
          // Remember where the outgoing tab was scrolled / positioned.
          if (openPathRef.current && modelRef.current) {
            viewStatesRef.current.set(openPathRef.current, ed.saveViewState());
          }
          const uri = monaco.Uri.parse("file:///" + fullPath.replace(/\\/g, "/"));
          let model = monaco.editor.getModel(uri);
          if (!model) {
            // First open in this page: parked unsaved text wins over disk
            // (covers tabs other than the active one after a session switch).
            const parked = openBuffersRef.current.get(fullPath);
            const lang = langFor(fullPath);
            if (parked != null) {
              model = monaco.editor.createModel(parked, lang, uri);
              setOpenContent(parked);
              // Базовый mtime для parked-моделей: без него checkExternalChange
              // всегда выходит по known == null.
              fetchJson("/bsl/stat?path=" + encodeURIComponent(fullPath))
                .then((d) => { modelMtimesRef.current.set(fullPath, d.mtimeMs ?? null); })
                .catch(() => {});
              // BOM для parked-моделей тоже нужен (иначе при сохранении
              // потеряется BOM файла).
              fetchJson("/bsl/read?path=" + encodeURIComponent(fullPath))
                .then((d) => { bomRef.current.set(fullPath, !!d.bom); encRef.current.set(fullPath, d.encoding || "utf-8"); })
                .catch(() => {});
            } else {
              // Первый заход в этой сессии: после отрисовки диффов автопереход
              // к первому блоку изменений.
              freshOpenPathRef.current = fullPath;
              const data = await fetchJson("/bsl/read?path=" + encodeURIComponent(fullPath));
              model = monaco.editor.createModel(data.content, lang, uri);
              setOpenContent(data.content);
              modelMtimesRef.current.set(fullPath, data.mtimeMs ?? null);
              bomRef.current.set(fullPath, !!data.bom);
              encRef.current.set(fullPath, data.encoding || "utf-8");
              if (lspRef.current) {
                lspRef.current.notify("textDocument/didOpen", {
                  textDocument: { uri: uri.toString(), languageId: "bsl", version: 1, text: data.content },
                });
              }
            }
          } else {
            setOpenContent(model.getValue());
            checkExternalChange(fullPath, model);
          }
          modelRef.current = model;
          ed.setModel(model);
          const st = viewStatesRef.current.get(fullPath);
          if (st && !suppressViewRestoreRef.current) {
            // Apply after Monaco recomputes layout for the new model —
            // a synchronous restore gets overwritten and scroll resets.
            requestAnimationFrame(() => {
              const e2 = editorRef.current;
              if (e2 && !e2.isDisposed?.() && modelRef.current === model) {
                try { Promise.resolve(e2.restoreViewState(st)).catch(() => {}); } catch {}
              }
            });
          }
          // Track edits: park the text on EVERY change (tree clicks call
          // openFile directly, bypassing switchTab, so the buffer must always
          // be current for the tab system to be lossless).
          dirtySubRef.current?.dispose?.();
          dirtySubRef.current = model.onDidChangeContent(() => {
            if (programmaticSetRef.current > 0) return;
            setDirty(true);
            markTabDirty(fullPath, true, model.getValue());
            // Keep the persist mirror current so session switches replay
            // the latest text, not the on-disk snapshot.
            setOpenContent(model.getValue());
          });
          setDirty(openBuffersRef.current.has(fullPath));
          setSaveError("");
          refreshGitDecorations(fullPath);
        } catch (e) {
          console.error("[dsh-bsl-editor] open", e);
        }
      }, [checkExternalChange]);

      // Возврат к окну DSH: проверить активный файл на внешние изменения,
      // даже если вкладка не переключалась.
      useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState !== "visible") return;
          const p = openPathRef.current;
          const model = modelRef.current;
          if (p && model) checkExternalChange(p, model);
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        return () => {
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("focus", onVisible);
        };
      }, [checkExternalChange]);

      const switchTab = useCallback(async (path) => {
        const p = normPath(path);
        if (p === openPathRef.current) return;
        await openFile(p);
        setHighlightPath(p);
      }, [openFile]);
      const closeTab = useCallback(async (path) => {
        const rest = tabs.filter((p) => p !== path);
        setTabs(rest);
        openBuffersRef.current.delete(path);
        setTabDirty((prev) => { const s = new Set(prev); s.delete(path); return s; });
        viewStatesRef.current.delete(path);
        // Free the closed file's Monaco model (its buffer is no longer needed).
        try {
          const monaco = monacoRef.current;
          if (monaco) {
            const uri = monaco.Uri.parse("file:///" + path.replace(/\\/g, "/"));
            monaco.editor.getModel(uri)?.dispose?.();
          }
        } catch {}
        if (path === openPathRef.current) {
          const next = rest[rest.length - 1] || null;
          if (next) await openFile(next);
          else {
            setOpenPath(null);
            openPathRef.current = null;
            if (editorRef.current) editorRef.current.setModel(null);
            modelRef.current = null;
            resetDiffViewRef.current?.();
            showNotice("Выберите файл из дерева");
            setHighlightPath(null);
          }
        }
      }, [tabs, openFile]);

      // Снять вид диффа с текущей модели: зоны удалённых строк, подсветка
      // добавленных, кнопки изменений и состояние в шапке. Всё, что мы вешаем на
      // РЕДАКТОР (а не на модель), живёт до этой чистки — при смене файла его
      // надо звать, иначе чужие зоны остаются на новом файле.
      const clearDiffView = useCallback(() => {
        const ed = editorRef.current;
        diffNavRef.current.anchors = [];
        diffNavRef.current.index = -1;
        if (diffWidgetRef.current) diffWidgetRef.current.dom.style.display = "none";
        if (!ed) return;
        try {
          ed.changeViewZones((acc) => { for (const id of diffZoneIdsRef.current) acc.removeZone(id); });
        } catch {}
        diffZoneIdsRef.current = [];
        try {
          ed.deltaDecorations(addedDecoIdsRef.current, []);
        } catch {}
        addedDecoIdsRef.current = [];
        for (const w of hunkWidgetsRef.current) {
          try { ed.removeOverlayWidget(w); } catch {}
        }
        hunkWidgetsRef.current = [];
      }, []);

      // Снять вид диффа целиком, включая состояние в шапке (закрыли последний
      // файл — кнопок и счётчиков быть не должно).
      const resetDiffView = useCallback(() => {
        clearDiffView();
        diffHunksRef.current = [];
        reviewedRef.current = { headSha: "", hashes: new Set(), show: reviewedRef.current.show };
        setDiffState({ total: 0, unresolved: 0, reviewed: 0, show: reviewedRef.current.show });
      }, [clearDiffView]);
      resetDiffViewRef.current = resetDiffView;

      // Отрисовка вида диффа по готовым изменениям: подсветка добавленных строк,
      // «призраки» удалённых, кнопки «Отклонить/Принять» у каждого изменения,
      // навигатор и счётчики. Принятые изменения по умолчанию не рисуются вовсе —
      // в файле остаётся только то, что ещё не посмотрели.
      const renderDiffView = useCallback((path, hunks, lineCount, isNewUntracked) => {
        const ed = editorRef.current;
        const monaco = monacoRef.current;
        const model = ed && ed.getModel();
        if (!ed || !monaco || !model) return;
        const rev = reviewedRef.current;
        const isReviewed = (h) => rev.hashes.has(h.id);
        // Изменение, который лежит в индексе И уже посмотрен, из вида файла уходит:
        // с ним всё решено — он в индексе и ждёт коммита. Без этого нажатие
        // «В индекс» не меняло на экране ничего (тот же счётчик «Просмотрено»,
        // те же изменения) и читалось как «кнопка не работает». Непросмотренные
        // изменения из индекса остаются: их ещё можно принять или отклонить.
        const live = hunks.filter((h) => h.source !== "index" || !isReviewed(h));
        const shown = live.filter((h) => rev.show || !isReviewed(h));

        // 1. Подсветка добавленных строк (и «файл целиком», если он ещё не в git).
        const addedDecorations = [];
        if (isNewUntracked) {
          for (let ln = 1; ln <= lineCount; ln++) {
            addedDecorations.push({
              range: new monaco.Range(ln, 1, ln, 1),
              options: { isWholeLine: true, className: "bsl-git-added-line", linesDecorationsClassName: "bsl-git-added" },
            });
          }
        } else {
          for (const h of shown) {
            const reviewed = isReviewed(h);
            for (const ln of h.addedLines) {
              addedDecorations.push({
                range: new monaco.Range(ln, 1, ln, 1),
                options: {
                  isWholeLine: true,
                  className: reviewed ? "bsl-git-reviewed-line" : "bsl-git-added-line",
                  linesDecorationsClassName: reviewed ? "bsl-git-reviewed" : "bsl-git-added",
                },
              });
            }
          }
        }
        addedDecoIdsRef.current = ed.deltaDecorations(addedDecoIdsRef.current, addedDecorations);

        // 2. Зоны удалённых строк. В Monaco 0.52 у accessor нет removeAll —
        // треким id зон сами.
        const zoneIds = [];
        ed.changeViewZones(function (acc) {
          for (const id of diffZoneIdsRef.current) acc.removeZone(id);
          for (const h of shown) {
            const reviewed = isReviewed(h);
            for (const run of h.delRuns) {
              if (!run.lines.length) continue;
              const node = document.createElement("div");
              node.className = reviewed ? "bsl-git-del-zone bsl-git-reviewed-zone" : "bsl-git-del-zone";
              // Табы в тексте удалённых строк должны рендериться той же
              // ширины, что и в редакторе (браузерный дефолт — 8).
              const ts = model.getOptions?.().tabSize;
              if (ts) { node.style.tabSize = String(ts); node.style.MozTabSize = String(ts); }
              for (const text of run.lines) {
                const ln = document.createElement("div");
                ln.className = "bsl-git-del-line";
                ln.textContent = text;
                node.appendChild(ln);
              }
              zoneIds.push(acc.addZone({
                // afterLine — строка, ПЕРЕД которой стоит блок ⇒ зона после предыдущей
                afterLineNumber: Math.max(0, Math.min(run.afterLine - 1, lineCount)),
                heightInLines: run.lines.length,
                domNode: node,
              }));
            }
          }
        });
        diffZoneIdsRef.current = zoneIds;

        // 3. Навигация: один якорь на изменение — изменение и есть один визуальный блок.
        const anchors = shown
          .map((h) => ({ line: Math.max(1, Math.min(h.anchorLine, Math.max(lineCount, 1))), kind: h.addedLines.length ? "added" : "deleted" }))
          .sort((a, b) => a.line - b.line);
        diffNavRef.current.anchors = anchors;
        diffNavRef.current.index = -1;

        // 4. Плавающий навигатор ↑ N/M ↓ (правый верхний угол редактора).
        let w = diffWidgetRef.current;
        if (!w) {
          const dom = document.createElement("div");
          dom.style.cssText = "position:absolute;right:20px;top:10px;z-index:30;display:none;align-items:center;gap:2px;padding:3px 5px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1b1d22);border:1px solid var(--dsw-alias-border-l2,#3a3d45);box-shadow:0 4px 14px rgba(0,0,0,.35)";
          const btnCss = "border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:6px;width:30px;height:30px;font-size:16px;display:inline-flex;align-items:center;justify-content:center;";
          const up = document.createElement("button");
          up.style.cssText = btnCss;
          up.textContent = "↑";
          up.title = "Предыдущее изменение (Alt+↑)";
          up.onclick = () => navigateDiffRef.current?.(-1);
          const label = document.createElement("span");
          label.style.cssText = "min-width:56px;text-align:center;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;opacity:.95;pointer-events:none;user-select:none";
          const down = document.createElement("button");
          down.style.cssText = btnCss;
          down.textContent = "↓";
          down.title = "Следующее изменение (Alt+↓)";
          down.onclick = () => navigateDiffRef.current?.(1);
          dom.appendChild(up);
          dom.appendChild(label);
          dom.appendChild(down);
          ed.addOverlayWidget({ getId: () => "bsl.gitnav", getDomNode: () => dom, getPosition: () => null });
          w = { dom, label };
          diffWidgetRef.current = w;
        }
        w.dom.style.display = (anchors.length || isNewUntracked) ? "inline-flex" : "none";
        w.label.textContent = isNewUntracked ? "новый файл" : (anchors.length ? "1 / " + anchors.length : "");

        // Миникарта занимает правый край, кнопки должны встать левее неё.
        // Размер миникарты задаёт Monaco, поэтому ширину кладём в CSS-переменную.
        const hostNode = ed.getDomNode();
        if (hostNode) {
          const mini = hostNode.querySelector(".minimap");
          hostNode.style.setProperty("--bsl-hunk-right", ((mini ? mini.offsetWidth : 0) + 26) + "px");
        }

        // 5. Кнопки у каждого изменения: «Отклонить» / «Принять» (у просмотренного —
        // «Вернуть»). Ставим их overlay-виджетами, а не content-виджетами: у
        // content-виджетов система координат — бесконечное полотно строк
        // (ширина 2^24), поэтому к правому краю редактора их не прижать:
        // «right» отсчитывался от этого полотна, и кнопки уезжали далеко за
        // экран. Слой overlay-виджетов шириной с редактор, зато строку они не
        // знают — вертикаль ставит placeHunkWidgets по строке-якорю.
        for (const widget of hunkWidgetsRef.current) {
          try { ed.removeOverlayWidget(widget); } catch {}
        }
        hunkWidgetsRef.current = [];
        const mkBtn = (text, title, cls, onClick) => {
          const b = document.createElement("button");
          b.className = "bsl-hunk-btn " + cls;
          b.type = "button";
          b.textContent = text;
          b.title = title;
          b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
          b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
          // Если кнопки уже заняты запросом (перерисовка в момент отправки),
          // новая кнопка рождается выключенной: иначе нажатие пройдёт поверх.
          b.disabled = hunkBusyRef.current;
          return b;
        };
        for (const h of shown) {
          const dom = document.createElement("div");
          dom.className = "bsl-hunk-actions";
          dom.style.display = "none";
          if (isReviewed(h)) {
            dom.appendChild(mkBtn("Вернуть", "Считать изменение непросмотренным — оно вернётся в подсветку", "", () => acceptHunkRef.current?.(h, false)));
          } else {
            dom.appendChild(mkBtn("Отклонить", "Отклонить это изменение — строки вернутся к состоянию HEAD", "bsl-hunk-btn--reject", () => rejectHunkRef.current?.(h)));
            dom.appendChild(mkBtn("Принять", "Отметить изменение просмотренным — оно уйдёт из подсветки", "bsl-hunk-btn--accept", () => acceptHunkRef.current?.(h, true)));
          }
          const line = Math.max(1, Math.min(h.anchorLine, model.getLineCount()));
          // Низ блока: последняя добавленная строка, а если изменение — только
          // удаление, то строка-якорь (под ней и стоит красный блок).
          const endLine = h.addedLines.length ? Math.min(Math.max(...h.addedLines), model.getLineCount()) : line;
          const widget = {
            getId: () => "bsl.hunk." + h.source + "." + h.index + "." + h.id,
            getDomNode: () => dom,
            getPosition: () => null,
            line,
            endLine,
            h: 0,
          };
          try {
            ed.addOverlayWidget(widget);
            hunkWidgetsRef.current.push(widget);
          } catch {}
        }
        placeHunkWidgetsRef.current?.();

        // 6. Состояние для шапки (кнопки по файлу целиком). Считаем по `live`:
        // ушедшее в индекс уже не «ждущая просмотра» работа, и счётчик
        // «Просмотрено» обязан это показать — иначе нажатие «В индекс»
        // выглядит как будто ничего не произошло.
        const next = {
          total: live.length,
          unresolved: live.filter((h) => !isReviewed(h)).length,
          reviewed: live.filter(isReviewed).length,
          show: !!rev.show,
        };
        setDiffState((prev) => (prev.total === next.total && prev.unresolved === next.unresolved && prev.reviewed === next.reviewed && prev.show === next.show ? prev : next));
      }, []);

      // Кнопки изменения: overlay-виджет строки не знает, поэтому ставим их сами —
      // под блоком изменений (так просили), а если блок кончается у нижней
      // кромки и кнопки не помещаются, то над блоком. Что ушло за пределы
      // видимой области — прячем.
      const placeHunkWidgets = useCallback(() => {
        const ed = editorRef.current;
        const model = ed && ed.getModel();
        if (!ed || !model) return;
        const hostEl = ed.getDomNode && ed.getDomNode();
        const scrollTop = ed.getScrollTop() || 0;
        // Высоту видимой области берём у самого редактора: getLayoutInfo()
        // отдаёт размер, посчитанный при последней раскладке, и у редактора,
        // созданного в скрытой вкладке, он долго остаётся нулевым — из-за этого
        // кнопки уезжали под верхнюю кромку.
        const viewH = (hostEl && hostEl.clientHeight) || (ed.getLayoutInfo() || {}).height || 0;
        const lineH = (ed.getOption && ed.getOption(monacoRef.current?.editor?.EditorOption?.lineHeight)) || 20;
        const items = [];
        for (const w of hunkWidgetsRef.current) {
          const dom = w.getDomNode();
          if (!dom) continue;
          // Высоту кнопок меряем один раз: замер заставляет браузер
          // пересчитывать раскладку, а зовут эту функцию на каждый скролл.
          if (!w.h) {
            dom.style.display = "inline-flex";
            w.h = dom.offsetHeight || 25;
          }
          const anchor = Math.max(1, Math.min(w.line, model.getLineCount()));
          const end = Math.max(anchor, Math.min(w.endLine || anchor, model.getLineCount()));
          const endY = (ed.getTopForLineNumber(end) || 0) - scrollTop;
          items.push({ dom, h: w.h, top: endY + lineH + 2 }); // строго под блоком изменений
        }
        const laid = layoutHunkWidgets(items, viewH);
        items.forEach((it, i) => {
          it.dom.style.top = (laid[i].top | 0) + "px";
          it.dom.style.display = laid[i].show ? "inline-flex" : "none";
        });
      }, []);
      placeHunkWidgetsRef.current = placeHunkWidgets;

      // Занять кнопки изменений на время запроса (и отпустить после): иначе
      // второе нажатие в другом порядке уходит на устаревшем номере изменения.
      const setHunksBusy = useCallback((busy) => {
        hunkBusyRef.current = !!busy;
        for (const w of hunkWidgetsRef.current) {
          const dom = w.getDomNode && w.getDomNode();
          if (!dom) continue;
          for (const b of dom.querySelectorAll("button")) b.disabled = !!busy;
        }
      }, []);

      // Отметки уезжают на хост вместе с ОТПЕЧАТКОМ текста каждого изменения: по
      // нему хост и отбирает, что отправить в индекс (см. /bsl/stage).
      const postReviewed = useCallback(async (path) => {
        const rev = reviewedRef.current;
        // В хранилище уходят только отметки, которым есть чему соответствовать
        // — изменениям, которые сейчас есть в файле. Набор `rev.hashes` шире: он
        // копится за сессию, и в нём остаются id правок, которых в файле уже
        // нет (правку отклонили, или она изменилась после просмотра). Такие id
        // никто не может сопоставить, а в отчёте «В индекс» они всплывали как
        // «N изменений не совпали — файл менялся после просмотра», хотя файл
        // никто не менял.
        const liveIds = new Set(diffHunksRef.current.map((h) => h.id));
        const marks = diffHunksRef.current
          .filter((h) => rev.hashes.has(h.id))
          .map((h) => ({ id: h.id, fp: hashChunk(h.text) })); // отпечаток текста, не текст
        const hashes = [...rev.hashes].filter((id) => liveIds.has(id));
        try {
          const res = await fetch("/bsl/reviewed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, hashes, marks }),
          });
          // Молчать об этом нельзя: если отметки не сохранились, следующий
          // ответ хоста вернёт принятые изменения в счётчик, и выглядит это как
          // «кнопка сама сбрасывает просмотр».
          if (!res.ok) console.warn("[bsl] отметки не сохранились: HTTP " + res.status);
        } catch (e) {
          console.warn("[bsl] отметки не сохранились: " + (e?.message || String(e)));
        }
      }, []);

      // Отметка «просмотрено» по изменению (+ запись отметок на диск: они живут
      // между сессиями и привязаны к текущему HEAD).
      const acceptHunk = useCallback(async (hunk, accept) => {
        const path = openPathRef.current;
        if (!path) return;
        const rev = reviewedRef.current;
        if (accept) rev.hashes.add(hunk.id);
        else rev.hashes.delete(hunk.id);
        const ed = editorRef.current;
        renderDiffView(path, diffHunksRef.current, ed?.getModel()?.getLineCount() || 0, false);
        await postReviewed(path);
      }, [renderDiffView, postReviewed]);
      acceptHunkRef.current = acceptHunk;

      // Отказ изменения: возврат к HEAD делает git (`git apply -R` по изменению) —
      // строки в файле меняет он, а не редактор, поэтому после отката файл
      // перечитывается с диска.
      const rejectHunk = useCallback(async (hunk) => {
        const path = openPathRef.current;
        if (!path) return;
        if (openBuffersRef.current.has(path)) {
          showNotice("Сначала сохраните файл (Ctrl+S): иначе откат потеряет несохранённые правки");
          return;
        }
        if (hunkBusyRef.current) return;
        setHunksBusy(true);
        try {
          const res = await fetch("/bsl/revert-hunk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, index: hunk.index, source: hunk.source, expect: hunk.header }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) showNotice("Отклонить не удалось: " + (data.error || ("HTTP " + res.status)));
          else showNotice(null);
        } catch (e) {
          showNotice("Отклонить не удалось: " + (e?.message || String(e)));
        } finally {
          setHunksBusy(false);
        }
        await revertFileRef.current?.();
      }, [setHunksBusy]);
      rejectHunkRef.current = rejectHunk;

      // Файл целиком: «Принять все» — отметить просмотренными все изменения;
      // «Отклонить все» — вернуть файл к HEAD (git checkout HEAD -- файл).
      const acceptAllHunks = useCallback(async () => {
        const path = openPathRef.current;
        if (!path) return;
        const rev = reviewedRef.current;
        for (const h of diffHunksRef.current) rev.hashes.add(h.id);
        const ed = editorRef.current;
        renderDiffView(path, diffHunksRef.current, ed?.getModel()?.getLineCount() || 0, false);
        await postReviewed(path);
      }, [renderDiffView, postReviewed]);

      // Показать/спрятать просмотренные изменения: спрятанные по умолчанию, а
      // показать их нужно, чтобы вернуть ошибочно принятый изменение в работу.
      const toggleReviewedShow = useCallback(() => {
        const rev = reviewedRef.current;
        rev.show = !rev.show;
        const path = openPathRef.current;
        if (!path) return;
        const ed = editorRef.current;
        renderDiffView(path, diffHunksRef.current, ed?.getModel()?.getLineCount() || 0, false);
      }, [renderDiffView]);

      const rejectAllHunks = useCallback(async () => {
        const path = openPathRef.current;
        if (!path) return;
        if (openBuffersRef.current.has(path)) {
          showNotice("Сначала сохраните файл (Ctrl+S): иначе откат потеряет несохранённые правки");
          return;
        }
        if (hunkBusyRef.current) return;
        setHunksBusy(true);
        try {
          const res = await fetch("/bsl/revert-file", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) showNotice("Отклонить не удалось: " + (data.error || ("HTTP " + res.status)));
          else showNotice(null);
        } catch (e) {
          showNotice("Отклонить не удалось: " + (e?.message || String(e)));
        } finally {
          setHunksBusy(false);
        }
        reviewedRef.current.hashes = new Set();
        await revertFileRef.current?.();
      }, [setHunksBusy]);

      // Первый клик взводит «подтверждение» на 4 секунды, второй — откатывает
      // файл: откат стирает правки в рабочей копии без возврата.
      const onRejectAllClick = useCallback(() => {
        if (rejectAllTimerRef.current) {
          clearTimeout(rejectAllTimerRef.current);
          rejectAllTimerRef.current = null;
        }
        if (!rejectAllArmedRef.current) {
          rejectAllArmedRef.current = true;
          setRejectAllArmed(true);
          rejectAllTimerRef.current = setTimeout(() => {
            rejectAllArmedRef.current = false;
            rejectAllTimerRef.current = null;
            setRejectAllArmed(false);
          }, 4000);
          return;
        }
        rejectAllArmedRef.current = false;
        setRejectAllArmed(false);
        rejectAllHunks();
      }, [rejectAllHunks]);
      useEffect(() => () => { if (rejectAllTimerRef.current) clearTimeout(rejectAllTimerRef.current); }, []);

      const refreshGitDecorations = useCallback(async (path) => {
        if (!editorRef.current || !monacoRef.current) return;
        // Вызовы из onDidChangeModelContent приходят без аргумента — берём текущий файл
        if (path == null) path = openPathRef.current;
        if (!path) return;
        try {
          // Diff и отметки «просмотрено» — параллельно: отметки нужны, чтобы
          // не рисовать уже посмотренные изменения.
          const [data, revData] = await Promise.all([
            fetchJson("/bsl/git-diff?path=" + encodeURIComponent(path)),
            fetchJson("/bsl/reviewed?path=" + encodeURIComponent(path)).catch(() => ({ hashes: [] })),
          ]);
          const diff = data.diff || "";
          // Гонка: пока летел запрос, пользователь мог переключить файл —
          // декорации и зоны чужого диффа применять нельзя. Проверяем модель
          // ДО любых deltaDecorations/changeViewZones.
          const ed = editorRef.current;
          const model = ed.getModel();
          const lineCount = model ? model.getLineCount() : 0;
          const modelPath = model ? normPath(decodeURIComponent(model.uri.path.replace(/^\//, ""))) : null;
          if (!model || modelPath !== normPath(path)) {
            // Привязки (зоны, декорации, виджеты) — на редакторе, а не на
            // модели: при смене файла их надо снять руками.
            resetDiffView();
            return;
          }
          const rev = reviewedRef.current;
          const prevHead = rev.headSha;
          rev.hashes = mergeReviewedHashes(rev.hashes, prevHead, revData.hashes, revData.headSha || "");
          rev.headSha = revData.headSha || "";
          // Хост отдаёт индекс и рабочую копию раздельно (откатываются они
          // по-разному). Старый хост без этих полей — diff целиком как рабочая копия.
          const cD = data.cachedDiff, wD = data.workDiff;
          diffHunksRef.current = (cD === undefined && wD === undefined)
            ? parseDiffHunks(diff, "worktree")
            : [...parseDiffHunks(cD || "", "index"), ...parseDiffHunks(wD || "", "worktree")];
          // Файл ещё не в git (новый объект): базы для diff нет, значит diff
          // пуст — без этого свежесохранённый файл выглядит «без изменений».
          // Помечаем все строки как добавленные (gutter как в VS Code).
          const relPath = (() => {
            let s = normPath(path);
            const r = normPath(rootPathRef.current || "");
            if (r && s.toLowerCase().startsWith(r.toLowerCase())) s = s.slice(r.length).replace(/^\/+/, "");
            return s;
          })();
          const isNewUntracked = !diff.trim() && String(gitFilesRef.current.get(relPath) || "").includes("?");
          renderDiffView(path, diffHunksRef.current, lineCount, isNewUntracked);
          // Свежеоткрытый файл с диффами: сразу позиционируем на первый блок.
          // Признак свежести сбрасываем по факту ЛЮБОГО завершённого refresh
          // этого файла: если диффов не было, флаг не должен дожить до первой
          // правки (появится дифф — случится ложный автопереход).
          const isFreshOpen = freshOpenPathRef.current === normPath(path);
          freshOpenPathRef.current = null;
          if (isFreshOpen && diffNavRef.current.anchors.length) {
            const ed2 = editorRef.current;
            if (ed2 && !ed2.isDisposed?.()) {
              requestAnimationFrame(() => {
                gotoAnchorRef.current?.(0);
              });
            }
          }
        } catch {}
      }, [clearDiffView, renderDiffView]);
      refreshGitDecorationsRef.current = refreshGitDecorations;

      // Проиндексировать просмотренное. В индекс уходят только помеченные
      // изменения — остальные строки файла остаются как были; после этого они
      // пропадают из подсветки и счётчика (у одного и того же изменения в индексе
      // и в рабочей копии одинаковый признак содержимого). Несохранённый
      // буфер не индексируем: в индекс ушла бы версия с диска, а не с экрана.
      const stageFile = useCallback(async () => {
        const path = openPathRef.current;
        if (!path) return;
        if (openBuffersRef.current.has(path)) {
          showNotice("Сначала сохраните файл (Ctrl+S): иначе в индекс уйдёт версия с диска, а не то, что в редакторе");
          return;
        }
        if (hunkBusyRef.current) return;
        setHunksBusy(true);
        try {
          const res = await fetch("/bsl/stage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            showNotice("В индекс не удалось: " + (data.error || ("HTTP " + res.status)));
            console.warn("[bsl] в индекс — ошибка", { path, status: res.status, data });
            return;
          }
          // Тишина в ответ на нажатие читается как поломка кнопки: называем
          // причину словами и всегда оставляем след в консоли.
          console.info("[bsl] в индекс", { path, ...data });
          showNotice(stageReasonText(data));
          if (!data.staged && !data.untracked) return; // менять нечего
          await refreshGitDecorationsRef.current?.(path);
          // Новый файл уходит в индекс целиком: отмечаем его просмотренным,
          // иначе он тут же вернётся в счётчик одним большим изменением.
          if (data.untracked) await acceptAllHunks();
          refreshGit();
        } catch (e) {
          showNotice("В индекс не удалось: " + (e?.message || String(e)));
        } finally {
          setHunksBusy(false);
        }
      }, [acceptAllHunks, refreshGit, setHunksBusy]);

      // То же по всем изменённым файлам проекта разом.
      const stageAllReviewed = useCallback(async () => {
        if (hunkBusyRef.current) return;
        setStageAllBusy(true);
        setHunksBusy(true);
        try {
          const res = await fetch("/bsl/stage-all", { method: "POST" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            showNotice("В индекс не удалось: " + (data.error || ("HTTP " + res.status)));
            return;
          }
          console.info("[bsl] в индекс (все изменённые файлы)", { ...data });
          showNotice(stageAllReasonText(data));
          const p = openPathRef.current;
          if (p) await refreshGitDecorationsRef.current?.(p);
          refreshGit();
        } catch (e) {
          showNotice("В индекс не удалось: " + (e?.message || String(e)));
        } finally {
          setStageAllBusy(false);
          setHunksBusy(false);
        }
      }, [refreshGit, setHunksBusy]);

      // Коммит: сообщение пишет человек, а окно показывает, что лежит в индексе.
      const openCommitBox = useCallback(async () => {
        setCommitOpen(true);
        setCommitError("");
        try {
          const data = await fetchJson("/bsl/staged");
          setCommitFiles(Array.isArray(data?.files) ? data.files : []);
        } catch {
          setCommitFiles([]);
        }
      }, []);
      const closeCommitBox = useCallback(() => {
        setCommitOpen(false);
        setCommitError("");
        setCommitMsg("");
      }, []);
      const doCommit = useCallback(async () => {
        const message = commitMsg.trim();
        if (!message) {
          setCommitError("Напишите сообщение коммита");
          return;
        }
        setCommitBusy(true);
        setCommitError("");
        try {
          const res = await fetch("/bsl/commit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            setCommitError(data.error || ("HTTP " + res.status));
            return;
          }
          setCommitOpen(false);
          setCommitMsg("");
          setCommitFiles([]);
          showNotice("Закоммичено: " + (data.summary || (data.files + " файлов")));
          const p = openPathRef.current;
          if (p) await refreshGitDecorationsRef.current?.(p);
          refreshGit();
        } catch (e) {
          setCommitError(e?.message || String(e));
        } finally {
          setCommitBusy(false);
        }
      }, [commitMsg, refreshGit]);

      // Persist the open model back to disk via the host /bsl/write route.
      const saveFile = useCallback(async () => {
        const model = modelRef.current;
        const path = openPathRef.current;
        if (!model || !path) return;
        if (saving) return;
        setSaving(true);
        setSaveError("");
        try {
          const res = await fetch("/bsl/write", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path,
              content: model.getValue(),
              bom: bomRef.current.get(path) ?? false,
              encoding: encRef.current.get(path) || "utf-8",
            }),
          });
          if (!res.ok) throw await errorFromResponse(res);
          setDirty(false);
          markTabDirty(path, false);
          // Обновить известный mtime: наша же запись на диске не должна
          // выглядеть как внешнее изменение при следующем checkExternalChange.
          try {
            const st = await fetchJson("/bsl/stat?path=" + encodeURIComponent(path));
            modelMtimesRef.current.set(path, st.mtimeMs ?? null);
          } catch {}
          refreshGitDecorations(path);
          // Бейджи в дереве и список «Изменённые» берут данные из
          // /bsl/git-status — без обновления сохранённый файл не появится там
          // до следующего триггера (хост сбрасывает свой кэш на записи).
          refreshGit();
        } catch (e) {
          setSaveError(e?.message || String(e));
        } finally {
          setSaving(false);
        }
      }, [saving, refreshGitDecorations, refreshGit]);
      const saveFileRef = useRef(null);
      saveFileRef.current = saveFile;

      // Revert the active file: re-read from disk, drop unsaved edits and the
      // parked buffer, refresh git decorations. Keeps scroll position.
      const revertFile = useCallback(async () => {
        const path = openPathRef.current;
        const model = modelRef.current;
        if (!path || !model) return;
        try {
          const data = await fetchJson("/bsl/read?path=" + encodeURIComponent(path));
          if (model.getValue() !== data.content) {
            // Preserve the view across the buffer swap.
            const ed = editorRef.current;
            const st = ed?.saveViewState?.();
            model.setValue(data.content);
            if (ed && st) {
              requestAnimationFrame(() => {
                const e2 = editorRef.current;
                if (e2 && !e2.isDisposed?.() && modelRef.current === model) { try { e2.restoreViewState(st); } catch {} }
              });
            }
          }
          setOpenContent(data.content);
          // mtime на диске мог измениться с момента загрузки (внешняя правка,
          // которую revert только что подтянул) — фиксируем актуальное значение.
          try {
            const st = await fetchJson("/bsl/stat?path=" + encodeURIComponent(path));
            modelMtimesRef.current.set(path, st.mtimeMs ?? null);
          } catch {}
          markTabDirty(path, false);
          setDirty(false);
          setSaveError("");
          refreshGitDecorations(path);
          refreshGit();
        } catch (e) {
          setSaveError(e?.message || String(e));
        }
      }, [markTabDirty, refreshGitDecorations, refreshGit]);
      const revertFileRef = useRef(null);
      revertFileRef.current = revertFile;

      // Cursor-style inline diff navigation: cycle through change anchors
      // (added lines + deleted-block zones), reveal and flash each one.
      // Переход к якорю i + подсветка + актуализация счётчика.
      // Программный скролл от revealLineInCenter триггерит onDidScrollChange;
      // флаг не даёт syncDiffNav пересчитать index во время перехода.
      let navJumping = false;
      const gotoAnchor = useCallback((i) => {
        const ed = editorRef.current;
        const monaco = monacoRef.current;
        const nav = diffNavRef.current;
        if (!ed || !monaco || !nav || !nav.anchors.length) return;
        nav.index = i;
        navJumping = true;
        try {
          ed.revealLineInCenter(nav.anchors[i].line);
          ed.setPosition({ lineNumber: nav.anchors[i].line, column: 1 });
          const flashIds = ed.deltaDecorations([], [{
            range: new monaco.Range(nav.anchors[i].line, 1, nav.anchors[i].line, 1),
            options: { isWholeLine: true, className: "bsl-git-flash" },
          }]);
          setTimeout(() => {
            try { ed.deltaDecorations(flashIds, []); } catch {}
          }, 650);
        } finally {
          setTimeout(() => { navJumping = false; }, 120);
        }
        if (diffWidgetRef.current) diffWidgetRef.current.label.textContent = (i + 1) + " / " + nav.anchors.length;
      }, []);
      // Синхронизация навигатора с реальной позицией в файле: текущим считается
      // якорь, ближайший к центру видимой области.
      const syncDiffNav = useCallback(() => {
        if (navJumping) return;
        const ed = editorRef.current;
        const nav = diffNavRef.current;
        if (!ed || !nav || !nav.anchors.length || !diffWidgetRef.current) return;
        const visible = ed.getVisibleRanges();
        if (!visible.length) return;
        const top = visible[0].startLineNumber;
        const bottom = visible[visible.length - 1].endLineNumber;
        const mid = Math.floor((top + bottom) / 2);
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < nav.anchors.length; i++) {
          const d = Math.abs(nav.anchors[i].line - mid);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        if (best !== nav.index) {
          nav.index = best;
          diffWidgetRef.current.label.textContent = (best + 1) + " / " + nav.anchors.length;
        }
      }, []);

      gotoAnchorRef.current = gotoAnchor;
      syncDiffNavRef.current = syncDiffNav;

      // Шаг считаем от КУРСОРА, а не от сохранённого индекса: после «Принять»
      // изменение исчезает, индекс сбрасывается, и шаг от «ближайшего к центру
      // экрана» перескакивал ближайшее изменение — счётчик при этом врал.
      const navigateDiff = useCallback((dir) => {
        const ed = editorRef.current;
        const nav = diffNavRef.current;
        if (!ed || !nav || !nav.anchors.length) return;
        const anchors = nav.anchors;
        const pos = ed.getPosition?.();
        const cursor = pos && pos.lineNumber ? pos.lineNumber : 1;
        let i;
        if (dir > 0) {
          i = anchors.findIndex((x) => x.line > cursor);
          if (i < 0) i = 0; // ниже изменений нет — идём на первое
        } else {
          i = -1;
          for (let k = 0; k < anchors.length; k++) if (anchors[k].line < cursor) i = k;
          if (i < 0) i = anchors.length - 1; // выше изменений нет — идём на последнее
        }
        gotoAnchor(i);
      }, [gotoAnchor]);
      navigateDiffRef.current = navigateDiff;

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

        // Go-to-definition — только по F12 (см. staticDef ниже): нативный
        // Ctrl+клик Monaco мешает выделению/копированию, поэтому definition
        // provider не регистрируем ни для LSP, ни для статики.
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

      // Static go-to-definition (F12) via the metadata model — active when LSP
      // is off/unavailable. Exact resolution for «[Коллектор.]Модуль.Метод»,
      // otherwise a name-wide search; repeated F12 cycles through candidates.
      useEffect(() => {
        if (!monacoReady || !monacoRef.current || !editorRef.current) return;
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        const staticDef = async (model, position) => {
          if (lspRef.current) return null; // LSP provider handles it
          try {
            // F12 осмыслен только для BSL: в XML/.md определений нет, и раньше
            // это выглядело как «клавиша не работает» без единого сообщения.
            if (model.getLanguageId?.() !== "bsl") {
              console.info("[dsh-bsl-editor] F12: файл не на BSL (" + (model.getLanguageId?.() || "?") + ") — переход к определению недоступен");
              return null;
            }
            const word = wordAt(model, position);
            if (!word) return null;
            const prev = staticNavRef.current;
            if (prev && prev.word === word && prev.targets.length) {
              const idx = (prev.index + 1) % prev.targets.length;
              prev.index = idx;
              const t = prev.targets[idx];
              suppressViewRestoreRef.current = true;
              try { await openFile(t.file); } finally { suppressViewRestoreRef.current = false; }
              const ed = editorRef.current;
              if (ed) { ed.setPosition({ lineNumber: t.line, column: t.col }); ed.revealPositionInCenter({ lineNumber: t.line, column: t.col }); }
              return null;
            }
            // model.uri.toString() percent-encodes non-ASCII paths — decode
            // first, then let encodeURIComponent do exactly one level.
            const curFile = decodeURIComponent((/^file:\/\/(?:\/)?(.+)$/.exec(model.uri.toString()) || [])[1] || "");
            const res = await fetchJson(
              "/bsl/find-symbol?name=" + encodeURIComponent(word) +
              "&file=" + encodeURIComponent(curFile)
            );
            const targets = res.targets || [];
            if (!targets.length) {
              staticNavRef.current = null;
              console.info("[dsh-bsl-editor] F12: определение не найдено — «" + word + "» (" + curFile + ")");
              return null;
            }
            staticNavRef.current = { word, targets, index: 0 };
            const t = targets[0];
            suppressViewRestoreRef.current = true;
            try { await openFile(t.file); } finally { suppressViewRestoreRef.current = false; }
            const ed = editorRef.current;
            if (ed) { ed.setPosition({ lineNumber: t.line, column: t.col }); ed.revealPositionInCenter({ lineNumber: t.line, column: t.col }); }
            return null;
          } catch (e) {
            console.error("[dsh-bsl-editor] static definition", e);
            return null;
          }
        };
        // Definition provider НЕ регистрируем (включает нативный Ctrl+клик) —
        // переход к определению только по F12.
        const disp = null;
        // Intercept F12 so Monaco doesn't show its own "No definition found"
        // toast on a miss — we do the navigation (and the toast) ourselves.
        if (!f12BoundRef.current) {
          f12BoundRef.current = editor.addCommand(monaco.KeyCode.F12, () => {
            const ed = editorRef.current;
            if (!ed) return;
            const m = ed.getModel();
            const pos = ed.getPosition();
            if (!m || !pos) return;
            if (lspRef.current) {
              // LSP-ветка: прямой запрос к языковому серверу.
              lspRef.current.request("textDocument/definition", {
                textDocument: { uri: m.uri.toString() },
                position: { line: pos.lineNumber - 1, character: pos.column - 1 },
              }).then((res) => {
                if (!res) return;
                const loc = Array.isArray(res) ? res[0] : res;
                if (!loc) return;
                suppressViewRestoreRef.current = true;
                openFile(decodeURIComponent((/^file:\/\/(?:\/)?(.+)$/.exec(String(loc.uri)) || [])[1] || String(loc.uri)))
                  .then(() => {
                    const e2 = editorRef.current;
                    if (e2) {
                      e2.setPosition({ lineNumber: loc.range.start.line + 1, column: loc.range.start.character + 1 });
                      e2.revealPositionInCenter({ lineNumber: loc.range.start.line + 1, column: loc.range.start.character + 1 });
                    }
                  })
                  .catch(() => {})
                  .finally(() => { suppressViewRestoreRef.current = false; });
              }).catch(() => {});
              return;
            }
            staticDef(m, pos);
          });
        }
        return () => disp?.dispose?.();
      }, [monacoReady, openFile]);

      // Restore the tree scroll position once the tree has rendered (children
      // come back from editorPersist synchronously, so the first paint already
      // has the content).
      const treeScrollRestoredRef = useRef(false);
      useEffect(() => {
        if (treeScrollRestoredRef.current) return;
        const body = treeBodyRef.current;
        if (!body || body.scrollHeight <= body.clientHeight) {
          treeScrollRestoredRef.current = true;
          return;
        }
        if (editorPersist.treeScrollTop > 0) body.scrollTop = editorPersist.treeScrollTop;
        treeScrollRestoredRef.current = true;
      }, [children, metaChildren]);

      // Load the workspace root on first mount only. On a remount the tree
      // comes back from editorPersist already populated — refetching the root
      // would flash "Загрузка…" and collapse nothing, but is still useful to
      // refresh git badges.
      const treeRestoredRef = useRef(false);
      useEffect(() => {
        // Config arrives async and may have just changed (Settings → save):
        // refetch git statuses so untracked visibility follows immediately.
        refreshGit();
        if (!treeRestoredRef.current && children.size === 0) {
          treeRestoredRef.current = true;
          loadDir(rootPath || "");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [loadDir, refreshGit]);
      useEffect(() => {
        if (cfg) refreshGit();
      }, [cfg?.lspEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

      // Restore the previously open file + caret after Monaco is ready.
      const restoreDoneRef = useRef(false);
      useEffect(() => {
        if (!monacoReady || restoreDoneRef.current) return;
        const p = editorPersist.openPath;
        if (!p) { restoreDoneRef.current = true; return; }
        restoreDoneRef.current = true;
        openFile(p).then(() => {
          const ed = editorRef.current;
          if (!ed) return;
          // Unsaved edits already live in the Monaco model (openFile seeds it
          // from the parked buffer), so only the caret/scroll need replaying.
          // Monaco computes the layout asynchronously after setModel, and
          // setPosition/reveal can re-scroll after our first attempt, so
          // keep re-applying until the editor actually sits at the saved
          // scrollTop (or give up after a bounded number of tries).
          const cur = editorPersist.cursor;
          if (cur) ed.setPosition(cur);
          // Monaco computes the layout asynchronously after setModel, and
          // setPosition/reveal can re-scroll after our first attempt, so
          // keep re-applying until the editor actually sits at the saved
          // scrollTop (or give up after a bounded number of tries).
          const savedScroll = editorPersist.scrollTop;
          if (savedScroll) {
            let attempts = 0;
            const tryApply = () => {
              const e2 = editorRef.current;
              if (!e2 || (typeof e2.isDisposed === "function" && e2.isDisposed())) return;
              if (Math.abs((e2.getScrollTop() || 0) - savedScroll) < 2) return; // already there
              e2.setScrollTop(savedScroll);
              attempts += 1;
              if (attempts < 8) setTimeout(tryApply, 120 + attempts * 60);
            };
            requestAnimationFrame(tryApply);
            // Safety net: if the tab was hidden, rAF never fires — apply on
            // the next tick instead so the restore isn't lost.
            setTimeout(tryApply, 250);
          }
        });
      }, [monacoReady, openFile]);

      // Debounced search (files: /bsl/search, metadata: /bsl/meta/search).
      useEffect(() => {
        const q = search.trim();
        if (!q) { setSearchResults([]); return; }
        let alive = true;
        const t = setTimeout(async () => {
          try {
            // В режиме «Изменённые» поиск ограничен файлами из git-status.
            const url = mode === "meta"
              ? "/bsl/meta/search?q=" + encodeURIComponent(q)
              : "/bsl/search?q=" + encodeURIComponent(q) + (gitFilter ? "&changed=1" : "");
            const data = await fetchJson(url);
            if (alive) setSearchResults(data.results || []);
          } catch {
            if (alive) setSearchResults([]);
          }
        }, 120);
        return () => { alive = false; clearTimeout(t); };
      }, [search, mode, gitFilter]);

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
        // Последний сегмент — сам файл: его листинг не нужен (loadDir на файле
        // падает с ENOTDIR → 400).
        const dirSegs = segs.length > 1 ? segs.slice(0, -1) : segs;
        for (const seg of dirSegs) {
          const dirPath = joinPath(current, seg);
          if (!loaded.has(dirPath)) await loadDir(dirPath);
          loaded.add(dirPath);
          newExpanded.add(dirPath);
          current = dirPath;
        }
        setExpanded(newExpanded);
        setHighlightPath(fullPath);
      }, [rootPath, expanded, children, loadDir]);

      // Мост для перехватчика openPath: обновляется при изменении колбэков,
      // чистится при размонтировании. При монтировании применяется очередь
      // pendingOpens — открытия из чата, пришедшие, когда Editor был размонтирован.
      useEffect(() => {
        editorBridge = { openFile, reveal, ready: monacoReady, setTitle: setRootTitle };
        if (monacoReady && pendingOpens.length) {
          const queue = pendingOpens;
          pendingOpens = [];
          for (const p of queue.slice(-5)) {
            openFile(p);
            if (typeof reveal === "function") reveal(p);
          }
        }
        return () => { editorBridge = null; };
      }, [openFile, reveal, monacoReady]);

      // ── Metadata tree (1C): lazy load + expand/collapse ────────────────
      const gitFilterRef = useRef(gitFilter);
      gitFilterRef.current = gitFilter;
      const loadMeta = useCallback(async (key) => {
        setMetaLoading(true);
        setMetaLoadingKey(key || "");
        try {
          // Фильтр берём из ref — колбэк всегда видит актуальное состояние.
          const changed = mode === "meta" && gitFilterRef.current ? "&changed=1" : "";
          const url = "/bsl/meta/list?p=" + encodeURIComponent(key || "") + changed;
          const data = await fetchJson(url);
          if (!data.ok) throw new Error(data.error || "meta error");
          setMetaChildren((prev) => { const m = new Map(prev); m.set(key || "", data.items || []); return m; });
          setMetaError("");
          return data;
        } catch (e) {
          setMetaError(e?.message || String(e));
          return null;
        } finally {
          setMetaLoading(false);
          setMetaLoadingKey(null);
        }
      }, [mode]);

      const metaToggle = useCallback(async (key) => {
        if (metaExpanded.has(key)) {
          setMetaExpanded((prev) => { const s = new Set(prev); s.delete(key); return s; });
        } else {
          setMetaExpanded((prev) => new Set(prev).add(key));
          if (!metaChildren.has(key)) await loadMeta(key);
        }
      }, [metaExpanded, metaChildren, loadMeta]);

      // Ручное обновление дерева. Свежий файл был виден только в новой сессии
      // по двум причинам: листинги каталогов кэшируются в состоянии клиента и
      // повторно не запрашиваются, а хост держит в памяти разобранные
      // метаданные. Кнопка сбрасывает оба кэша и перечитывает то, что раскрыто.
      const refreshTree = useCallback(async () => {
        if (refreshBusy) return;
        setRefreshBusy(true);
        try {
          await fetchJson("/bsl/refresh", { method: "POST" });
          if (mode === "meta") {
            const st = await fetchJson("/bsl/meta/status");
            setMetaInfo(st);
            const changed = gitFilter ? "&changed=1" : "";
            const keys = ["", ...metaExpanded];
            const next = new Map();
            for (const k of keys) {
              const data = await fetchJson("/bsl/meta/list?p=" + encodeURIComponent(k || "") + changed);
              if (data.ok) next.set(k || "", data.items || []);
            }
            setMetaChildren(next);
            setMetaError(st.ok ? "" : (st.error || "метаданные не найдены"));
          } else {
            const next = new Map();
            let first = true;
            for (const d of [rootPath || "", ...expanded]) {
              const data = await fetchJson("/bsl/tree?path=" + encodeURIComponent(d || ""));
              next.set(data.path, data.entries);
              if (first) { setRootPath((prev) => prev || data.root || data.path); first = false; }
            }
            setChildren(next);
            setTreeError("");
            await refreshGit(true);
          }
          showNotice("Дерево обновлено");
        } catch (e) {
          showNotice("Обновить дерево не удалось: " + (e?.message || String(e)));
        } finally {
          setRefreshBusy(false);
        }
      }, [refreshBusy, mode, gitFilter, metaExpanded, rootPath, expanded, refreshGit, showNotice]);

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
      // Only when the row is actually outside the visible area — a plain
      // click on an already-visible file must not yank the viewport.
      const highlightScrollRef = useRef(null);
      useEffect(() => {
        if (!highlightPath || highlightPath === highlightScrollRef.current) return;
        const body = treeBodyRef.current;
        if (!body) return;
        const list = body.querySelectorAll("[data-path]");
        let found = false;
        for (const el of list) {
          if (el.dataset.path === highlightPath) {
            const elRect = el.getBoundingClientRect();
            const bodyRect = body.getBoundingClientRect();
            const above = elRect.top < bodyRect.top;
            const below = elRect.bottom > bodyRect.bottom;
            if (above || below) {
              body.scrollTo({ top: body.scrollTop + (elRect.top - bodyRect.top), behavior: "smooth" });
            }
            found = true;
            break;
          }
        }
        if (found) highlightScrollRef.current = highlightPath;
      }, [highlightPath, expanded, children, search]);

      // Same for metadata-mode highlight — scroll ONLY when the highlighted
      // node changes (not on every expand/collapse, which made the view
      // "jump back" to a stale highlight), and only when the node is outside
      // the visible area (a plain click on a visible row must not yank).
      const metaScrollRef = useRef(null);
      useEffect(() => {
        if (!metaHighlight || metaHighlight === metaScrollRef.current) return;
        const body = treeBodyRef.current;
        if (!body) return;
        const list = body.querySelectorAll("[data-meta-path]");
        let found = false;
        for (const el of list) {
          if (el.dataset.metaPath === metaHighlight) {
            const elRect = el.getBoundingClientRect();
            const bodyRect = body.getBoundingClientRect();
            const above = elRect.top < bodyRect.top;
            const below = elRect.bottom > bodyRect.bottom;
            if (above || below) {
              body.scrollTo({ top: body.scrollTop + (elRect.top - bodyRect.top), behavior: "smooth" });
            }
            found = true;
            break;
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
        return jsx("span", { style: { color: gitStatusColor(st), marginLeft: 6, fontSize: 11 }, children: gitStatusLabel(st) });
      };

      // Ожидание видно всегда одинаково: кружок плюс короткая подпись.
      const spinner = (size) => jsx("span", { className: "bsl-spinner", style: { width: size || 11, height: size || 11 } });
      const loadingRow = (text) => jsxs("div", { className: "bsl-loading", children: [spinner(), jsx("span", { children: text })] });

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
                title: full,
                onClick: () => {
                  setHighlightPath(full);
                  if (isDir) toggle(full);
                  else openFile(full);
                },
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
                  isDir && loadingDirs.has(full) ? spinner() : null,
                  gitBadge(full, e.type),
                ],
              }),
              isOpen
                ? children.has(full)
                  ? renderLevel(full, depth + 1)
                  : loadingDirs.has(full)
                  ? jsxs("div", { className: "bsl-loading", style: { paddingLeft: depth * 22 + 28 }, children: [spinner(), jsx("span", { children: "Читаем папку…" })] })
                  : null
                : null,
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
            title: r.path,
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

      // Git-status filter chips: null = all files, otherwise show only files
      // with that status (M/A/??/D) as a flat list built from gitFiles.
      const gitFilterChips = [
        { key: null, label: "Все файлы" },
        { key: "*", label: "Изменённые" },
      ];
      // «??» и «A» — новый файл: показываем как «+» зелёным.
      const isNewStatus = (st) => String(st).includes("?") || String(st).trim() === "A";
      const gitStatusColor = (st) => isNewStatus(st) ? "#4caf50" : String(st).includes("D") ? "#f44336" : String(st).includes("M") ? "#e2c08d" : "#8a94a6";
      const gitStatusLabel = (st) => isNewStatus(st) ? "+" : String(st).trim();
      // "*" matches any porcelain status (incl. combined "AM"/"A?" forms).
      const statusMatches = (st, f) => f === "*" ? !!st : f === "??" ? st.includes("?") : st.split("").some((ch) => ch === f);
      const applyGitFilter = (key) => {
        // Обновляем ref синхронно: loadMeta ниже вызывается до ререндера,
        // иначе запрос уйдёт со старым значением фильтра.
        gitFilterRef.current = key;
        setGitFilter(key);
        showNotice(null);
        if (key) refreshGit();
        // Переключение фильтра в режиме метаданных: сбросить кэш дерева,
        // чтобы оно перезагрузилось с/без changed-фильтра.
        if (mode === "meta") {
          setMetaChildren(new Map());
          setMetaExpanded(new Set());
          // Эффект первичной загрузки после первого раза больше не срабатывает
          // (guard по metaInfo) — перезагружаем корень явно.
          loadMeta("");
        }
      };
      const renderGitFilter = () => jsxs("div", {
        style: { display: "flex", flexDirection: "column" },
        children: [
          jsxs("div", {
            style: { display: "flex", gap: 4, padding: "0 4px 8px" },
            children: gitFilterChips.map((c) => jsx("button", {
              onClick: () => applyGitFilter(c.key),
              style: {
                flex: 1,
                height: 22,
                padding: "0 10px",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                font: "var(--dsw-font-s-14)",
                color: "var(--dsw-alias-label-primary)",
                background: gitFilter === c.key ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                opacity: gitFilter === c.key ? 1 : 0.6,
              },
              children: c.label,
            })),
          }),
          // Работа по списку изменённых файлов: отправить в индекс всё
          // просмотренное разом и закоммитить то, что в индексе.
          gitFilter === "*" ? jsxs("div", {
            style: { display: "flex", gap: 6, padding: "0 4px 8px" },
            children: [
              jsx("button", {
                className: "bsl-hunk-btn",
                disabled: stageAllBusy,
                onClick: () => stageAllReviewed(),
                title: "Отправить в индекс просмотренные изменения всех изменённых файлов — потом их можно закоммитить",
                children: "Всё просмотренное в индекс",
              }),
              jsx("button", {
                className: "bsl-hunk-btn",
                onClick: () => (commitOpen ? closeCommitBox() : openCommitBox()),
                title: "Закоммитить то, что лежит в индексе",
                children: commitOpen ? "Отмена" : "Коммит",
              }),
            ],
          }) : null,
          commitOpen ? jsxs("div", {
            className: "bsl-commit-box",
            children: [
              commitFiles.length
                ? jsx("div", {
                    className: "bsl-commit-list",
                    children: commitFiles.map((f) => jsx("div", {
                      key: f.path,
                      className: "bsl-commit-row",
                      title: f.path,
                      children: f.path + "  +" + f.added + " -" + f.removed,
                    })),
                  })
                : jsx("div", { className: "bsl-commit-note", children: "В индексе ничего нет" }),
              jsx("textarea", {
                className: "bsl-commit-msg",
                value: commitMsg,
                placeholder: "Сообщение коммита",
                rows: 3,
                onChange: (e) => setCommitMsg(e.target.value),
              }),
              commitError ? jsx("div", { className: "bsl-commit-error", children: commitError }) : null,
              jsx("button", {
                className: "bsl-hunk-btn bsl-hunk-btn--accept",
                disabled: commitBusy || !commitMsg.trim() || !commitFiles.length,
                onClick: () => doCommit(),
                title: "Зафиксировать индекс этим сообщением",
                children: commitBusy ? "Коммитим…" : "Закоммитить",
              }),
            ],
          }) : null,
        ],
      });
      const relOf = (fullPath) => {
        let rel = fullPath.replace(/\\/g, "/");
        const r = (rootPath || "").replace(/\\/g, "/");
        if (r && rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length).replace(/^\/+/, "");
        return rel;
      };
      // Репозиторий — свойство конкретной папки проекта, поэтому инициализация живёт здесь, где
      // эта папка открыта, а не в общих настройках редактора.
      const initRepoHere = async () => {
        setGitInitBusy(true);
        try {
          await fetchJson("/bsl/git-init", { method: "POST" });
          await refreshGit(true);
        } catch (e) {
          setGitInitError(String((e && e.message) || e));
        } finally {
          setGitInitBusy(false);
        }
      };
      const emptyGitText = () =>
        gitWhy === "no-git"
          ? "Git не найден — путь к git.exe указывается в Settings → 1С-Редактор кода"
          : gitWhy === "no-repo"
          ? jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
              jsx("div", { children: "Репозитория в этой папке нет: " + (rootPath || "папка проекта не открыта") }),
              jsx("div", { style: { opacity: 0.7 }, children: "Инициализация создаст git init, .gitignore (.dsh/, *.cfl, *.log) и первый коммит текущего состояния." }),
              gitInitError ? jsx("div", { style: { color: "#f48771" }, children: gitInitError }) : null,
              jsx("button", {
                className: "bsl-hunk-btn bsl-hunk-btn--accept",
                disabled: gitInitBusy || !rootPath,
                onClick: () => initRepoHere(),
                children: gitInitBusy ? "Готовим…" : "Инициализировать репозиторий",
              }),
            ]})
          : gitWhy === "status-failed"
          ? "git status не отработал: " + (gitDetail || "причина не сообщена")
          : gitDetail
          ? "Изменения не прочитаны: " + gitDetail
          : "Нет изменённых файлов";
      const renderGitList = () => {
        if (gitLoading && !gitFiles.size) return loadingRow("Читаем изменения…");
        if (!gitFiles.size) {
          return jsx("div", { style: { padding: "6px 10px", fontSize: 12, opacity: 0.6, lineHeight: 1.4 }, children: emptyGitText() });
        }
        const rows = [...gitFiles.entries()]
          .filter(([rel, st]) => statusMatches(st, gitFilter))
          .sort((a, b) => a[0].localeCompare(b[0]));
        if (!rows.length) {
          return jsx("div", { style: { padding: "6px 10px", fontSize: 12, opacity: 0.6 }, children: "Нет изменённых файлов" });
        }
        return rows.map(([rel, st]) => {
          const full = rootPath ? joinPath(rootPath, rel) : rel;
          const deleted = st.includes("D");
          const name = rel.slice(rel.lastIndexOf("/") + 1);
          return jsxs("div", {
            className: "dsh-bsl-row",
            onClick: () => (deleted ? showNotice("Файл удалён из рабочего дерева: " + rel) : openFile(full)),
            title: full + (deleted ? " (удалён)" : "") + "  ·  " + st,
            style: {
              boxSizing: "border-box", width: "100%", maxWidth: "100%", height: 34,
              font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
              textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
              borderRadius: 8, alignItems: "center", gap: 6, padding: "0 8px",
              display: "flex",
              opacity: deleted ? 0.55 : 1,
            },
            children: [
              iconBox(coloredFile(name)),
              jsx("span", { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }, children: name }),
              jsx("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: rel }),
              jsx("span", { style: { flexShrink: 0, color: gitStatusColor(st), fontSize: 11, width: 18, textAlign: "right" }, children: gitStatusLabel(st) }),
            ],
          });
        });
      };

      // 1C metadata icons come from the host's /bsl/icons route (dark set).
      // Their glyphs are near-white (#F0EFF1 on #656565), so they read only on a
      // dark surface; the .bsl-meta-icon rule below inverts their brightness for
      // the light theme.
      const metaIcon = (name) => jsx("img", {
        src: "/bsl/icons/" + (name || "common") + ".svg",
        className: "bsl-meta-icon",
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
              showNotice("Модуль «" + item.label + "» не найден.\nОткройте XML правой кнопкой мыши.");
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
            : metaLoadingKey != null && metaLoadingKey === full
            ? jsxs("div", { className: "bsl-loading", style: { paddingLeft: depth * 22 + 28 }, children: [spinner(), jsx("span", { children: "Читаем раздел…" })] })
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
                metaLoadingKey != null && metaLoadingKey === full ? spinner() : null,
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
          return jsxs("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: [
            jsx("div", { children: "Метаданные: " + metaError }),
            // Причина «конфигурация не найдена» означает не поломку, а не ту папку:
            // без подсказки человек ищет дефект там, где его нет.
            /не найдена/i.test(metaError)
              ? jsx("div", { style: { marginTop: 4, opacity: 0.75 }, children: "Откройте папку выгрузки конфигурации (ConfigDumpInfo.xml) или проект EDT (Configuration.mdo)." })
              : null,
          ]});
        }
        if (metaLoading && !metaChildren.has("")) return loadingRow("Читаем метаданные…");
        if (!metaChildren.has("") && metaInfo == null) return loadingRow("Смотрим конфигурацию…");
        if (!metaChildren.has("")) return null;
        return renderMetaLevel("", 0);
      };

      return jsxs("div", { ref: rootRef, "data-conversation-composer-overlay": "", style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, width: "100%", background: "var(--dsw-alias-bg-base)", overflow: "hidden" }, children: [
        // Tab bar — replaces the old LSP status strip: one tab per open file,
        // unsaved-dot + close button per tab, global save button on the right.
        // LSP status moved to title tooltips (Settings → 1С-редактор).
        jsx("div", {
          style: {
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
            height: 28,
            padding: "0 8px",
            fontSize: 11,
            color: "var(--dsw-alias-label-secondary, #8a94a6)",
            background: "var(--dsw-alias-bg-layer-2)",
            borderBottom: "1px solid var(--dsw-alias-border-l2)",
            overflowX: "auto",
            overflowY: "hidden",
            scrollbarWidth: "thin",
          },
          children: [
            // Кнопки файла (перечитать с диска / сохранить) держим в ЛЕВОМ углу
            // полосы вкладок: правый верхний угол панели занимает плашка
            // MCP-менеджера (position:absolute, top≈44px, right≈14px; её
            // положение настраивается в самом плагине, но настройка у него не
            // сохраняется) — раньше она закрывала эти кнопки. sticky left:0 —
            // чтобы кнопки не уезжали при горизонтальной прокрутке вкладок.
            openPath ? jsxs("div", { style: { position: "sticky", left: 0, zIndex: 2, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, marginRight: 8, background: "var(--dsw-alias-bg-layer-2)" }, children: [
              saveError ? jsx("span", { style: { color: "#f44336" }, title: saveError, children: "✕ ошибка сохранения" }) : null,
              jsx("button", {
                onClick: () => revertFileRef.current?.(),
                title: "Перечитать с диска — сбросить несохранённые изменения (" + openPath + ")",
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6,
                  cursor: "pointer", background: "transparent", color: "#8a94a6",
                  padding: 0, opacity: dirty ? 1 : 0.55,
                },
                children: jsx("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("polyline", { points: "23 4 23 10 17 10" }),
                  jsx("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }),
                ] }),
              }),
              jsx("button", {
                onClick: () => saveFileRef.current?.(),
                title: saving ? "Сохранение…" : dirty ? "Сохранить (Ctrl+S) — " + openPath : "Сохранено",
                disabled: saving,
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6, cursor: saving ? "wait" : "pointer",
                  background: "transparent", color: dirty ? "var(--dsw-alias-state-business-primary, #4a9eff)" : "#8a94a6",
                  padding: 0, opacity: dirty || saving ? 1 : 0.55,
                },
                children: jsx("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" }),
                  jsx("polyline", { points: "17 21 17 13 7 13 7 21" }),
                  jsx("polyline", { points: "7 3 7 8 15 8" }),
                ] }),
              }),
            ] }) : null,
            tabs.length === 0 ? jsx("span", { style: { opacity: 0.5, padding: "0 6px" }, children: "Нет открытых файлов" }) : null,
            tabs.map((p) => {
              const isTabDirty = tabDirty.has(p);
              const active = p === openPath;
              return jsxs("div", {
                onClick: () => switchTab(p),
                onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(p); } },
                onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
                title: p + (isTabDirty ? " — есть несохранённые правки" : ""),
                style: {
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  height: 22,
                  padding: "0 6px 0 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  font: "var(--dsw-font-s-14)",
                  background: active ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary, #8a94a6)",
                  boxShadow: active ? "inset 0 -2px 0 var(--dsw-alias-state-business-primary)" : undefined,
                },
                children: [
                  jsx("span", { children: p.split(/[\\/]/).pop() }),
                  isTabDirty ? jsx("span", { title: "Не сохранён", style: { color: "#ffb300", flexShrink: 0 }, children: "●" }) : null,
                  jsx("span", {
                    onClick: (e) => { e.stopPropagation(); closeTab(p); },
                    title: "Закрыть",
                    style: {
                      flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      width: 14, height: 14, borderRadius: 4,
                      cursor: "pointer", opacity: 0.45, fontSize: 12, lineHeight: "12px",
                    },
                    onMouseEnter: (e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)"; },
                    onMouseLeave: (e) => { e.currentTarget.style.opacity = "0.45"; e.currentTarget.style.background = "transparent"; },
                    children: "✕",
                  }),
                ],
              });
            }),
            // Принять/отклонить изменения по файлу целиком. «Отклонить все»
            // необратим для рабочей копии, поэтому выполняется вторым кликом.
            // Группа стоит последней и прижата к правому краю: вкладки идут
            // слева, поэтому от появления группы и от смены ширины счётчика они
            // не двигаются. sticky right:0 — как у кнопок файла слева, чтобы
            // группа оставалась видна при горизонтальной прокрутке вкладок.
            diffState.total > 0 ? jsxs("span", {
              style: { position: "sticky", right: 0, zIndex: 2, marginLeft: "auto", paddingLeft: 12, display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, background: "var(--dsw-alias-bg-layer-2)" },
              children: [
                jsx("button", {
                  className: "bsl-hunk-btn",
                  style: { visibility: diffState.reviewed > 0 ? "visible" : "hidden" },
                  onClick: () => toggleReviewedShow(),
                  title: diffState.show ? "Спрятать просмотренные изменения" : "Показать просмотренные изменения",
                  children: diffState.show ? "Скрыть просмотренные" : "Просмотрено: " + diffState.reviewed,
                }),
                jsx("button", {
                  className: "bsl-hunk-btn bsl-hunk-btn--reject" + (rejectAllArmed ? " bsl-hunk-btn--armed" : ""),
                  onClick: () => onRejectAllClick(),
                  title: rejectAllArmed
                    ? "Нажмите ещё раз: файл вернётся к состоянию HEAD, правки в нём пропадут"
                    : "Вернуть файл к состоянию HEAD — правки в файле пропадут",
                  children: rejectAllArmed ? "Подтвердить откат" : "Отклонить все",
                }),
                jsx("button", {
                  className: "bsl-hunk-btn bsl-hunk-btn--accept",
                  onClick: () => acceptAllHunks(),
                  title: "Отметить все изменения просмотренными — подсветка уйдёт",
                  children: "Принять все",
                }),
                jsx("button", {
                  className: "bsl-hunk-btn",
                  style: { visibility: diffState.reviewed > 0 ? "visible" : "hidden" },
                  onClick: () => stageFile(),
                  title: "Отправить просмотренные изменения в индекс — потом их можно закоммитить (в списке «Изменённые»)",
                  children: "В индекс",
                }),
              ],
            }) : null,
          ],
        }),
        jsxs("div", { style: { display: "flex", flex: 1, minHeight: 0, minWidth: 0 }, children: [
          jsxs("div", { style: { width: treeWidth, display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }, children: [
          jsxs("div", { style: { padding: "2px 6px 6px", flexShrink: 0 }, children: [
            jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "0 4px 6px" }, children: [
              jsx("div", { style: { flex: 1, minWidth: 0, fontSize: 12, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: mode === "meta"
                ? (metaInfo?.ok ? (metaInfo.configName || "Конфигурация") + " · " + (META_FORMAT_LABEL[metaInfo.format] || metaInfo.format) : "Метаданные 1С")
                : (rootTitle || "Проект") }),
              // Перечитать папку с диска. Без этой кнопки свежий файл появлялся
              // только в новой сессии: листинги каталогов кэшируются, а за папкой
              // никто не следит.
              jsx("button", {
                onClick: () => refreshTree(),
                disabled: refreshBusy,
                title: "Обновить дерево — прочитать папку заново",
                style: {
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, border: "none", borderRadius: 6,
                  cursor: refreshBusy ? "wait" : "pointer", background: "transparent", color: "#8a94a6",
                  padding: 0, opacity: refreshBusy ? 0.5 : 1,
                },
                children: jsx("svg", { className: refreshBusy ? "bsl-spin" : undefined, width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", children: [
                  jsx("polyline", { points: "23 4 23 10 17 10" }),
                  jsx("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }),
                ] }),
              }),
            ]}),
            jsxs("div", { style: { display: "flex", gap: 4, padding: "0 4px 8px" }, children: [
              jsx("button", {
                onClick: () => { setMode("files"); showNotice(null); },
                style: {
                  flex: 1, height: 26, border: "none", borderRadius: 8, cursor: "pointer",
                  font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
                  background: mode === "files" ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  opacity: mode === "files" ? 1 : 0.6,
                },
                children: "Файлы",
              }),
              jsx("button", {
                onClick: () => { setMode("meta"); showNotice(null); },
                style: {
                  flex: 1, height: 26, border: "none", borderRadius: 8, cursor: "pointer",
                  font: "var(--dsw-font-s-14)", color: "var(--dsw-alias-label-primary)",
                  background: mode === "meta" ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                  opacity: mode === "meta" ? 1 : 0.6,
                },
                children: "Метаданные",
              }),
            ]}),
            renderGitFilter(),
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
            : gitFilter
            ? renderGitList()
            : jsxs(React.Fragment, { children: [
                treeError ? jsx("div", { style: { padding: "4px 10px", fontSize: 11, color: "#f44336", whiteSpace: "pre-wrap" }, children: "Ошибка: " + treeError }) : null,
                !rootPath && !treeError ? loadingRow("Читаем папку проекта…") : null,
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
          editorNotice ? (
            // Обе подсказки стоят сверху, под полосой вкладок: по центру поверх кода
            // они закрывали ту самую строку, к которой относились. Появляются и
            // затухают плавно. Обычная гаснет сама (NOTICE_MS) и закрывается
            // крестиком; карточка «Файл изменён на диске» с кнопкой — ждёт решения
            // человека.
            noticeSticky
              ? jsx("div", { className: noticeLeaving ? "bsl-notice bsl-notice-leaving" : "bsl-notice", children:
                  jsxs("span", { className: "bsl-notice-pill", children: [
                    jsx("span", { children: editorNotice }),
                    jsx("button", {
                      onClick: () => externalReloadRef.current?.(),
                      style: { border: "none", borderRadius: 6, padding: "3px 12px", cursor: "pointer", background: "var(--dsw-alias-state-business-primary, #3964fe)", color: "#fff", font: "var(--dsw-font-s-14)" },
                      children: "Перезагрузить с диска",
                    }),
                    jsx("span", { onClick: () => closeNotice(), title: "Закрыть", style: NOTICE_CLOSE_CSS, children: "✕" }),
                  ] })
                })
              : jsx("div", { className: noticeLeaving ? "bsl-notice bsl-notice-leaving" : "bsl-notice", children:
                  jsxs("span", { className: "bsl-notice-pill", children: [
                    jsx("span", { children: editorNotice }),
                    jsx("span", { onClick: () => closeNotice(), title: "Закрыть", style: NOTICE_CLOSE_CSS, children: "✕" }),
                  ] })
                })
          ) : null,
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
        return jsx(EditorView, this.props);
      }
    }

    // Settings section shown in DSH Settings (nav item «1С-редактор») — the
    // single config source is the host (/bsl/config, persisted on save).
    function PluginSettingsSection() {
      const [cfg, setCfg] = React.useState(null);
      const [form, setForm] = React.useState({ lspEnabled: false, serverPort: 8025, serverBin: "", interceptChatOpen: true, gitPath: "", gitReadTimeoutSec: 300 });
      const [saved, setSaved] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        fetchJson("/bsl/config").then((c) => { if (alive) setCfg(c); }).catch(() => {});
        return () => { alive = false; };
      }, []);
      const [gitInfo, setGitInfo] = React.useState(null);
      const [gitBusy, setGitBusy] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        // fresh=1 на первом показе: экран не должен показывать «не найден» из-за
        // ответа, снятого до того, как приложение подняло окружение.
        fetchJson("/bsl/git-info?fresh=1")
          .then((d) => { if (alive) setGitInfo(d); })
          .catch((e) => { if (alive) setGitInfo({ ok: false, error: String(e?.message || e) }); });
        return () => { alive = false; };
      }, []);
      // Журнал отказов рядом с настройками: причину не надо пересказывать словами
      // и не надо ждать, пока человек её найдёт на экране.
      const [errorsInfo, setErrorsInfo] = React.useState(null);
      const [logBusy, setLogBusy] = React.useState(false);
      const loadErrors = React.useCallback(async () => {
        setLogBusy(true);
        try { setErrorsInfo(await fetchJson("/bsl/errors?tail=30")); }
        catch (e) { setErrorsInfo({ ok: false, error: String(e?.message || e) }); }
        finally { setLogBusy(false); }
      }, []);
      React.useEffect(() => { loadErrors(); }, [loadErrors]);
      // Кнопка и сохраняет путь, и проверяет его же — иначе значение на экране
      // и значение, которым работает проверка, могут разойтись.
      const checkGit = async () => {
        setGitBusy(true);
        try {
          await fetchJson("/bsl/config-save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gitPath: form.gitPath, gitReadTimeoutSec: form.gitReadTimeoutSec }),
          });
          const d = await fetchJson("/bsl/git-info?fresh=1");
          setGitInfo(d);
        } catch (e) {
          setGitInfo({ ok: false, error: String(e?.message || e) });
        } finally {
          setGitBusy(false);
        }
      };
      React.useEffect(() => {
        if (cfg) setForm({ lspEnabled: cfg.lspEnabled !== false, serverPort: cfg.serverPort || 8025, serverBin: cfg.serverBin || "", interceptChatOpen: cfg.interceptChatOpen !== false, gitPath: cfg.gitPath || "", gitReadTimeoutSec: cfg.gitReadTimeoutSec || 300 });
      }, [cfg]);
      const save = async () => {
        try {
          await fetchJson("/bsl/config-save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lspEnabled: form.lspEnabled, serverPort: form.serverPort, serverBin: form.serverBin, interceptChatOpen: form.interceptChatOpen, gitPath: form.gitPath, gitReadTimeoutSec: Number(form.gitReadTimeoutSec) || 300 }),
          });
          setCfg((c) => ({ ...(c || {}), lspEnabled: form.lspEnabled, serverPort: form.serverPort, serverBin: form.serverBin, interceptChatOpen: form.interceptChatOpen, gitPath: form.gitPath, gitReadTimeoutSec: Number(form.gitReadTimeoutSec) || 300 }));
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        } catch (e) {
          console.error("[dsh-bsl-editor] settings save", e);
        }
      };
      const inputStyle = { boxSizing: "border-box", width: "100%", height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "inherit", font: "var(--dsw-font-s-14)" };
      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }, children: [
        jsx("div", { style: { opacity: 0.7 }, children: "1С-Редактор кода: файловое дерево, метаданные, Monaco + bsl-language-server" }),
        jsxs("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, children: [
          jsx("input", { type: "checkbox", checked: form.lspEnabled, onChange: (e) => setForm((f) => ({ ...f, lspEnabled: e.target.checked })) }),
          "LSP (диагностика, автодополнение, переходы)",
        ]}),
        jsxs("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, children: [
          jsx("input", { type: "checkbox", checked: form.interceptChatOpen, onChange: (e) => setForm((f) => ({ ...f, interceptChatOpen: e.target.checked })) }),
          "Перехватывать открытие файлов из чата",
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
        // Git: диффы, индикаторы изменений, кнопки «В индекс» и «Коммит»
        // работают только через него. Рядом с состоянием — поле пути: если
        // git.exe лежит не там, где мы ищем, человек указывает его здесь.
        jsxs("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 2, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }, children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            // Пока ответа нет, состояние НЕИЗВЕСТНО: писать «не найден» нельзя —
            // именно это читалось как «git пропал, пока не нажмёшь Проверить снова».
            jsx("span", { children: "Git — " + (gitInfo == null
              ? "проверяем…"
              : gitInfo.ok === false
                ? "проверить не удалось"
                : gitInfo.git?.found ? "найден" : "не найден") }),
            gitInfo?.git?.found ? jsx("span", { style: { opacity: 0.55, fontSize: 11 }, children: gitInfo.git.version }) : null,
          ]}),
          gitInfo?.ok === false && gitInfo?.error ? jsx("div", { style: { color: "#f48771", fontSize: 11, lineHeight: 1.4, whiteSpace: "pre-wrap" }, children: gitInfo.error }) : null,
          gitInfo?.git?.found
            ? jsx("code", { style: { display: "block", opacity: 0.7, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }, children: gitInfo.git.source + ": " + (gitInfo.git.path === "git" ? "из PATH" : gitInfo.git.path) })
            : gitInfo == null
              ? null
              : jsx("div", { style: { color: "#e2c08d", fontSize: 11, lineHeight: 1.4 }, children: "Без Git не работают диффы, индикаторы изменений и кнопки «В индекс» / «Коммит»." }),
          gitInfo?.lastError?.text ? jsx("div", { style: { color: "#e2c08d", fontSize: 11, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }, children: "Последняя ошибка git — " + gitInfo.lastError.text }) : null,
          // Репозиторий — свойство папки проекта, а не редактора: настройки показывают только
          // путь к git.exe, поэтому отсутствие репозитория здесь — состояние, а не ошибка.
          // Инициализация живёт в панели изменений, где проект назван путём.
          gitInfo?.notRepo ? jsx("div", { style: { opacity: 0.7, fontSize: 11, lineHeight: 1.4 }, children: "В папке проекта нет git-репозитория — инициализация в панели изменений." }) : null,
          // Отдельная подсказка только для одной причины: лок индекса остаётся от
          // прерванной операции и блокирует всё остальное, а сам git называет файл.
          gitInfo?.lastError?.text && /index\.lock/i.test(gitInfo.lastError.text)
            ? jsx("div", { style: { color: "#e2c08d", fontSize: 11, lineHeight: 1.4 }, children: "Файл .git/index.lock остался от прерванной операции. Его можно удалить, если git сейчас ничего не делает." })
            : null,
          // Репозиторий принадлежит папке проекта, а не редактору вообще: здесь только путь к
          // git.exe. Инициализация — в панели изменений, где открытый проект назван путём.
          jsxs("label", { style: { display: "block" }, children: [
            jsx("div", { style: { marginBottom: 4, opacity: 0.7 }, children: "Путь к git.exe" }),
            jsx("input", { type: "text", value: form.gitPath, onChange: (e) => setForm((f) => ({ ...f, gitPath: e.target.value })), placeholder: "(пусто = найти автоматически)", style: inputStyle }),
            jsx("div", { style: { marginTop: 8, marginBottom: 4, opacity: 0.7 }, children: "Таймаут чтения git, с" }),
            jsx("input", {
              type: "number",
              value: form.gitReadTimeoutSec,
              onChange: (e) => setForm((f) => ({ ...f, gitReadTimeoutSec: e.target.value })),
              placeholder: "300",
              style: inputStyle,
            }),
            jsx("div", { style: { opacity: 0.6, fontSize: 11, lineHeight: 1.4 }, children: "Сколько ждать git status и diff. На большой выгрузке и сетевом диске ставьте больше: 600–1800." }),
          ]}),
          jsx("div", { children: jsx("button", { onClick: checkGit, disabled: gitBusy, style: { height: 28, padding: "0 14px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, cursor: gitBusy ? "wait" : "pointer", background: "transparent", color: "inherit", font: "var(--dsw-font-s-14)" }, children: gitBusy ? "Проверяем…" : "Проверить снова" }) }),
        ]}),
        jsxs("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 2, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }, children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            jsx("span", { children: "Журнал ошибок" }),
            errorsInfo && errorsInfo.exists ? jsx("span", { style: { opacity: 0.55, fontSize: 11 }, children: "записей: " + errorsInfo.total }) : null,
          ]}),
          errorsInfo?.file ? jsx("code", { style: { display: "block", opacity: 0.7, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }, children: errorsInfo.file }) : null,
          errorsInfo?.ok && errorsInfo.exists && errorsInfo.lines?.length
            ? jsx("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, lineHeight: 1.35, maxHeight: 132, overflowY: "auto" }, children: errorsInfo.lines.slice(-8).reverse().map((l, i) => jsxs("div", { style: { display: "flex", gap: 6 }, children: [
                jsx("span", { style: { opacity: 0.5, flexShrink: 0 }, children: String(l.at || "").slice(11, 19) }),
                jsx("span", { style: { opacity: 0.75, flexShrink: 0 }, children: (l.route || "—") + " " + (l.status || "") }),
                jsx("span", { title: String(l.message || ""), style: { color: "#e2c08d", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: l.message }),
              ], key: String(l.at || "") + i })) })
            : jsx("div", { style: { opacity: 0.6, fontSize: 11 }, children: errorsInfo == null ? "Читаем журнал…" : errorsInfo.exists ? "Ошибок нет" : "Журнал ещё не создан" }),
          jsxs("div", { style: { display: "flex", gap: 8 }, children: [
            jsx("button", { onClick: () => loadErrors(), disabled: logBusy, style: { height: 28, padding: "0 14px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, cursor: logBusy ? "wait" : "pointer", background: "transparent", color: "inherit", font: "var(--dsw-font-s-14)" }, children: logBusy ? "Читаем…" : "Обновить" }),
            jsx("button", { onClick: async () => { try { await fetchJson("/bsl/open-log-dir", { method: "POST" }); } catch (e) { setErrorsInfo((prev) => ({ ...(prev || {}), error: String(e?.message || e) })); } }, style: { height: 28, padding: "0 14px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, cursor: "pointer", background: "transparent", color: "inherit", font: "var(--dsw-font-s-14)" }, children: "Открыть папку журнала" }),
          ]}),
        ]}),
        jsx("div", { style: { display: "flex", alignItems: "center", gap: 10 }, children: [
          jsx("button", { onClick: save, style: { height: 28, padding: "0 16px", border: "none", borderRadius: 8, cursor: "pointer", background: "var(--dsw-alias-state-business-primary, #3964fe)", color: "#fff", font: "var(--dsw-font-s-14)" }, children: "Сохранить" }),
          saved ? jsx("span", { style: { color: "#4caf50", fontSize: 12 }, children: "Сохранено" }) : null,
          jsx("span", { style: { opacity: 0.6, fontSize: 11 }, children: "Соединение LSP обновится при открытии вкладки редактора" }),
        ]}),
      ]});
    }

    function apply(ctx) {
      chatCtx = ctx;
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
          { name: "settings.section", id: "dsh-bsl-editor", order: 50, label: () => "1С-Редактор кода", registrant: "dsh-bsl-editor" },
          PluginSettingsSection,
        ),
      );

      // ── Привязка корня к активной сессии ──────────────────────────────────
      // DSH's own sidebar resolves the project root from the CURRENT session's
      // cwd (ctx.sessions.list → byId[current].cwd), not from the workspace
      // registry order. Follow suit: whenever the active session changes, tell
      // the host to re-point /bsl/* at that session's cwd.
      const sessionsList = ctx.sessions?.list;
      if (sessionsList && typeof sessionsList.subscribe === "function" && typeof fetch === "function") {
        let lastCwd = "";
        // Активная сессия — та, что показана в главной области. Отдельного поля
        // `current` у списка сессий нет: ядро везде (layout, cordis, список
        // сессий, «открыть в приложении», agent-preset) выводит её одинаково —
        // строка с retainedBy.mainView > 0. Прежнее чтение `snap.current` не
        // срабатывало никогда и молча: корень редактора оставался на первом
        // воркспейсе реестра, поэтому в дереве была чужая папка, а её разбор
        // отвечал 400 «конфигурация 1С не найдена».
        const activeSession = () => {
          const snap = sessionsList.getSnapshot();
          const byId = snap?.byId ?? {};
          return Object.values(byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
        };
        const syncWorkspace = () => {
          try {
            const cwd = activeSession()?.cwd;
            if (!cwd || cwd === lastCwd) return;
            lastCwd = cwd;
            wsRootCache = "";
            // Название воркспейса берём у хоста (title из реестра либо имя папки)
            // и обновляем шапку дерева — EditorView подхватит через мост.
            fetch("/bsl/set-workspace", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ cwd }),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (d?.root) {
                  fetchJson("/bsl/workspaces").then((w) => {
                    if (w?.title && editorBridge && typeof editorBridge.setTitle === "function") {
                      editorBridge.setTitle(w.title);
                    }
                  }).catch(() => {});
                }
              })
              .catch(() => {});
          } catch {}
        };
        syncWorkspace();
        const unsub = sessionsList.subscribe(syncWorkspace);
        ctx.on("dispose", () => { try { unsub(); } catch {} });
      }

      // ── Перехват открытия файлов из чата ─────────────────────────────────
      // Фуннель чата — remote.session.openWorkspacePath({ path }) (DSH 0.1.2+):
      // через него идут ссылки из tool-строк, упоминания в тексте и
      // produced-files. Своё забираем ТОЛЬКО для .bsl/.xml, остальное уходит
      // дальше — в обёртку dsh-better-sidebar, а без неё в приложение ОС.
      const CHAT_OPEN_EXT = [".bsl", ".xml"];
      const wantsChatOpen = (p) => {
        const s = String(p || "").split(/[?#]/)[0].toLowerCase();
        const i = s.lastIndexOf(".");
        return i >= 0 && CHAT_OPEN_EXT.includes(s.slice(i));
      };
      // «Показать в папке» передаёт "." / "<cwd>/." — это не файл.
      const isFolderReveal = (p) => {
        const s = String(p || "");
        if (s === "." || s === "./") return true;
        const t = s.replace(/[\\/]+$/, "");
        return t === "." || /[\\/]\.$/.test(t);
      };
      let interceptOn = true;
      const refreshCfg = () => {
        fetchJson("/bsl/config").then((c) => { interceptOn = c.interceptChatOpen !== false; }).catch(() => {});
      };
      refreshCfg();

      // cwd активной сессии — та же база, от которой чат резолвит пути.
      const sessionCwd = () => {
        try {
          const snap = ctx.sessions?.list?.getSnapshot?.();
          const id = snap?.current;
          const cwd = id ? snap?.byId?.[id]?.cwd : "";
          return typeof cwd === "string" ? cwd : "";
        } catch { return ""; }
      };

      // Открытие в нашем редакторе. Editor может быть размонтирован (активна
      // вкладка чата) — тогда путь ждёт в pendingOpens и применяется при
      // монтировании.
      const openInEditor = (target) => {
        const bridge = editorBridge;
        if (bridge && typeof bridge.openFile === "function") {
          bridge.openFile(target);
          if (typeof bridge.reveal === "function") bridge.reveal(target);
          setTimeout(switchToEditorTab, 80);
          return true;
        }
        pendingOpens.push(target);
        switchToEditorTab();
        return true;
      };

      const takeOver = async (rawPath, cwdOverride) => {
        if (!interceptOn) return false;
        const raw = String(rawPath ?? "").trim();
        if (!raw || isFolderReveal(raw) || !wantsChatOpen(raw)) return false;
        const target = await resolveChatPath(raw, cwdOverride || sessionCwd());
        if (!target) return false;
        return openInEditor(target);
      };
      // Конверт remote-вызова: ChatView проверяет result.ok и на провале
      // показывает диалог ошибки — успешный перехват обязан вернуть его же.
      const OPENED = () => ({ ok: true, value: { opened: true } });

      // Само-перевооружение: поверх нашей обёртки может встать чужая
      // (dsh-better-sidebar ставит свою через Object.defineProperty на том же
      // сервисе), а снаружи оказывается последняя — периодически
      // заворачиваемся вокруг текущей.
      const armService = (svc, key, makeWrapped, restore) => {
        let installed = makeWrapped(svc[key]);
        const put = (fn) => {
          try {
            Object.defineProperty(svc, key, { configurable: true, enumerable: true, writable: true, value: fn });
          } catch { svc[key] = fn; }
        };
        put(installed);
        // TODO: убрать периодическую перепроверку, когда в dsh появится официальный
        // хук открытия файлов из чата (сегодня это подмена метода сервиса, и её
        // приходится переставлять после каждого remount/чужой обёртки). До тех пор
        // тик раз в 30 с: окно, в которое клик может уйти мимо редактора, — до
        // получаса кликов это единицы, а лишних запросов к /bsl/config больше нет.
        const timer = setInterval(() => {
          refreshCfg();
          if (svc[key] !== installed) {
            installed = makeWrapped(svc[key]);
            put(installed);
          }
        }, 30000);
        return () => {
          clearInterval(timer);
          if (svc[key] === installed) restore();
        };
      };

      const makeRemoteWrapper = (svc, current) => function interceptedOpenWorkspacePath(request, signal) {
        const raw = request && typeof request === "object" ? request.path : request;
        return (async () => {
          try {
            if (await takeOver(raw)) return OPENED();
          } catch (e) {
            console.error("[dsh-bsl-editor] chat open", e);
          }
          return current.call(svc, request, signal);
        })();
      };
      const makeOpenPathWrapper = (svc, current) => async function interceptedOpenPath(path) {
        try {
          if (await takeOver(path)) return undefined;
        } catch (e) {
          console.error("[dsh-bsl-editor] chat open", e);
        }
        return current.call(svc, path);
      };

      const chatOpenDisposers = [];

      // 1) Современная фуннель: remote.session.openWorkspacePath. Сервис
      // монтируется асинхронно и пересоздаётся при remount, поэтому обёртку
      // ставим лениво — тем же тиком, что и перевооружение.
      const getService = (name) => {
        try { return typeof ctx.get === "function" ? ctx.get(name) : undefined; } catch { return undefined; }
      };
      const getRemoteSession = () => getService("remote.session") || ctx.remote?.session;
      let remoteArmed = null;
      const ensureRemoteArmed = () => {
        const svc = getRemoteSession();
        if (!svc || typeof svc.openWorkspacePath !== "function") return;
        if (remoteArmed && remoteArmed.svc === svc) return;
        if (remoteArmed) { try { remoteArmed.dispose(); } catch {} }
        const desc = Object.getOwnPropertyDescriptor(svc, "openWorkspacePath");
        const prev = svc.openWorkspacePath;
        const dispose = armService(svc, "openWorkspacePath", (current) => makeRemoteWrapper(svc, current), () => {
          if (desc) { try { Object.defineProperty(svc, "openWorkspacePath", desc); return; } catch {} }
          svc.openWorkspacePath = prev;
        });
        remoteArmed = { svc, dispose };
      };
      ensureRemoteArmed();
      // TODO: см. armService — временный опрос вместо официального хука; снять,
      // когда перехват переедет на API dsh.
      const armTimer = setInterval(() => { refreshCfg(); ensureRemoteArmed(); ensureSidebarArmed(); }, 30000);
      chatOpenDisposers.push(() => {
        clearInterval(armTimer);
        if (remoteArmed) { try { remoteArmed.dispose(); } catch {} remoteArmed = null; }
      });

      // 2) Легаси-фуннель более старых ядер: ctx.workspaces.openPath.
      const wsService = ctx.workspaces;
      if (wsService && typeof wsService.openPath === "function") {
        const prev = wsService.openPath;
        chatOpenDisposers.push(armService(wsService, "openPath", (current) => makeOpenPathWrapper(wsService, current), () => { wsService.openPath = prev; }));
      }

      // 3) Фуннель ядра 0.1.5-rc: чат отдаёт файл правому сайдбару адресом
      //    dsh-resource://file/session/<id>/<путь> (sidebarRight.openResource).
      //    Своё (.bsl/.xml) забираем в редактор, остальное (картинки, pdf, чужие
      //    форматы) уходит дальше — в сайдбар (better-sidebar).
      const FILE_ADDR_PREFIX = "dsh-resource://file/";
      const parseFileAddress = (address) => {
        try {
          const s = String(address ?? "");
          if (!s.startsWith(FILE_ADDR_PREFIX)) return null;
          const end = s.search(/[?#]/);
          const [scope, ...rest] = s.slice(FILE_ADDR_PREFIX.length, end === -1 ? undefined : end).split("/");
          if (scope === "session") {
            const [id, ...segments] = rest;
            if (!id || !segments.length) return null;
            return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join("/") };
          }
          if (scope === "absolute") {
            const unc = rest[0] === "" && rest.length > 1;
            const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
            if (!segments.length || segments[0] === "") return null;
            const joined = segments.join("/");
            if (unc) return { scope, path: "//" + joined };
            return { scope, path: /^[A-Za-z]:$/.test(segments[0]) ? joined : "/" + joined };
          }
          return null;
        } catch { return null; }
      };
      const cwdOfSession = (sessionId) => {
        try {
          const snap = ctx.sessions?.list?.getSnapshot?.();
          const cwd = snap?.byId?.[sessionId]?.cwd;
          return typeof cwd === "string" ? cwd : "";
        } catch { return ""; }
      };
      const makeSidebarWrapper = (svc, current) => async function interceptedOpenResource(address, options) {
        try {
          const parsed = parseFileAddress(address);
          // Относительный путь резолвим от cwd ТОЙ сессии, чей адрес пришёл:
          // клик приходит в контексте сессии чата, а не текущей вкладки.
          if (parsed && await takeOver(parsed.path, parsed.scope === "session" ? cwdOfSession(parsed.sessionId) : "")) return;
        } catch (e) {
          console.error("[dsh-bsl-editor] sidebar open", e);
        }
        return current.call(svc, address, options);
      };
      let sidebarArmed = null;
      const ensureSidebarArmed = () => {
        const svc = getService("sidebarRight");
        if (!svc || typeof svc.openResource !== "function") return;
        if (sidebarArmed && sidebarArmed.svc === svc) return;
        if (sidebarArmed) { try { sidebarArmed.dispose(); } catch {} }
        const desc = Object.getOwnPropertyDescriptor(svc, "openResource");
        const prev = svc.openResource;
        const dispose = armService(svc, "openResource", (current) => makeSidebarWrapper(svc, current), () => {
          if (desc) { try { Object.defineProperty(svc, "openResource", desc); return; } catch {} }
          svc.openResource = prev;
        });
        sidebarArmed = { svc, dispose };
      };
      ensureSidebarArmed();
      chatOpenDisposers.push(() => {
        if (sidebarArmed) { try { sidebarArmed.dispose(); } catch {} sidebarArmed = null; }
      });

      ctx.on("dispose", () => { for (const d of chatOpenDisposers) { try { d(); } catch {} } });
    }

    const inject = ["slots", "workspaces", "sessions"];
    return { apply, inject };
  },
});
