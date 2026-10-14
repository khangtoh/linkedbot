import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// Modules read LINKEDBOT_DATA when first imported, so call this before importing anything from src/
// (with a dynamic import). Each test file runs in its own process.
export function useTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "linkedbot-test-"));
  process.env.LINKEDBOT_DATA = dir;
  process.env.LINKEDBOT_PASSPHRASE ??= "test-passphrase-not-secret";
  process.env.LINKEDBOT_API_TOKEN ??= "apple-banana-cherry-delta";
  return dir;
}

export async function listen(handler: RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
