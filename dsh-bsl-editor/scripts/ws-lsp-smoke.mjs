// LSP over WebSocket smoke test — proves the browser architecture directly.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const WebSocket = require("D:/DSH/node_modules/ws");

const URL = process.argv[2] || "ws://127.0.0.1:8025/lsp";
const BSL_FILE = process.argv[3] || "D:/dsh-bsl-editor/testws/test.bsl";
const ROOT = process.argv[4] || "D:/dsh-bsl-editor/testws";

const source = readFileSync(BSL_FILE, "utf-8");
let initialized = false;
let diagTotal = 0;
let idc = 100;

const ws = new WebSocket(URL);

function send(obj) {
  ws.send(JSON.stringify(obj));
}

ws.on("open", () => {
  console.log("[ws open]");
  send({
    jsonrpc: "2.0", id: idc++, method: "initialize",
    params: {
      processId: process.pid,
      rootUri: "file:///" + ROOT.replace(/\\/g, "/"),
      rootPath: ROOT,
      capabilities: {
        textDocument: { publishDiagnostics: { relatedInformation: true }, hover: {}, completion: {} },
        workspace: { configuration: true },
      },
    },
  });
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method === "textDocument/publishDiagnostics") {
    diagTotal += msg.params.diagnostics.length;
    console.log(`[publishDiagnostics] ${msg.params.diagnostics.length} for ${msg.params.uri.split("/").pop()}`);
    for (const d of msg.params.diagnostics.slice(0, 4)) {
      console.log(`   [${d.severity}] ${d.message} @ ${d.range.start.line}:${d.range.start.character}`);
    }
  } else if (msg.method === "window/logMessage") {
    console.log(`[log] ${msg.params.message.slice(0, 90)}`);
  } else if (msg.method === "window/showMessageRequest") {
    console.log(`[showMessageRequest] ${msg.params?.message}`);
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.id !== undefined && !msg.method) {
    if (msg.id === 100) {
      initialized = true;
      console.log(`[initialize] OK: ${JSON.stringify(msg.result?.serverInfo)}`);
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({
        jsonrpc: "2.0", method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///" + BSL_FILE.replace(/\\/g, "/"), languageId: "bsl", version: 1, text: source } },
      });
    } else {
      console.log(`[response id=${msg.id}] ${msg.result !== undefined ? "OK" : "ERR " + (msg.error?.message ?? "")}`);
    }
  }
});
ws.on("error", (e) => console.log("[ws error]", e.message));
ws.on("close", (c) => console.log("[ws close]", c));

await delay(25000);
console.log(`\n=== initialized: ${initialized}, diagnostics total: ${diagTotal} ===`);
try { ws.close(); } catch {}
process.exit(initialized ? 0 : 2);
