// dsh-ide-switch — host half.
//
// Responsibilities:
//  1. Ensure code-server exists on the machine (auto-install via npm when missing).
//  2. Spawn code-server (loopback only, --auth none) on first use and keep it healthy.
//  3. Install the configured VS Code extensions (default: 1C:BSL Language Server).
//  4. Expose DSH routes: /ide-status (state JSON), /ide-start (force start),
//     and /ide (HTTP prefix + WebSocket upgrade) — dependency-free proxy
//     built on node:http / node:net.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "schemastery";

export const name = "dsh-ide-switch";

export const Config = z.object({
  /** code-server listen port on loopback. */
  codeServerPort: z.number().default(8443),
  /** Explicit path to the code-server executable; empty = resolve on PATH / npm global. */
  codeServerBin: z.string().default(""),
  /** Folder code-server opens; empty = the directory dsh was started from. */
  workspaceDir: z.string().default(""),
  /** Auto-install code-server via `npm install -g code-server` when missing. */
  autoInstall: z.boolean().default(true),
  /** VS Code extensions to install on first boot (OpenVSX ids). */
  installExtensions: z.array(z.string()).default(["1c-syntax.language-1c-bsl"]),
  /** Serve the IDE on the same origin under /ide/ (experimental); false = iframe targets the local port directly. */
  proxy: z.boolean().default(false),
});

export const inject = ["webServer"];

const STATES = /** @type {const} */ (["idle", "installing", "starting", "running", "missing"]);
/** @type {typeof STATES[number]} */
let state = "idle";
/** @type {string} */
let reason = "";
/** @type {ReturnType<typeof spawn> | null} */
let child = null;
/** @type {ReturnType<typeof setInterval> | null} */
let healthTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let installTimer = null;

/** @param {typeof Config extends z.Object<infer T> ? T : never} config */
function resolveWorkspaceDir(config) {
  if (config.workspaceDir) return config.workspaceDir;
  return process.cwd();
}

function baseUrl(config) {
  return `http://127.0.0.1:${config.codeServerPort}`;
}

/** Find the code-server executable (Windows: .cmd shims need shell spawning). */
function resolveBin(config) {
  if (config.codeServerBin) return { bin: config.codeServerBin, shell: false };
  const candidates = [
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "code-server", "code-server.cmd"),
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "code-server.cmd"),
    "code-server",
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { shell: true, windowsHide: true, timeout: 15_000 });
    if (probe.error === undefined && probe.status === 0) {
      return { bin: candidate, shell: true };
    }
  }
  return null;
}

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function setState(next, why = "") {
  state = next;
  reason = why;
}

async function ensureExtensions(bin, shell, config) {
  const listed = spawnSync(bin, ["--list-extensions"], { shell, windowsHide: true, timeout: 60_000, encoding: "utf-8" });
  const installed = new Set((listed.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  for (const ext of config.installExtensions) {
    if (installed.has(ext)) continue;
    // Async: extension downloads can take a while; the IDE stays usable meanwhile.
    spawn(bin, ["--install-extension", ext], { shell, windowsHide: true, stdio: "inherit" });
  }
}

function spawnServer(bin, shell, config) {
  const args = [
    "--auth", "none",
    "--bind-addr", `127.0.0.1:${config.codeServerPort}`,
    "--disable-telemetry",
    resolveWorkspaceDir(config),
  ];
  child = spawn(bin, args, {
    shell,
    detached: true,
    windowsHide: true,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    child = null;
    if (state !== "idle") setState("missing", `code-server exited (code ${code})`);
  });
  setState("starting", "waiting for code-server healthz");
  let attempts = 0;
  healthTimer = setInterval(async () => {
    attempts += 1;
    if (await probeHealth(config.codeServerPort)) {
      clearInterval(healthTimer);
      healthTimer = null;
      setState("running");
      ensureExtensions(bin, shell, config);
    } else if (attempts > 150) {
      clearInterval(healthTimer);
      healthTimer = null;
      setState("missing", "code-server did not become healthy in 5 minutes");
    }
  }, 2000);
}

function startCodeServer(config) {
  if (state === "installing") return;
  const resolved = resolveBin(config);
  if (!resolved) {
    if (config.autoInstall) {
      setState("installing", "installing code-server via npm (one-time, a few minutes)");
      // npm >= 11.2 blocks install scripts by default; allow code-server's
      // postinstall and argon2's native build via user config (ignored on
      // older npm, which runs scripts by default anyway).
      try {
        spawnSync("npm", ["config", "set", "allow-scripts=code-server,argon2", "--location=user"], {
          shell: process.platform === "win32",
          windowsHide: true,
          timeout: 60_000,
        });
      } catch {}
      const run = (args, fallback) => {
        const proc = spawn(args[0], args.slice(1), {
          shell: process.platform === "win32",
          detached: true,
          windowsHide: true,
          stdio: "inherit",
        });
        proc.on("exit", (code) => {
          installTimer = setTimeout(() => {
            installTimer = null;
            if (code === 0) {
              startCodeServer(config);
            } else if (fallback) {
              // npm 12 rejects code-server's postinstall (`npm install --unsafe-perm`):
              // retry through npm@10, which still accepts the flag.
              run(["npx", "-y", "npm@10", "install", "-g", "code-server"], false);
            } else {
              setState("missing", `npm install -g code-server failed (code ${code})`);
            }
          }, 500);
        });
      };
      run(["npm", "install", "-g", "code-server"], true);
    } else {
      setState("missing", "code-server not found; set autoInstall: true or codeServerBin");
    }
    return;
  }
  spawnServer(resolved.bin, resolved.shell, config);
}

// --- Dependency-free reverse proxy (HTTP + WebSocket upgrade) ---

function makeWebProxy(port) {
  return (req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`code-server unreachable: ${err.message}`);
    });
    req.pipe(upstream);
  };
}

function makeWsProxy(port) {
  return (req, socket, head) => {
    const upstream = net.connect(port, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => {
      try {
        socket.destroy();
      } catch {}
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  };
}

export function apply(ctx, config) {
  const target = baseUrl(config);
  const webProxy = makeWebProxy(config.codeServerPort);
  const wsProxy = makeWsProxy(config.codeServerPort);

  // /ide-status — state JSON the client polls.
  const disposeStatus = ctx.webServer.register({
    kind: "exact",
    path: "/ide-status",
    handler: (_req, res) => {
      const body = JSON.stringify({
        state,
        reason,
        port: config.codeServerPort,
        url: config.proxy ? "/ide/" : `${target}/`,
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    },
  });

  // /ide-start — force (re)start on demand.
  const disposeStart = ctx.webServer.register({
    kind: "exact",
    path: "/ide-start",
    handler: async (_req, res) => {
      if (state !== "running" && !(await probeHealth(config.codeServerPort))) {
        startCodeServer(config);
      }
      res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, state }));
    },
  });

  // /ide — the IDE surface: proxied (same-origin) or a plain redirect to the local port.
  const disposeIde = ctx.webServer.register({
    kind: "prefix",
    path: "/ide",
    handler: (req, res) => {
      if (!config.proxy) {
        res.writeHead(302, { location: `${target}/` });
        res.end();
        return;
      }
      if (req.url === "/ide" || req.url === "/ide/") req.url = "/";
      else req.url = req.url.replace(/^\/ide/, "");
      webProxy(req, res);
    },
  });

  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: "/ide",
    handler: (req, socket, head) => {
      if (!config.proxy) {
        socket.destroy();
        return;
      }
      wsProxy(req, socket, head);
    },
  });

  // Bring the IDE up lazily: only when already healthy on boot or on first toggle.
  probeHealth(config.codeServerPort).then((healthy) => {
    if (healthy) {
      setState("running");
      const resolved = resolveBin(config);
      if (resolved) ensureExtensions(resolved.bin, resolved.shell, config);
    }
  });

  ctx.on("dispose", () => {
    disposeStatus();
    disposeStart();
    disposeIde();
    disposeUpgrade();
    if (healthTimer) clearInterval(healthTimer);
    if (installTimer) clearTimeout(installTimer);
    if (child) {
      try {
        child.kill();
      } catch {}
      child = null;
    }
    setState("idle");
  });
}
