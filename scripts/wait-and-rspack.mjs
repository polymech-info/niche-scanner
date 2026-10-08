import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const host = "127.0.0.1";
const port = 3780;
const timeoutMs = 30_000;
const started = Date.now();
const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

while (!(await canConnect())) {
  if (Date.now() - started > timeoutMs) {
    console.error(
      `[client] timed out waiting for API at ${host}:${port} — start failed?`
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`[client] API ready on ${host}:${port}, starting Rspack`);
const rspackBin = path.join(
  adminRoot,
  "node_modules",
  "@rspack",
  "cli",
  "bin",
  "rspack.js"
);
const child = spawn(
  process.execPath,
  [rspackBin, "dev", "--mode", "development"],
  {
    stdio: "inherit",
    cwd: adminRoot,
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      // ignore
    }
  }
  process.exit(code ?? 1);
});
