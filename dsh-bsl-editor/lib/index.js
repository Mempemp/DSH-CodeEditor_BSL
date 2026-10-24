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
  /** LSP master switch; off by default — unstable on large configurations. */
  lspEnabled: z.boolean().default(false),
  /** Intercept chat file-link clicks (remote.session.openWorkspacePath). */
  interceptChatOpen: z.boolean().default(true),
  /** Explicit path to git.exe; empty = auto-resolve (bundled copy, PATH, Git for Windows). */
  gitPath: z.string().default(""),
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
// User settings saved from the in-tab settings panel (override the defaults).
const PLUGIN_CONFIG_FILE = join(LOG_DIR, "plugin-config.json");

function loadPluginOverrides() {
  try {
    const raw = readFileSync(PLUGIN_CONFIG_FILE, "utf-8");
    const o = JSON.parse(raw);
    return typeof o === "object" && o !== null ? o : {};
  } catch {
    return {};
  }
}

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
  // changed=1: ограничить выдачу файлами из git-status (режим «Изменённые»).
  let changedSet = null;
  if (url.searchParams.get("changed")) {
    try {
      const st = await new Promise((resolve, reject) => {
        // Мок-res под реальный хелпер json() (writeHead/end).
        handleGitStatus(root, { writeHead: () => {}, end: (b) => resolve(JSON.parse(b)) }, null).catch(reject);
        setTimeout(() => reject(new Error("git status timeout")), 5000);
      });
      changedSet = new Set((st?.files || []).map((f) => String(f.path || "").replace(/\\/g, "/").replace(/\/+$/, "")));
    } catch { changedSet = new Set(); }
  }
  try {
    const entries = await ensureIndex(root);
    // Ищем и по имени, и по полному пути: запрос «загру» должен находить
    // Module.bsl внутри Forms/ФормаЗагрузки, а не только файлы с «Загруз» в
    // имени. Совпадения по имени ранжируются выше совпадений по пути.
    const hits = [];
    for (const e of entries) {
      const byName = e.name.toLowerCase().includes(q);
      if (byName || (e.rel && e.rel.toLowerCase().includes(q))) hits.push({ e, rank: byName ? 0 : 1 });
    }
    hits.sort((a, b) => a.rank - b.rank);
    let results = hits.map((h) => h.e);
    if (changedSet) results = results.filter((e) => changedSet.has(String(e.rel).replace(/\/+$/, "")));
    results = results.slice(0, 200);
    json(res, 200, { root, query: q, results });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

// Декодирование текстового файла: UTF-8 (строго) или Windows-1251.
// readFileSync("utf-8") МОЛЧА заменяет невалидные байты на U+FFFD — это
// портит cp1251-файлы 1С при пересохранении; поэтому кодировка
// определяется явно и сохраняется (handleWrite пишет в той же кодировке).
const WINDOWS_1251_TO_UNICODE = (() => {
  // 0x80..0xFF в cp1251 → кодовая точка Unicode (кириллица 0xC0..0xFF
  // линейна: U+0410..U+044F), спецсимволы 0x80..0xBF — таблица ниже.
  const map = new Array(128);
  // 0xC0-0xDF: А..Я (U+0410..U+042F), 0xE0-0xFF: а..я (U+0430..U+044F)
  for (let b = 0xc0; b <= 0xff; b++) map[b - 0x80] = b < 0xe0 ? 0x410 + (b - 0xc0) : 0x430 + (b - 0xe0);
  const special = {
    0x80: 0x402, 0x81: 0x403, 0x82: 0x201a, 0x83: 0x453, 0x84: 0x201e, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x20ac, 0x89: 0x2030, 0x8a: 0x409, 0x8b: 0x2039,
    0x8c: 0x40a, 0x8d: 0x40c, 0x8e: 0x40b, 0x8f: 0x40f, 0x90: 0x452, 0x91: 0x2018,
    0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x3f, 0x99: 0x2122, 0x9a: 0x459, 0x9b: 0x203a, 0x9c: 0x45a, 0x9d: 0x45c,
    0x9e: 0x45b, 0x9f: 0x45f, 0xa0: 0xa0, 0xa1: 0x40e, 0xa2: 0x45e, 0xa3: 0x408,
    0xa4: 0xa4, 0xa5: 0x490, 0xa6: 0xa6, 0xa7: 0xa7, 0xa8: 0x401, 0xa9: 0xa9,
    0xaa: 0x404, 0xab: 0xab, 0xac: 0xac, 0xad: 0xad, 0xae: 0xae, 0xaf: 0x407,
    0xb0: 0xb0, 0xb1: 0xb1, 0xb2: 0x406, 0xb3: 0x456, 0xb4: 0x491, 0xb5: 0xb5,
    0xb6: 0xb6, 0xb7: 0xb7, 0xb8: 0x451, 0xb9: 0x2116, 0xba: 0x454, 0xbb: 0xbb,
    0xbc: 0x458, 0xbd: 0x405, 0xbe: 0x455, 0xbf: 0x457,
  };
  for (const [b, cp] of Object.entries(special)) map[Number(b) - 0x80] = cp;
  return map;
})();

function decodeTextFile(buf) {
  // Строгий UTF-8: TextDecoder(fatal) бросает на невалидных байтах.
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {}
  // Windows-1251 — родная кодировка 1С-Конфигуратора для старых файлов.
  let out = "";
  for (const b of buf) out += String.fromCharCode(b < 0x80 ? b : WINDOWS_1251_TO_UNICODE[b - 0x80]);
  return { text: out, encoding: "windows-1251" };
}

function encodeTextFile(text, encoding) {
  if (encoding !== "windows-1251") return Buffer.from(text, "utf-8");
  // Обратная таблица: Unicode → cp1251 (построение лениво, один раз).
  const unicodeTo1251 = (() => {
    const rev = new Map();
    WINDOWS_1251_TO_UNICODE.forEach((cp, i) => { if (!rev.has(cp)) rev.set(cp, i + 0x80); });
    return rev;
  })();
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else {
      const b = unicodeTo1251.get(code);
      bytes.push(b ?? 0x3f); // ? — символ вне cp1251
    }
  }
  return Buffer.from(bytes);
}

async function handleRead(root, url, res, config) {
  const path = url.searchParams.get("path") || "";
  try {
    const abs = await resolveInside(root, path);
    const st = await fs.stat(abs);
    if (st.isDirectory()) return json(res, 400, { error: "is a directory" });
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) && st.size < 5 * 1024 * 1024) {
      const raw = readFileSync(abs);
      const { text, encoding } = decodeTextFile(raw);
      // BOM определяется по сырым байтам: TextDecoder срезает его из текста
      // автоматически, поэтому по строке его не увидеть.
      const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      json(res, 200, { path: abs, content: text, bom, encoding, mtimeMs: st.mtimeMs, size: st.size });
    } else {
      json(res, 200, { path: abs, content: "[binary file]", bom: false, encoding: "utf-8", mtimeMs: st.mtimeMs, size: st.size });
    }
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

// Лёгкая проверка метаданных файла (для hot-reload открытых вкладок).
async function handleStat(root, url, res) {
  const path = url.searchParams.get("path") || "";
  try {
    const abs = await resolveInside(root, path);
    const st = await fs.stat(abs);
    json(res, 200, { path: abs, mtimeMs: st.mtimeMs, size: st.size });
  } catch (e) {
    json(res, 404, { error: e.message });
  }
}

// --- git: какой бинарник использовать --------------------------------------
// Диффы, бейджи и кнопки «В индекс» / «Коммит» работают через настоящий git.
// Порядок поиска: путь из настроек плагина → папка, куда сборка «DSH для 1С»
// кладёт свой git (MinGit) → PATH → типовые места установки Git for Windows.
// Найденный путь кэшируем на минуту: git на ходу не переезжает, а spawn на
// каждый показ диффа — лишние процессы.
// Раскладки, в которых встречается git.exe: MinGit кладёт cmd/git.exe,
// сборки на msys2 — mingw64/ или ucrt64/bin, портативные — в корень.
const GIT_BIN_RELATIVE = ["cmd/git.exe", "bin/git.exe", "mingw64/bin/git.exe", "ucrt64/bin/git.exe", "git.exe"];
let gitBin = "git";
let gitConfig = null;
let gitResolveCache = { key: "", at: 0, info: null };

function gitInstallDirs() {
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const lad = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return [
    { dir: join(dshHome, "git"), source: "комплект DSH для 1С" },
    { dir: join(pf, "Git"), source: "установленный Git" },
    { dir: join(pf86, "Git"), source: "установленный Git" },
    { dir: join(lad, "Programs", "Git"), source: "установленный Git" },
  ];
}

function probeGitExe(exe) {
  const r = spawnSync(exe, ["--version"], { windowsHide: true, encoding: "utf-8", timeout: 10000 });
  if (r.error || r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

function resolveGit(config, opts = {}) {
  const explicitPath = String(config?.gitPath || "").trim();
  const key = explicitPath + "|" + (process.env.DSH_HOME || "");
  if (!opts.fresh && gitResolveCache.info && gitResolveCache.key === key && Date.now() - gitResolveCache.at < 60_000) {
    gitBin = gitResolveCache.info.found ? gitResolveCache.info.path : "git";
    return gitResolveCache.info;
  }
  const tried = [];
  const remember = (info) => {
    gitBin = info.found ? info.path : "git";
    gitResolveCache = { key, at: Date.now(), info };
    return info;
  };
  if (explicitPath) {
    tried.push(explicitPath);
    const v = probeGitExe(explicitPath);
    if (v) return remember({ found: true, path: explicitPath, version: v, source: "путь из настроек", tried });
  }
  for (const { dir, source } of gitInstallDirs()) {
    for (const rel of GIT_BIN_RELATIVE) {
      const exe = join(dir, rel);
      if (!existsSync(exe)) continue;
      tried.push(exe);
      const v = probeGitExe(exe);
      if (v) return remember({ found: true, path: exe, version: v, source, tried });
    }
  }
  tried.push("git в PATH");
  const fromPath = probeGitExe("git");
  if (fromPath) return remember({ found: true, path: "git", version: fromPath, source: "PATH", tried });
  return remember({ found: false, path: "", version: "", source: "", tried });
}

function ensureGitResolved() {
  if (gitConfig && !gitResolveCache.info) resolveGit(gitConfig);
}

function runGit(root, args) {
  ensureGitResolved();
  const r = spawnSync(gitBin, args, { cwd: root, windowsHide: true, encoding: "utf-8", timeout: 20000 });
  if (r.error || r.status !== 0) return { ok: false, output: "" };
  return { ok: true, output: r.stdout ?? "" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 16 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function handleWrite(root, req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const path = String(body.path || "");
    const content = String(body.content ?? "");
    const abs = await resolveInside(root, path);
    const st = await fs.stat(abs).catch(() => null);
    if (st && st.isDirectory()) return json(res, 400, { error: "is a directory" });
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return json(res, 400, { error: "not a text file" });
    // Кодировку и BOM берём из САМОГО ФАЙЛА на диске (источник истины):
    // флаги клиента могут быть устаревшими (быстрый Ctrl+S до ответа read).
    // Клиентские значения используются только для нового файла (нет на диске).
    let encoding = "utf-8";
    let bomFlag = false;
    if (st) {
      const head = readFileSync(abs);
      bomFlag = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
      try { new TextDecoder("utf-8", { fatal: true }).decode(head); } catch { encoding = "windows-1251"; }
    } else {
      bomFlag = body.bom === true;
      encoding = body.encoding === "windows-1251" ? "windows-1251" : "utf-8";
    }
    let text = bomFlag && !content.startsWith("\ufeff") ? "\ufeff" + content : content;
    await fs.writeFile(abs, encodeTextFile(text, encoding));
    // Сохранение могло изменить git-статус (M / ?? / чисто): сбрасываем кэш
    // статусов и помечаем индекс имён устаревшим, иначе свежий файл не виден
    // ни в дереве, ни в режиме «Изменённые».
    gitStatusCache.delete(root);
    searchIndex.builtAt = 0;
    json(res, 200, { ok: true, path: abs, bom: bomFlag, encoding });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

// Кэш git-status: spawn git на большом репо занимает секунды, а статус нужен
// на каждый клик по дереву метаданных в режиме фильтра.
let gitStatusCache = new Map(); // root -> { at, files }
const GIT_STATUS_TTL = 5000;
async function handleGitStatus(root, res, opts) {
  // fresh=1 — явное обновление из интерфейса (кнопка «Обновить дерево»):
  // кэш не читаем, иначе на экране остаются статусы пятисекундной давности.
  const fresh = opts === true || (opts !== null && typeof opts === "object" && opts.fresh === true);
  const git = resolveGit(gitConfig, { fresh });
  // Без git показывать нечего — и молчать об этом нельзя: пустой список
  // изменений читается как «изменений нет», хотя причина другая.
  if (!git.found) return json(res, 200, { ok: false, files: [], git, reason: "no-git" });
  if (fresh) gitStatusCache.delete(root);
  const cached = gitStatusCache.get(root);
  if (cached && Date.now() - cached.at < GIT_STATUS_TTL) {
    return json(res, 200, { ok: true, files: cached.files, git });
  }
  // Новые файлы показываем всегда: --untracked-files=all перечисляет их
  // поштучно вместо свёртки каталога в одну строку "?? dir/".
  const r = runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!r.ok) {
    const repo = runGit(root, ["rev-parse", "--show-toplevel"]);
    return json(res, 200, { ok: false, files: [], git, reason: repo.ok ? "status-failed" : "no-repo" });
  }
  const files = [];
  const parts = r.output.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line || line.length < 4) continue;
    const status = line.slice(0, 2).trim();
    const path = line.slice(3).replace(/\\/g, "/").replace(/\/+$/, "");
    if (path) files.push({ status, path });
    // Переименование/копия: следующая часть — исходный путь, пропускаем её.
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
  }
  gitStatusCache.set(root, { at: Date.now(), files });
  json(res, 200, { ok: true, files, git });
}

// Разбор unified diff на изменения: заголовок файла («diff --git …» + «---»/«+++»)
// и массив изменений, каждый — строки начиная с «@@». Нужен, чтобы откатывать
// ровно один изменение и чтобы клиент мог сослаться на изменение по номеру.
function splitDiffHunks(diff) {
  const lines = String(diff || "").split("\n");
  // Дифф кончается переводом строки: в конце остаётся пустой «хвост». Если его
  // не отбросить, он прилипает к ПОСЛЕДНЕМУ изменению в файле — и у того же
  // изменения в другом диффе (там оно не последнее) отпечаток получается другим.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const hi = lines.findIndex((l) => l.startsWith("@@"));
  if (hi < 0) return { header: "", hunks: [] };
  const header = lines.slice(0, hi).join("\n") + "\n";
  const hunks = [];
  let cur = null;
  for (let i = hi; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) {
      if (cur) hunks.push(cur);
      cur = [];
    }
    if (cur) cur.push(lines[i]);
  }
  if (cur) hunks.push(cur);
  return { header, hunks };
}

// Тот же runGit, но с stderr: причина отказа git apply иначе не видна.
function runGitErr(root, args) {
  ensureGitResolved();
  const r = spawnSync(gitBin, args, { cwd: root, windowsHide: true, encoding: "utf-8", timeout: 20000 });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: String(r.stderr ?? "").trim() };
}

// Дифф берём БЕЗ строк контекста (-U0). С обычными тремя строками git склеивает
// разные правки, стоящие через несколько неизменённых строк, в ОДИН изменение — и
// тогда одна пара кнопок «принять/отклонить» накрывала бы сразу две правки, а
// отказ по одной откатывал бы и соседнюю. Без контекста каждый изменение — ровно
// изменённые строки, и граница блока совпадает с границей правки.
// Такой патч (без строк контекста) git применяет только с --unidiff-zero.
const DIFF_ARGS = ["-U0"];

// Отпечаток текста изменения — ТОТ ЖЕ, что считает клиент (lib/client.js,
// hashChunk): по нему хост узнаёт просмотренные изменения в свежем diff'е.
// Держать их одинаковыми обязательно, и это проверяется тестом
// tests/_stage.mjs: расхождение видно как «просмотренный изменение не нашёлся».
// Отпечаток вместо самого текста — чтобы отметки не тащили в файл хранилища
// копию изменённых строк (большой изменение не влезал в лимит и молча не
// индексировался).
function hashChunk(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function handleGitDiff(root, url, res) {
  const path = url.searchParams.get("path") || "";
  const abs = await resolveInside(root, path).catch(() => "");
  if (!abs) return json(res, 400, { error: "bad path" });
  const rel = relative(root, abs);
  const work = runGit(root, ["diff", ...DIFF_ARGS, "--", rel]);
  const cached = runGit(root, ["diff", ...DIFF_ARGS, "--cached", "--", rel]);
  // Изменение из индекса откатывается иначе, чем изменение рабочей копии
  // (см. handleRevertHunk), поэтому два diff'а отдаются раздельно — по «diff»
  // клиент их не различил бы.
  const cachedDiff = cached.ok ? cached.output : "";
  const workDiff = work.ok ? work.output : "";
  json(res, 200, { ok: true, path: rel, diff: cachedDiff + workDiff, cachedDiff, workDiff });
}

// Откат ОДНОГО изменения диффа к состоянию HEAD.
//   source = "index"    — изменение лежит в индексе (git add): откатываем индекс И
//                         файл одной операцией (git apply -R --index);
//   source = "worktree" — только рабочая копия.
// Клиент присылает НОМЕР изменения и его строку «@@»: diff берётся заново, и если
// по этому номеру лежит уже другой изменение — отказ (файл изменился, пока
// рисовался вид; откатывать вслепую нельзя).
async function handleRevertHunk(root, req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const abs = await resolveInside(root, String(body.path || ""));
    const rel = relative(root, abs);
    const source = body.source === "index" ? "index" : "worktree";
    const index = Number(body.index);
    const diff = runGit(root, ["diff", ...DIFF_ARGS, ...(source === "index" ? ["--cached"] : []), "--", rel]);
    if (!diff.ok) return json(res, 400, { ok: false, error: "git diff не отработал" });
    const { header, hunks } = splitDiffHunks(diff.output);
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length) {
      return json(res, 409, { ok: false, error: "файл изменился — обновите вид" });
    }
    const hunk = hunks[index].join("\n") + "\n";
    const expect = String(body.expect || "");
    if (expect && !hunk.startsWith(expect)) {
      return json(res, 409, { ok: false, error: "файл изменился — обновите вид" });
    }
    mkdirSync(LOG_DIR, { recursive: true });
    const patchFile = join(LOG_DIR, "revert-hunk.patch");
    writeFileSync(patchFile, header + hunk, "utf-8");
    const args = ["apply", "-R", "--unidiff-zero", "--whitespace=nowarn"];
    if (source === "index") args.push("--index");
    args.push(patchFile);
    const applied = runGitErr(root, args);
    if (!applied.ok) return json(res, 400, { ok: false, error: applied.err || "git apply -R не прошёл" });
    gitStatusCache.delete(root);
    json(res, 200, { ok: true, index, source });
  } catch (e) {
    json(res, 400, { ok: false, error: e?.message || String(e) });
  }
}

// Откат файла целиком к HEAD — индекс и рабочая копия одним движением
// (как «Undo File» в Cursor: правок в файле не остаётся). Новый (untracked)
// файл сюда не попадает: версии в HEAD у него нет и изменений диффа тоже нет.
async function handleRevertFile(root, req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const abs = await resolveInside(root, String(body.path || ""));
    const rel = relative(root, abs).replace(/\\/g, "/");
    const r = runGitErr(root, ["checkout", "HEAD", "--", rel]);
    if (!r.ok) return json(res, 400, { ok: false, error: r.err || "git checkout не прошёл" });
    gitStatusCache.delete(root);
    json(res, 200, { ok: true, path: rel });
  } catch (e) {
    json(res, 400, { ok: false, error: e?.message || String(e) });
  }
}

// Отметки «просмотрено» для изменений диффа. Живут на машине, не в проекте:
// %LOCALAPPDATA%/dsh-bsl-editor/reviewed.json → { root: { <rel>: { headSha, marks } } }.
// Ключ включает HEAD: после коммита отметки прошлой ревизии не значат ничего.
// В marks хранится id изменения (для подсветки) и его СЫРОЙ текст (заголовок «@@» и
// строки тела): по тексту хост отбирает, что отправить в индекс, — точное
// совпадение содержимого, без второго разбора diff'а на стороне хоста.
const REVIEWED_FILE = join(LOG_DIR, "reviewed.json");
function loadReviewed() {
  try {
    const o = JSON.parse(readFileSync(REVIEWED_FILE, "utf-8"));
    return o && typeof o === "object" ? o : {};
  } catch { return {}; }
}

// Отпечатки одного изменения: по телу (без строки «@@») и по всему тексту.
// Второй вариант читают отметки, записанные прежними сборками.
function hunkKeysOf(lines) {
  return [hashChunk(lines.slice(1).join("\n")), hashChunk(lines.join("\n"))];
}

// Изменения файла прямо сейчас: рабочая копия и индекс. По ним опознаётся, что
// ещё живо, а что уже ушло из файла (в коммит или под чужую правку).
function changeIndex(root, rel) {
  const workDiff = splitDiffHunks(runGit(root, ["diff", ...DIFF_ARGS, "--", rel]).output || "");
  const idxDiff = splitDiffHunks(runGit(root, ["diff", "--cached", ...DIFF_ARGS, "--", rel]).output || "");
  const keys = new Set();
  const texts = new Set();
  for (const lines of [...workDiff.hunks, ...idxDiff.hunks]) {
    for (const k of hunkKeysOf(lines)) keys.add(k);
    texts.add(lines.join("\n"));
  }
  return { workDiff, idxDiff, keys, texts };
}

// Изменение отметки ещё есть в файле?
function markInFile(idx, m) {
  if (typeof m.fp === "string" && m.fp) return idx.keys.has(m.fp);
  if (typeof m.text === "string" && m.text) return idx.texts.has(m.text);
  return false; // отметка без отпечатка и без текста: сверять не с чем
}

// Отметки прошлой ревизии (после коммита) держим ровно те, чьё изменение в файле
// осталось. Коммит не должен стирать отметки у правок, которые в индекс ещё не
// попали: человек их уже посмотрел. Уходят те, что уехали в коммит, и те, что
// кто-то правил после просмотра. Отметки прежних сборок (без отпечатка и текста)
// оставляем — сверить их нечем, а лишними на экране они не бывают: правки под них
// в файле уже нет, и клиент уберёт их сам при первой же записи.
function pruneReviewed(root, rel) {
  const store = loadReviewed();
  const forRoot = store[root] && store[root][rel] ? store[root] : null;
  if (!forRoot) return [];
  const entry = forRoot[rel];
  const idx = changeIndex(root, rel);
  const live = (Array.isArray(entry.marks) ? entry.marks : []).filter((m) => {
    const known = (typeof m.fp === "string" && m.fp) || (typeof m.text === "string" && m.text);
    return known ? markInFile(idx, m) : true;
  });
  if (live.length) forRoot[rel] = { headSha: headOf(root), marks: live, hashes: live.map((m) => m.id) };
  else delete forRoot[rel];
  if (!Object.keys(forRoot).length) delete store[root];
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(REVIEWED_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
  return live;
}
async function handleReviewed(root, req, url, res) {
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const headSha = head.ok ? head.output.trim() : "";
  if (req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const abs = await resolveInside(root, String(body.path || ""));
      const rel = relative(root, abs).replace(/\\/g, "/");
      // Новый формат — marks; старый (только хеши) принимаем, чтобы клиент
      // прошлой сборки не остался без отметок.
      // Отметки собираем по id: сначала всё, что клиент считает просмотренным
      // (hashes), затем поверх — отпечатки тех изменений, что он видит сейчас.
      // Так отметка не пропадает оттого, что изменения нет в кадре (другая вкладка,
      // показанные просмотренные), а для индексации достаточно отпечатка.
      const byId = new Map();
      if (Array.isArray(body.hashes)) {
        for (const id of body.hashes.slice(0, 5000)) {
          if (typeof id === "string" && id.length < 64) byId.set(id, { id });
        }
      }
      if (Array.isArray(body.marks)) {
        for (const m of body.marks.slice(0, 5000)) {
          if (!m || typeof m.id !== "string" || m.id.length >= 64) continue;
          const prev = byId.get(m.id) || { id: m.id };
          if (typeof m.fp === "string" && m.fp.length < 32) prev.fp = m.fp;
          else if (typeof m.text === "string") prev.text = m.text.slice(0, 20000); // старый формат
          byId.set(m.id, prev);
        }
      }
      const marks = [...byId.values()];
      const hashes = marks.map((m) => m.id);
      const store = loadReviewed();
      const forRoot = store[root] && typeof store[root] === "object" ? store[root] : {};
      if (marks.length) forRoot[rel] = { headSha, marks, hashes };
      else delete forRoot[rel];
      if (Object.keys(forRoot).length) store[root] = forRoot;
      else delete store[root];
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(REVIEWED_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
      return json(res, 200, { ok: true, headSha, hashes });
    } catch (e) {
      return json(res, 400, { ok: false, error: e?.message || String(e) });
    }
  }
  const path = url.searchParams.get("path") || "";
  try {
    const abs = await resolveInside(root, path);
    const rel = relative(root, abs).replace(/\\/g, "/");
    const entry = loadReviewed()[root]?.[rel];
    // Отметки прошлой ревизии не выбрасываем подчистую: те, чьё изменение в файле
    // осталось (ещё не в индексе), должны пережить коммит. Разбирает pruneReviewed.
    const marks = !entry
      ? []
      : entry.headSha === headSha
        ? (Array.isArray(entry.marks) ? entry.marks : [])
        : pruneReviewed(root, rel);
    json(res, 200, { ok: true, headSha, hashes: marks.map((m) => m.id) });
  } catch (e) {
    json(res, 400, { ok: false, error: e?.message || String(e) });
  }
}

// --- Индексация просмотренного и коммит ------------------------------------

function headOf(root) {
  const h = runGit(root, ["rev-parse", "HEAD"]);
  return h.ok ? h.output.trim() : "";
}

// Новый файл (??) — его в индексе видно целиком: базы для diff'а у него нет.
function isUntracked(root, rel) {
  const st = runGit(root, ["status", "--porcelain", "--", rel]);
  return st.ok && String(st.output).trim().startsWith("??");
}

function reviewedMarks(root, rel, headSha) {
  const entry = loadReviewed()[root]?.[rel];
  if (!entry) return [];
  // Отметки живут по изменениям, а не по ревизии: после коммита отмечать заново
  // нужно только то, что в индекс не попало, — остальное человек уже посмотрел.
  return entry.headSha === headSha ? (Array.isArray(entry.marks) ? entry.marks : []) : pruneReviewed(root, rel);
}

// Отправить в индекс ПРОСМОТРЕННЫЕ изменения одного файла: остальные строки файла
// остаются как были. Один патч на файл — git проверяет его целиком, и отбор
// идёт по точному отпечатку изменения, поэтому устаревшая отметка просто не
// найдётся, а не отправит в индекс чужие строки. Новый файл индексируется
// целиком.
//
// Изменения ищем в ДВУХ источниках: в рабочей копии (их и отправляем) и в индексе.
// Второй нужен, чтобы не называть ошибкой то, что ошибкой не является: изменение,
// уже лежащий в индексе (его отправили раньше), попадал в «не совпали», и
// человек читал «файл менялся после просмотра» там, где файл не менялся.
async function stageOneFile(root, rel) {
  try {
    if (isUntracked(root, rel)) {
      const add = runGitErr(root, ["add", "--", rel]);
      if (!add.ok) return { error: add.err || "git add не прошёл" };
      return { untracked: true, staged: 1, skipped: 0, inIndex: 0 };
    }
    const marks = reviewedMarks(root, rel, headOf(root));
    if (!marks.length) return { staged: 0, skipped: 0, inIndex: 0, reason: "no-marks", marks: 0, hunks: 0 };
    const { workDiff, idxDiff, keys: knownKeys, texts: knownTexts } = changeIndex(root, rel);
    const markFp = new Set(marks.filter((m) => typeof m.fp === "string" && m.fp).map((m) => m.fp));
    const byText = new Set(marks.filter((m) => typeof m.text === "string" && m.text).map((m) => m.text));
    const matches = (lines) => hunkKeysOf(lines).some((k) => markFp.has(k)) || byText.has(lines.join("\n"));
    const picked = workDiff.hunks.filter(matches).map((lines) => lines.join("\n"));
    const inIndex = idxDiff.hunks.filter(matches).length;
    // Отметка, которой нет ни в рабочей копии, ни в индексе: вот это и есть
    // «правку меняли после просмотра». Отметки без отпечатка и без текста сюда
    // не попадают вовсе: сверять их не с чем, и говорить про них «не совпала»
    // нельзя — именно из-за них отчёт говорил «9 изменений не совпали», хотя файл
    // никто не менял.
    const skipped = marks.filter((m) => {
      if (typeof m.fp === "string" && m.fp) return !knownKeys.has(m.fp);
      if (typeof m.text === "string" && m.text) return !knownTexts.has(m.text);
      return false;
    }).length;
    if (!picked.length) {
      return {
        staged: 0,
        skipped,
        inIndex,
        marks: marks.length,
        hunks: workDiff.hunks.length,
        // Причины те же, что и раньше (старый клиент читает именно их);
        // подробности — в числах staged/skipped/inIndex.
        reason: workDiff.hunks.length ? "no-match" : "no-diff",
      };
    }
    mkdirSync(LOG_DIR, { recursive: true });
    const patchFile = join(LOG_DIR, "stage.patch");
    writeFileSync(patchFile, workDiff.header + picked.map((t) => t + "\n").join(""), "utf-8");
    const applied = runGitErr(root, ["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", patchFile]);
    if (!applied.ok) return { error: applied.err || "git apply --cached не прошёл" };
    return {
      staged: picked.length,
      skipped,
      inIndex,
      marks: marks.length,
      hunks: workDiff.hunks.length,
      reason: "ok",
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

async function handleStage(root, req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const abs = await resolveInside(root, String(body.path || ""));
    const rel = relative(root, abs).replace(/\\/g, "/");
    const r = await stageOneFile(root, rel);
    if (r.error) return json(res, 400, { ok: false, error: r.error });
    gitStatusCache.delete(root);
    json(res, 200, {
      ok: true,
      staged: r.staged || 0,
      skipped: r.skipped || 0,
      inIndex: r.inIndex || 0,
      untracked: !!r.untracked,
      reason: r.reason || "",
      marks: r.marks || 0,
      hunks: r.hunks || 0,
    });
  } catch (e) {
    json(res, 400, { ok: false, error: e?.message || String(e) });
  }
}

// «Всё просмотренное — в индекс» по всем изменённым файлам проекта. Новые файлы
// сюда не попадают: у них отметок нет, индексируются кнопкой в своей вкладке.
async function handleStageAll(root, res) {
  try {
    const st = runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (!st.ok) return json(res, 400, { ok: false, error: "git status не отработал" });
    // В -z каждая запись — «XY путь»; у переименований следом идёт поле без
    // статуса, поэтому берём только строки с настоящим статусом.
    const rels = String(st.output)
      .split("\0")
      .filter((e) => /^[ MADRCU?!]{2} /.test(e))
      .map((e) => e.slice(3))
      .filter((rel) => rel && !isUntracked(root, rel));
    let staged = 0;
    let skipped = 0;
    let noMarks = 0;
    let already = 0;
    let inIndex = 0;
    let noMatch = 0;
    const files = [];
    const failed = [];
    for (const rel of rels) {
      const r = await stageOneFile(root, rel);
      if (r.error) { failed.push(rel + ": " + r.error); continue; }
      if (r.staged) { staged += r.staged; files.push(rel); }
      else if (r.reason === "no-marks") noMarks++;
      else if (r.reason === "no-diff" || r.reason === "in-index") already++;
      else if (r.reason === "no-match") noMatch++;
      skipped += r.skipped || 0;
      inIndex += r.inIndex || 0;
    }
    if (staged) gitStatusCache.delete(root);
    json(res, 200, { ok: true, staged, skipped, inIndex, files, failed, noMarks, already, noMatch });
  } catch (e) {
    json(res, 400, { ok: false, error: e?.message || String(e) });
  }
}

// Что лежит в индексе — для окна коммита.
function handleStaged(root, res) {
  const num = runGit(root, ["diff", "--cached", "--numstat"]);
  const files = [];
  if (num.ok) {
    for (const line of String(num.output).split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      files.push({
        path: parts.slice(2).join("\t"),
        added: parts[0] === "-" ? 0 : Number(parts[0]) || 0,
        removed: parts[1] === "-" ? 0 : Number(parts[1]) || 0,
      });
    }
  }
  json(res, 200, { ok: true, files });
}

// Коммит индекса. Сообщение приходит от человека: своего текста мы не
// придумываем, а без сообщения и без содержимого в индексе коммита не будет.
async function handleCommit(root, req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const message = String(body.message || "").replace(/\r\n/g, "\n").trim();
    if (!message) return json(res, 400, { ok: false, error: "нужно сообщение коммита" });
    const idx = runGit(root, ["diff", "--cached", "--name-only"]);
    const files = idx.ok ? String(idx.output).split("\n").filter(Boolean) : [];
    if (!files.length) return json(res, 400, { ok: false, error: "в индексе ничего нет" });
    const r = runGitErr(root, ["commit", "-m", message]);
    if (!r.ok) return json(res, 400, { ok: false, error: r.err || "git commit не прошёл" });
    gitStatusCache.delete(root);
    json(res, 200, { ok: true, files: files.length, summary: String(r.out).split("\n")[0] || "" });
  } catch (e) {
    json(res, 400, { ok: false, error: e?.message || String(e) });
  }
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
    // changed=1: активировать фильтр по git-статусам (иерархия сохраняется,
    // остаются только объекты с изменёнными файлами).
    if (url.searchParams.get("changed")) {
      const st = await new Promise((resolve, reject) => {
        handleGitStatus(root, { writeHead: () => {}, end: (b) => resolve(JSON.parse(b)) }, null).catch(reject);
        setTimeout(() => reject(new Error("git status timeout")), 5000);
      });
      // config здесь недоступен (handleMetaList не получает его) — кэш
      // git-status заполняется полным (untracked-включающим) вариантом из
      // основного роута; для фильтра это корректно.
      m.setChangedFilter(st?.files || []); // [] = изменений нет → пустое дерево
    } else if (m.changedSet !== null) {
      m.setChangedFilter(null);
    }
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

// Что с git: какой бинарник найден и видит ли он в папке проекта репозиторий.
// Нужен настройкам плагина: без git диффов и кнопок индекса нет, и человек
// должен видеть причину, а не пустой список изменений.
async function handleGitInfo(root, url, res) {
  const fresh = url.searchParams.get("fresh") === "1";
  const git = resolveGit(gitConfig, { fresh });
  let repo = "";
  if (git.found) {
    const r = runGit(root, ["rev-parse", "--show-toplevel"]);
    repo = r.ok ? r.output.trim() : "";
  }
  json(res, 200, { ok: true, root, git, repo });
}

// Папка проекта без репозитория — обычное состояние свежего проекта: git привозит установщик,
// но инициализировать его было некому, и редактор только сообщал «не git-репозиторий». Теперь
// это действие: init, локальная подпись, .gitignore и первый коммит, чтобы изменениям было от
// чего считаться.
async function handleGitInit(root, _req, res) {
  const git = resolveGit(gitConfig, { fresh: true });
  if (!git.found) {
    json(res, 400, { ok: false, error: "git не найден: укажите путь к git.exe в настройках «1С-Редактор кода»" });
    return;
  }
  const existing = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (existing.ok) {
    json(res, 200, { ok: true, repo: existing.output.trim(), already: true });
    return;
  }
  const init = runGit(root, ["init", "-b", "main"]);
  // Git старше 2.28 не знает -b; тогда ветка останется той, что задана по умолчанию.
  if (!init.ok && !runGit(root, ["init"]).ok) {
    json(res, 500, { ok: false, error: "git init не отработал: " + String(init.output || "").slice(-300) });
    return;
  }
  // Коммит без подписи git отвергнет: в свежей системе user.name/user.email не заданы.
  // Правим только локальный конфиг репозитория, глобальный не трогаем.
  if (!runGit(root, ["config", "user.name"]).output.trim()) runGit(root, ["config", "user.name", "DSH для 1С"]);
  if (!runGit(root, ["config", "user.email"]).output.trim()) runGit(root, ["config", "user.email", "dsh-1c@local"]);
  // .dsh хранит путь к базе; *.cfl — служебные файлы блокировки 1С, в истории им делать нечего.
  const ignoreFile = join(root, ".gitignore");
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, [".dsh/", "*.cfl", "*.log", ""].join("\n"), "utf8");
  runGit(root, ["add", "-A"]);
  const commit = runGit(root, ["commit", "-m", "Первый коммит: исходное состояние проекта"]);
  json(res, 200, {
    ok: true,
    repo: root,
    committed: commit.ok,
    detail: commit.ok ? "" : String(commit.output || "").slice(-300),
  });
}

// Ручное обновление дерева из интерфейса: сбрасываем всё, что хост держит в
// памяти, — статусы git, поисковый индекс и разобранные метаданные. Без этого
// свежий файл или новый объект появлялись только в новой сессии DSH.
async function handleRefreshAll(root, _req, res) {
  gitStatusCache.delete(root);
  searchIndex.builtAt = 0;
  metaModel = null;
  // git могли поставить, пока приложение работало.
  gitResolveCache = { key: "", at: 0, info: null };
  resolveGit(gitConfig, { fresh: true });
  json(res, 200, { ok: true });
}

// Static go-to-definition via the metadata model (F12 without LSP):
// «[Коллектор.]Модуль.Метод» resolves to the exact module; a bare method
// name is looked up only in the currently open file.
async function handleFindSymbol(root, url, res) {
  try {
    const m = getMetaModel(root);
    const name = (url.searchParams.get("name") || "").trim();
    if (!name) return json(res, 200, { targets: [] });
    const currentFile = url.searchParams.get("file") || null;
    const { targets, resolved } = await m.resolveCall(name, currentFile);
    json(res, 200, { targets, resolved });
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

// Official 1C TextMate grammars are bundled under resources/grammar/ and
// served same-origin — the editor's syntax highlighting never depends on a CDN.
let grammarDir = null;
function resolveGrammarDir() {
  if (grammarDir) return grammarDir;
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "resources", "grammar");
    if (existsSync(candidate)) {
      grammarDir = candidate;
      return grammarDir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function handleGrammar(_root, url, res) {
  const name = (url.pathname || "").split("/").pop().replace(/\.json$/i, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return json(res, 404, { error: "bad grammar name" });
  const dir = resolveGrammarDir();
  const p = dir ? join(dir, name + ".tmLanguage.json") : null;
  if (!p || !existsSync(p)) return json(res, 404, { error: "grammar not found" });
  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" });
  res.end(readFileSync(p));
}

// Vendored runtime assets (Monaco, onigasm, monaco-textmate) — same-origin,
// чтобы раскраска не зависела от доступности CDN.
const VENDOR_FILES = {
  "loader.js": ["loader.js", "application/javascript"],
  "editor.main.js": ["editor.main.js", "application/javascript"],
  "editor.main.css": ["editor.main.css", "text/css"],
  "workerMain.js": ["workerMain.js", "application/javascript"],
  "onigasm-esm.js": ["onigasm-esm.js", "application/javascript"],
  "monaco-textmate-esm.js": ["monaco-textmate-esm.js", "application/javascript"],
  "fast-plist-esm.js": ["fast-plist-esm.js", "application/javascript"],
  "lru-cache-esm.js": ["lru-cache-esm.js", "application/javascript"],
  "pseudomap-esm.js": ["pseudomap-esm.js", "application/javascript"],
  "yallist-esm.js": ["yallist-esm.js", "application/javascript"],
  "onigasm.wasm": ["onigasm.wasm", "application/wasm"],
  "codicon.ttf": ["codicon.ttf", "font/ttf"],
};
let vendorDir = null;
function resolveVendorDir() {
  if (vendorDir) return vendorDir;
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "resources", "vendor");
    if (existsSync(candidate)) {
      vendorDir = candidate;
      return vendorDir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function handleVendor(_root, url, res) {
  const name = (url.pathname || "").split("/").pop();
  const entry = VENDOR_FILES[name];
  if (!entry) return json(res, 404, { error: "unknown vendor asset" });
  const dir = resolveVendorDir();
  const p = dir ? join(dir, entry[0]) : null;
  if (!p || !existsSync(p)) return json(res, 404, { error: "vendor asset missing" });
  // no-cache: файлы правились между версиями; долгий max-age заставлял
  // браузер сутки держать старые бандлы с несуществующими /npm/ импортами.
  res.writeHead(200, { "content-type": entry[1], "cache-control": "no-cache" });
  res.end(readFileSync(p));
}

export function apply(ctx, config) {
  // Settings saved from the in-tab panel win over the bundled defaults.
  Object.assign(config, loadPluginOverrides());

  // The user's project comes from the DSH workspace registry; fall back to dsh
  // cwd only when there is no workspace (never dsh's install dir by accident).
  // `root` is mutable: the client re-points it at the ACTIVE session's cwd
  // (POST /bsl/set-workspace) when the user switches chats/workspaces — the
  // registry's first entry is display order, not the active workspace.
  const workspaces = (() => {
    try {
      return (ctx.workspaceRegistry?.list?.() ?? []).map((w) => ({ id: w.id, path: w.path, title: w.title }));
    } catch {
      return [];
    }
  })();
  let root = config.workspaceDir || (workspaces[0]?.path ?? process.cwd());
  // git ищем один раз на старте: настройки плагина доступны только здесь, а
  // runGit зовётся из десятка мест и не должен каждый раз ходить по диску.
  gitConfig = config;
  resolveGit(config);

  // Warm the filename index in the background so the first search is instant.
  ensureIndex(root).catch(() => {});

  ctx.webServer.register({
    kind: "exact", path: "/bsl/lsp-status",
    handler: (_req, res) => json(res, 200, { state, reason, port: config.serverPort, logFile: LOG_FILE }),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/lsp-start",
    handler: async (_req, res) => {
      // Never spawn when LSP is disabled in settings — the client also
      // respects this, but an old/stale client must not be able to start it.
      if (config.lspEnabled === false) {
        return json(res, 200, { ok: false, state: "disabled", reason: "LSP выключен в настройках", port: config.serverPort });
      }
      // Trust the PORT, not the cached state: an adopted server may have died
      // since boot, leaving a stale "running" that would otherwise block a
      // respawn forever.
      let up = await probePort(config.serverPort);
      if (!up) {
        startServer(config, root);
        // Block until the server is actually ready (JVM + Tomcat boot takes
        // 2-10s), so the client can connect right after instead of racing.
        const deadline = Date.now() + 30000;
        while (state === "starting" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        up = await probePort(config.serverPort);
      }
      if (up) setState("running");
      json(res, 202, { ok: up, state: up ? "running" : state, reason: up ? "" : reason, port: config.serverPort });
    },
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/workspaces",
    handler: (_req, res) => {
      const cur = workspaces.find((w) => w.path === root);
      const title = cur?.title || root.split(/[\\/]/).filter(Boolean).pop() || root;
      json(res, 200, { root, workspaces, title });
    },
  });
  // The client re-points the editor root at the ACTIVE session's cwd when the
  // user switches chats/workspaces (session.cwd from the client sessions list).
  ctx.webServer.register({
    kind: "exact", path: "/bsl/set-workspace",
    handler: async (req, res) => {
      try {
        const body = JSON.parse(await readBody(req));
        const cwd = String(body?.cwd || "").trim();
        if (!cwd) return json(res, 400, { ok: false, error: "cwd required" });
        const st = await fs.stat(cwd).catch(() => null);
        if (!st?.isDirectory()) return json(res, 400, { ok: false, error: "not a directory: " + cwd });
        const previous = root;
        root = cwd.replace(/[\\/]+$/, "");
        if (root !== previous) ensureIndex(root).catch(() => {});
        json(res, 200, { ok: true, root });
      } catch (e) {
        json(res, 400, { ok: false, error: e?.message || String(e) });
      }
    },
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
    kind: "exact", path: "/bsl/config",
    handler: (_req, res) => json(res, 200, {
      lspEnabled: config.lspEnabled,
      interceptChatOpen: config.interceptChatOpen !== false,
      serverPort: config.serverPort,
      serverBin: config.serverBin,
      workspaceDir: config.workspaceDir,
      sourceExtensions: config.sourceExtensions,
      gitPath: config.gitPath || "",
    }),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/config-save",
    handler: (req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          const next = {
            lspEnabled: patch.lspEnabled ?? config.lspEnabled,
            interceptChatOpen: patch.interceptChatOpen ?? (config.interceptChatOpen !== false),
            serverPort: patch.serverPort ?? config.serverPort,
            serverBin: patch.serverBin ?? config.serverBin,
            sourceExtensions: patch.sourceExtensions ?? config.sourceExtensions,
            gitPath: patch.gitPath ?? config.gitPath ?? "",
          };
          mkdirSync(LOG_DIR, { recursive: true });
          writeFileSync(PLUGIN_CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf-8");
          Object.assign(config, next);
          json(res, 200, { ok: true, config: { ...next } });
        } catch (e) {
          json(res, 400, { ok: false, error: e.message });
        }
      });
    },
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/grammar",
    handler: (req, res) => handleGrammar(root, new URL(req.url, "http://x"), res),
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
    kind: "exact", path: "/bsl/stat",
    handler: (req, res) => handleStat(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/vendor",
    handler: (req, res) => handleVendor(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/write",
    handler: (req, res) => handleWrite(root, req, res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/git-status",
    handler: (req, res) => handleGitStatus(root, res, { fresh: new URL(req.url, "http://x").searchParams.get("fresh") === "1" }),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/git-diff",
    handler: (req, res) => handleGitDiff(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/revert-hunk",
    handler: (req, res) => handleRevertHunk(root, req, res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/revert-file",
    handler: (req, res) => handleRevertFile(root, req, res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/reviewed",
    handler: (req, res) => handleReviewed(root, req, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/stage",
    handler: (req, res) => handleStage(root, req, res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/stage-all",
    handler: (req, res) => handleStageAll(root, res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/staged",
    handler: (_req, res) => handleStaged(root, res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/commit",
    handler: (req, res) => handleCommit(root, req, res),
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
    kind: "exact", path: "/bsl/refresh",
    handler: (req, res) => handleRefreshAll(root, req, res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/git-info",
    handler: (req, res) => handleGitInfo(root, new URL(req.url, "http://x"), res),
  });
  ctx.webServer.register({
    kind: "exact", path: "/bsl/git-init",
    handler: (req, res) => handleGitInit(root, req, res),
  });
  ctx.webServer.register({
    kind: "prefix", path: "/bsl/find-symbol",
    handler: (req, res) => handleFindSymbol(root, new URL(req.url, "http://x"), res),
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
