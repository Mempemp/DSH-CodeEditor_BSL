// dsh-bsl-editor — host half.
//
//  1. Spawns bsl-language-server in WebSocket mode (`-w`), keeps it healthy,
//     and redirects its stdout/stderr to a log file (never the console).
//  2. Serves the file tree + git status from the *DSH workspace* (the user's
//     project), not from dsh's own install directory.
//
// The browser half loads Monaco from a CDN and talks to the LSP server
// directly over a native WebSocket.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, relative, normalize, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import z from "schemastery";
import { MetaModel, META_ICON_NAMES } from "./metadata.js";

export const name = "dsh-bsl-editor";

export const Config = z.object({
  /** bsl-language-server WebSocket listen port. */
  serverPort: z.number().default(8025),
  /** Explicit path to bsl-language-server.exe; empty = auto-resolve. */
  serverBin: z.string().default(""),
  /** Workspace root override; empty = the DSH workspace (project), else dsh cwd. */
  workspaceDir: z.string().default(""),
  /** File extensions treated as BSL/OS sources. */
  sourceExtensions: z.array(z.string()).default([".bsl", ".os"]),
});

// webServer (HTTP routes) + workspaceRegistry (the user's DSH workspaces).
export const inject = ["webServer", "workspaceRegistry"];

const DEFAULT_BIN = join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "Programs", "bsl-language-server", "bsl-language-server", "bsl-language-server.exe",
);

const LOG_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dsh-bsl-editor");
const LOG_FILE = join(LOG_DIR, "server.log");
const CONFIG_FILE = join(LOG_DIR, "bsl-language-server.json");

// Text file extensions the editor opens as text (everything else = [binary file]).
const TEXT_EXTENSIONS = new Set([".bsl", ".os", ".md", ".markdown", ".txt", ".json", ".xml", ".yml", ".yaml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".html", ".htm", ".css", ".scss", ".less", ".sh", ".bat", ".cmd", ".ps1", ".ini", ".toml", ".cfg", ".conf", ".csv", ".log", ".sql", ".gradle", ".kt", ".java", ".cs", ".go", ".rs", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".proto"]);

/** @type {string} */
let state = "idle";
/** @type {string} */
let reason = "";
/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
/** @type {number | null} */
let childPid = null;
/** @type {ReturnType<typeof setInterval> | null} */
let healthTimer = null;

function setState(next, why = "") {
  state = next;
  reason = why;
}

function resolveBin(config) {
  if (config.serverBin) return config.serverBin;
  if (existsSync(DEFAULT_BIN)) return DEFAULT_BIN;
  return null;
}

function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

// Kill the whole process tree. bsl-language-server.exe re-spawns itself
// (launcher -> inner JVM), so child.kill() alone leaves an orphan on the port.
function killTree() {
  if (childPid) {
    try {
      spawnSync("taskkill", ["/PID", String(childPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
    childPid = null;
  }
  if (child) {
    try { child.kill(); } catch {}
    child = null;
  }
}

function startServer(config, root) {
  const bin = resolveBin(config);
  if (!bin) {
    setState("missing", "bsl-language-server not found — install it to " + DEFAULT_BIN);
    return;
  }
  killTree();

  // bsl-language-server config: `sendErrors: "never"` stops the crash-report
  // prompt (window/showMessageRequest) that otherwise BLOCKS the initialize
  // handshake when it can't parse a Designer-format Configuration.xml.
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (!existsSync(CONFIG_FILE)) {
      writeFileSync(CONFIG_FILE, JSON.stringify({ language: "ru", sendErrors: "never" }, null, 2) + "\n", "utf-8");
    }
  } catch {}

  let logFd = null;
  try {
    logFd = openSync(LOG_FILE, "a");
  } catch { logFd = null; }

  child = spawn(bin, ["-w", "--server.port=" + config.serverPort, "--configuration=" + CONFIG_FILE], {
    cwd: root,
    windowsHide: true,
    detached: true,
    // stdout/stderr go to a log file — never the dsh console, so the UI tab
    // can't be flooded with Spring Boot/Tomcat logs.
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
  });
  childPid = child.pid ?? null;
  child.on("exit", (code) => {
    child = null;
    childPid = null;
    if (state !== "idle") setState("missing", "bsl-language-server exited (code " + code + ") — see " + LOG_FILE);
  });
  setState("starting", "waiting for bsl-language-server");
  let attempts = 0;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    attempts += 1;
    if (await probePort(config.serverPort)) {
      clearInterval(healthTimer);
      healthTimer = null;
      setState("running");
    } else if (attempts > 120) {
      clearInterval(healthTimer);
      healthTimer = null;
      setState("missing", "bsl-language-server did not become healthy in 4 minutes");
    }
  }, 2000);
}

// --- workspace-path safety (mirrors dsh-file's resolveInside) ---
async function resolveInside(root, requested) {
  const rootReal = await fs.realpath(root);
  const normalized = requested.replace(/\\/g, "/");
  const abs = isAbsolute(normalized)
    ? normalize(normalized)
    : join(rootReal, ...normalized.replace(/^\/+/, "").split("/"));
  const rel = relative(rootReal, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes the workspace root: " + requested);
  }
  return abs;
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function handleTree(root, url, res) {
  const path = url.searchParams.get("path") || "";
  try {
    const dir = await resolveInside(root, path || ".");
    const entries = [];
    const names = await fs.readdir(dir, { withFileTypes: true });
    for (const d of names) {
      if (d.name === ".git" || d.name === "node_modules") continue;
      const type = d.isDirectory() ? "directory" : d.isFile() ? "file" : "other";
      const full = join(dir, d.name);
      let size, mtimeMs;
      try {
        const st = await fs.stat(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {}
      entries.push({ name: d.name, type, size, mtimeMs });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
    json(res, 200, { root, path: dir, entries });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

// In-memory filename index: walk the workspace once, then filter in memory.
// The walk is the slow part (a 1C config has thousands of nested dirs), so it's
// cached with a TTL and warmed eagerly in the background on startup — after the
// first build, every keystroke is a pure in-memory substring scan.
let searchIndex = { builtAt: 0, entries: [] };
let indexBuilding = null;
const INDEX_TTL = 30_000;

async function buildSearchIndex(root) {
  const entries = [];
  async function walk(dir, depth) {
    if (depth > 14) return;
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (d.name === ".git" || d.name === "node_modules" || d.name === ".pnpm-store") continue;
      const full = join(dir, d.name);
      entries.push({
        name: d.name,
        path: full,
        rel: relative(root, full).replace(/\\/g, "/"),
        type: d.isDirectory() ? "directory" : d.isFile() ? "file" : "other",
      });
      if (d.isDirectory()) await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return entries;
}

function ensureIndex(root) {
  const stale = Date.now() - searchIndex.builtAt > INDEX_TTL;
  // Refresh in the background when stale — a rebuild takes ~3s on a 1C config,
  // so it must never block a keystroke. Serve whatever we have immediately.
  if (stale && !indexBuilding) {
    indexBuilding = buildSearchIndex(root)
      .then((entries) => { searchIndex = { builtAt: Date.now(), entries }; })
      .catch(() => {})
      .finally(() => { indexBuilding = null; });
  }
  if (searchIndex.entries.length > 0) return Promise.resolve(searchIndex.entries);
  // No cached index yet (very first call): wait for the in-flight build, or build now.
  if (indexBuilding) return indexBuilding.then(() => searchIndex.entries);
  return buildSearchIndex(root).then((entries) => { searchIndex = { builtAt: Date.now(), entries }; return entries; });
}

async function handleSearch(root, url, res) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!q) return json(res, 200, { root, query: "", results: [] });
  try {
    const entries = await ensureIndex(root);
    const results = entries.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 200);
    json(res, 200, { root, query: q, results });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

async function handleRead(root, url, res, config) {
  const path = url.searchParams.get("path") || "";
  try {
    const abs = await resolveInside(root, path);
    const st = await fs.stat(abs);
    if (st.isDirectory()) return json(res, 400, { error: "is a directory" });
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    const content = TEXT_EXTENSIONS.has(ext) && st.size < 5 * 1024 * 1024
      ? readFileSync(abs, "utf-8")
      : "[binary file]";
    json(res, 200, { path: abs, content, mtimeMs: st.mtimeMs, size: st.size });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

function runGit(root, args) {
  const r = spawnSync("git", args, { cwd: root, windowsHide: true, encoding: "utf-8", timeout: 20000 });
  if (r.error || r.status !== 0) return { ok: false, output: "" };
  return { ok: true, output: r.stdout ?? "" };
}

async function handleGitStatus(root, res) {
  const r = runGit(root, ["status", "--porcelain", "-z"]);
  if (!r.ok) return json(res, 200, { ok: false, files: [] });
  const files = r.output.split("\0").filter(Boolean).map((line) => {
    const status = line.slice(0, 2).trim();
    const path = line.slice(3);
    return { status, path };
  });
  json(res, 200, { ok: true, files });
}

async function handleGitDiff(root, url, res) {
  const path = url.searchParams.get("path") || "";
  const abs = await resolveInside(root, path).catch(() => "");
  if (!abs) return json(res, 400, { error: "bad path" });
  const rel = relative(root, abs);
  const work = runGit(root, ["diff", "--", rel]);
  const cached = runGit(root, ["diff", "--cached", "--", rel]);
  json(res, 200, { ok: true, path: rel, diff: (cached.ok ? cached.output : "") + (work.ok ? work.output : "") });
}

// --- 1C metadata tree (see metadata.js) ------------------------------------

// The plugin may be loaded from a bundled location; resolve the icons dir by
// walking up from this module until resources/icons is found.
let iconDir = null;
function resolveIconDir() {
  if (iconDir) return iconDir;
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "resources", "icons");
    if (existsSync(candidate)) {
      iconDir = candidate;
      return iconDir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function svgIconFile(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  const dir = resolveIconDir();
  if (!dir) return null;
  const p = join(dir, name + ".svg");
  return existsSync(p) ? p : null;
}

let metaModel = null;
function getMetaModel(root) {
  // Keyed by root: a workspace switch re-creates the model instead of
  // serving stale metadata for the previous project.
  if (!metaModel || metaModel.root !== root) metaModel = new MetaModel(root);
  return metaModel;
}

async function handleMetaStatus(root, _url, res) {
  try {
    const m = getMetaModel(root);
    await m.init();
    json(res, 200, {
      ok: true,
      format: m.format,
      configRoot: m.configRoot,
      configName: m.configRoot.split(/[\\/]/).pop() || "",
      groups: (m.groupsCache ?? []).length,
    });
  } catch (e) {
    json(res, 200, { ok: false, error: e.message });
  }
}

async function handleMetaList(root, url, res) {
  try {
    const m = getMetaModel(root);
    await m.init();
    const { items } = await m.list(url.searchParams.get("p") || "");
    json(res, 200, { ok: true, format: m.format, items });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

async function handleMetaSearch(root, url, res) {
  try {
    const m = getMetaModel(root);
    const results = await m.search(url.searchParams.get("q") || "");
    json(res, 200, { ok: true, results });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

function handleIcon(_root, url, res) {
  const name = (url.pathname || "").split("/").pop().replace(/\.svg$/i, "");
  const p = svgIconFile(name);
  if (!p) return json(res, 404, { error: "icon not found" });
  res.writeHead(200, {
    "content-type": "image/svg+xml",
    "cache-control": "public, max-age=86400",
  });
  res.end(readFileSync(p));
}

export function apply(ctx, config) {
  // The user's project comes from the DSH workspace registry; fall back to dsh
  // cwd only when there is no workspace (never dsh's install dir by accident).
  const workspaces = (() => {
    try {
      return (ctx.workspaceRegistry?.list?.() ?? []).map((w) => ({ id: w.id, path: w.path, title: w.title }));
    } catch {
      return [];
    }
  })();
  const root = config.workspaceDir || (workspaces[0]?.path ?? process.cwd());

  // Warm the filename index in the background so the first search is instant.
  ensureIndex(root).catch(() => {});

  ctx.webServer.register({
    kind: "exact", path: "/bsl/lsp-status",
    handler: (_req, res) => json(res, 200, { state, reason, port: config.serverPort, logFile: LOG_FILE }),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/lsp-start",
    handler: async (_req, res) => {
      if (state !== "running" && !(await probePort(config.serverPort))) startServer(config, root);
      // Block until the server is actually ready (JVM + Tomcat boot takes 2-10s),
      // so the client can connect right after instead of racing the boot.
      const deadline = Date.now() + 30000;
      while (state === "starting" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      json(res, 202, { ok: true, state });
    },
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/workspaces",
    handler: (_req, res) => json(res, 200, { root, workspaces }),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/logs",
    handler: (_req, res) => {
      try {
        const tail = readFileSync(LOG_FILE, "utf-8").split("\n").slice(-200).join("\n");
        json(res, 200, { ok: true, log: tail });
      } catch {
        json(res, 200, { ok: false, log: "(no log yet)" });
      }
    },
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/tree",
    handler: (req, res) => handleTree(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/search",
    handler: (req, res) => handleSearch(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/read",
    handler: (req, res) => handleRead(root, new URL(req.url, "http://x"), res, config),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/git-status",
    handler: (_req, res) => handleGitStatus(root, res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/git-diff",
    handler: (req, res) => handleGitDiff(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/meta/status",
    handler: (req, res) => handleMetaStatus(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/meta/list",
    handler: (req, res) => handleMetaList(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/meta/search",
    handler: (req, res) => handleMetaSearch(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/icons",
    handler: (req, res) => handleIcon(root, new URL(req.url, "http://x"), res),
  });

  // Adopt an already-running server on boot.
  probePort(config.serverPort).then((up) => {
    if (up) setState("running");
  });

  ctx.on("dispose", () => {
    if (healthTimer) clearInterval(healthTimer);
    killTree();
    setState("idle");
  });
}
