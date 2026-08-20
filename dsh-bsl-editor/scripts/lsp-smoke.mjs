// LSP chain proof v2: verbose inbound logging, longer wait, didChangeConfiguration.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const EXE = process.argv[2] || "C:\\Users\\mempemp\\AppData\\Local\\Programs\\bsl-language-server\\bsl-language-server\\bsl-language-server.exe";
const BSL_FILE = process.argv[3] || "D:\\Work\\hrm1\\CommonModules\\АВТ_СВВнутренний\\Ext\\Module.bsl";
const ROOT = "D:\\Work\\hrm1";

const source = readFileSync(BSL_FILE, "utf-8");
let buffer = Buffer.alloc(0);
let initialized = false;
let diagCount = 0;

function send(stream, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  stream.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf-8"));
  stream.write(body);
}

function parseMessages(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  const msgs = [];
  for (;;) {
    const idx = buffer.indexOf("\r\n\r\n");
    if (idx === -1) break;
    const header = buffer.slice(0, idx).toString("utf-8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buffer = buffer.slice(idx + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buffer.length < idx + 4 + len) break;
    const body = buffer.slice(idx + 4, idx + 4 + len).toString("utf-8");
    buffer = buffer.slice(idx + 4 + len);
    try { msgs.push(JSON.parse(body)); } catch (e) { console.log("[parse-error]", e.message, body.slice(0, 80)); }
  }
  return msgs;
}

const child = spawn(EXE, [], { cwd: ROOT, windowsHide: true });
child.stdout.on("data", (c) => {
  for (const msg of parseMessages(c)) {
    if (msg.method === "textDocument/publishDiagnostics") {
      diagCount += msg.params.diagnostics.length;
      console.log(`  [publishDiagnostics] ${msg.params.diagnostics.length} for ${msg.params.uri.split("/").pop()}`);
      for (const d of msg.params.diagnostics.slice(0, 3)) {
        console.log(`     [${d.severity}] ${d.message} @ ${d.range.start.line}:${d.range.start.character}`);
      }
    } else if (msg.method) {
      console.log(`  [request/notify] ${msg.method} ${msg.id !== undefined ? "id=" + msg.id : ""}`);
      if (msg.id !== undefined) {
        // Server→client request (e.g. window/showMessageRequest): log and answer.
        if (msg.method === "window/showMessageRequest") {
          const actions = msg.params?.actions ?? [];
          console.log(`     message: ${msg.params?.message} actions=${actions.map((a) => a.title).join(",")}`);
          const choice = actions.length > 0 ? actions[0] : null;
          send(child.stdin, { jsonrpc: "2.0", id: msg.id, result: choice });
        } else {
          send(child.stdin, { jsonrpc: "2.0", id: msg.id, result: null });
        }
      }
    } else if (msg.id !== undefined) {
      console.log(`  [response id=${msg.id}] ${msg.result ? "OK" : "ERR " + (msg.error?.message ?? "")}`);
      if (msg.id === 1) {
        initialized = true;
        console.log(`     serverInfo: ${JSON.stringify(msg.result?.serverInfo)}`);
        send(child.stdin, { jsonrpc: "2.0", method: "initialized", params: {} });
        send(child.stdin, {
          jsonrpc: "2.0", method: "workspace/didChangeConfiguration",
          params: { settings: { "bsl-language-server": { diagnostics: { computeTrigger: "onType", skipSupport: false } } } },
        });
        send(child.stdin, {
          jsonrpc: "2.0", method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri: "file:///" + BSL_FILE.replace(/\\/g, "/"),
              languageId: "bsl", version: 1, text: source,
            },
          },
        });
      }
    }
  }
});
child.stderr.on("data", () => {});
child.on("exit", (c) => console.log(`[server exited ${c}]`));

send(child.stdin, {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    processId: process.pid,
    rootUri: "file:///" + ROOT.replace(/\\/g, "/"),
    rootPath: ROOT,
    capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } }, workspace: { configuration: true } },
  },
});

await delay(40000);
console.log(`\n=== initialized: ${initialized}, diagnostics total: ${diagCount} ===`);
try { child.kill(); } catch {}
process.exit(initialized ? 0 : 2);
