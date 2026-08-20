// dsh-ide-switch — client half.
//
// Adds an IDE toggle to the conversation header (slot
// `conversation.session.header.actions`) and, in IDE mode, mounts a
// full-screen code-server iframe over the chat with a floating "back"
// button. Mode survives reloads (localStorage); code-server state is
// polled from /ide-status.
window.__ModuleLoader__.load({
  id: "dsh-ide-switch",
  factory: (require) => {
    const react = require("react");
    const { createPortal } = require("react-dom");
    const jsx = require("react/jsx-runtime").jsx;
    const jsxs = require("react/jsx-runtime").jsxs;
    const { useState, useEffect, useCallback, useRef } = react;

    const MODE_KEY = "dsh-ide-switch:mode";
    const STATUS_URL = "/ide-status";
    const START_URL = "/ide-start";

    const DOT_COLORS = {
      idle: "#8a8a8a",
      installing: "#ffb300",
      starting: "#ffb300",
      running: "#4caf50",
      missing: "#f44336",
    };

    function defaultUrl() {
      return "http://127.0.0.1:8443/";
    }

    function fetchJson(url, opts) {
      return fetch(url, opts).then(
        (res) => res.json(),
        () => null,
      );
    }

    /** Full-screen IDE overlay (portal to body) with a floating back button. */
    function IdeOverlay({ status, url, onExit }) {
      const state = status?.state ?? "starting";
      const ready = state === "running";

      useEffect(() => {
        const onKey = (e) => {
          if (e.key === "Escape") onExit();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onExit]);

      return createPortal(
        jsxs("div", {
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 100000,
            display: "flex",
            flexDirection: "column",
            background: "#1e1e1e",
          },
          children: [
            jsxs("div", {
              style: {
                height: 38,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0 10px",
                background: "#252526",
                color: "#cccccc",
                fontSize: 13,
                fontFamily: "system-ui, sans-serif",
              },
              children: [
                jsx(
                  "button",
                  {
                    type: "button",
                    onClick: onExit,
                    title: "Back to agent chat (Esc)",
                    style: {
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      border: "1px solid rgba(127, 127, 127, 0.45)",
                      borderRadius: 6,
                      background: "transparent",
                      color: "#e0e0e0",
                      cursor: "pointer",
                      fontSize: 13,
                    },
                  },
                  "← Chat",
                ),
                jsx("span", {
                  children: ready
                    ? "code-server"
                    : state === "installing"
                      ? "Installing code-server (one-time, a few minutes)…"
                      : state === "missing"
                        ? `code-server unavailable — ${status?.reason ?? "check /ide-status"}`
                        : "Starting code-server…",
                }),
                jsx("span", {
                  style: { marginLeft: "auto", opacity: 0.6 },
                  children: "Esc — back to chat",
                }),
              ],
            }),
            ready
              ? jsx("iframe", {
                  key: url,
                  src: url,
                  title: "code-server",
                  allow: "clipboard-read; clipboard-write; fullscreen",
                  style: { flex: 1, width: "100%", border: 0, background: "#1e1e1e" },
                })
              : jsx("div", {
                  style: {
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#9a9a9a",
                    fontFamily: "system-ui, sans-serif",
                    fontSize: 14,
                  },
                  children: state === "missing" ? `code-server unavailable — ${status?.reason ?? "unknown error"}` : "Waiting for code-server…",
                }),
          ],
        }),
        document.body,
      );
    }

    function Root() {
      const [mode, setMode] = useState(() => {
        try {
          return localStorage.getItem(MODE_KEY) === "ide";
        } catch {
          return false;
        }
      });
      const [status, setStatus] = useState(null);
      const statusRef = useRef(null);
      statusRef.current = status;

      useEffect(() => {
        let alive = true;
        const tick = async () => {
          const data = await fetchJson(STATUS_URL);
          if (alive && data) setStatus(data);
        };
        tick();
        const timer = setInterval(tick, mode ? 2000 : 10000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [mode]);

      const enterIde = useCallback(async () => {
        try {
          localStorage.setItem(MODE_KEY, "ide");
        } catch {}
        setMode(true);
        const current = statusRef.current;
        if (!current || !["running", "starting", "installing"].includes(current.state)) {
          const started = await fetchJson(START_URL);
          if (started) setStatus(started);
        }
      }, []);

      const exitIde = useCallback(() => {
        try {
          localStorage.setItem(MODE_KEY, "agent");
        } catch {}
        setMode(false);
      }, []);

      const dot = status ? DOT_COLORS[status.state] ?? "#8a8a8a" : "#8a8a8a";

      return jsxs(react.Fragment, {
        children: [
          jsx(
            "button",
            {
              type: "button",
              title: status
                ? `Code editor (code-server) — ${status.state}${status.reason ? ": " + status.reason : ""}`
                : "Code editor (code-server)",
              onClick: mode ? exitIde : enterIde,
              style: {
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                border: "1px solid rgba(127, 127, 127, 0.45)",
                borderRadius: "6px",
                background: "transparent",
                color: "inherit",
                font: "inherit",
                cursor: "pointer",
                lineHeight: 1.2,
              },
            },
            jsx("span", {
              style: {
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: dot,
                display: "inline-block",
                flexShrink: 0,
              },
            }),
            mode ? "Chat" : "IDE",
          ),
          mode
            ? jsx(IdeOverlay, {
                status,
                url: status?.url ?? defaultUrl(),
                onExit: exitIde,
              })
            : null,
        ],
      });
    }

    function apply(ctx) {
      ctx.slots.inject(
        "conversation.session.header.actions",
        () =>
          ctx.slots.register(
            {
              name: "conversation.session.header.actions",
              id: "dsh-ide-switch",
              order: 60,
            },
            Root,
          ),
      );
    }

    const inject = ["slots"];
    return { apply, inject };
  },
});
