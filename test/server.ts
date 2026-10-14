import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { sleep } from "./helpers.js";

// Runs the real server (src/server.ts) in a child process against a temporary data directory.
export const TOKEN = "apple-banana-cherry-delta";

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise((r) => srv.close(r));
  return port;
}

// Node on some hosts (seen on an Android/proot dev machine) occasionally segfaults while loading,
// before the server prints anything. A server that dies during startup is retried; one that dies
// later is reported, never hidden.
export async function startServer(dataDir: string, env: Record<string, string> = {}): Promise<{ base: string; stop: () => Promise<void>; child: ChildProcess }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(dataDir, env);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.error(`retrying server start: ${(e as Error).message}`);
    }
  }
}

async function startOnce(dataDir: string, env: Record<string, string>): Promise<{ base: string; stop: () => Promise<void>; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, PORT: String(port), LINKEDBOT_DATA: dataDir, LINKEDBOT_API_TOKEN: TOKEN, LINKEDBOT_PASSPHRASE: "test-passphrase-not-secret", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stopping = false;
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  // A server that dies mid-test shows up as "fetch failed" in every later test; say why it died.
  child.on("exit", (code, signal) => {
    if (!stopping) console.error(`test server exited (code ${code}, signal ${signal}):\n${output.slice(-2000)}`);
  });
  const base = `http://127.0.0.1:${port}`;
  const dead = () => child.exitCode !== null || child.signalCode !== null;
  for (let i = 0; ; i++) {
    if (dead()) throw new Error(`server died during startup (signal ${child.signalCode}, code ${child.exitCode})`);
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
    if (i >= 150) throw new Error(`server did not answer within 15s:\n${output}`);
    await sleep(100);
  }
  return {
    base,
    child,
    stop: async () => {
      if (dead()) return;
      stopping = true;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    },
  };
}
