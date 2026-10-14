import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The host can stop the machine at any moment, so files are written beside their target and renamed
// into place: a reader sees the old file or the new one, never half of one.
export function writeFileAtomic(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value));
}

// Missing file -> fallback. A file that does not parse is moved aside instead of failing every boot.
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    const aside = `${path}.corrupt-${Date.now()}`;
    renameSync(path, aside);
    console.warn(`${path} was unreadable (${(e as Error).message}); moved to ${aside}`);
    return fallback;
  }
}
