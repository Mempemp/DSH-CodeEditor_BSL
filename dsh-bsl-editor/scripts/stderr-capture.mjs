import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const exe = "C:/Users/mempemp/AppData/Local/Programs/bsl-language-server/bsl-language-server/bsl-language-server.exe";
const root = "D:/dsh-bsl-editor/testws";

const child = spawn(exe, [], { cwd: root, windowsHide: true });
let err = "";
child.stderr.on("data", (c) => (err += c));
child.stdout.on("data", () => {});

const body = JSON.stringify({
  jsonrpc: "2.0", id: 999, method: "initialize",
  params: { processId: process.pid, rootUri: "file:///" + root, capabilities: {} },
});
child.stdin.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);

await delay(15000);
child.kill();
console.log("=== STDERR (first 3000 chars) ===");
console.log(err.slice(0, 3000));
