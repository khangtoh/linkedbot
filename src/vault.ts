import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "./store.js";

export const DATA_DIR = process.env.LINKEDBOT_DATA ?? "data";
const VAULT_PATH = `${DATA_DIR}/session.vault`;

// Encrypted-at-rest storage for the Playwright storageState (cookies incl. li_at).
// Format: salt(16) | iv(12) | tag(16) | ciphertext. Key = scrypt(passphrase, salt).
function passphrase(): string {
  const p = process.env.LINKEDBOT_PASSPHRASE;
  if (!p || p.length < 12) throw new Error("Set LINKEDBOT_PASSPHRASE (>=12 chars) to unlock the session vault.");
  return p;
}

export type StoredSession = { state: any; userAgent?: string };

// Payload is {v:2,state,userAgent}; v1 vaults held the raw storageState.
export function saveSession(state: unknown, userAgent?: string): void {
  writeEncrypted({ v: 2, state, userAgent });
}

function writeEncrypted(payload: unknown): void {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase(), salt, 32), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  writeFileAtomic(VAULT_PATH, Buffer.concat([salt, iv, cipher.getAuthTag(), enc]), 0o600);
}

export function hasSession(): boolean {
  return existsSync(VAULT_PATH);
}

// Changes whenever the vault is rewritten, so a browser context built from an older session can be replaced.
export function sessionVersion(): number {
  return existsSync(VAULT_PATH) ? statSync(VAULT_PATH).mtimeMs : 0;
}

export function loadSession(): StoredSession {
  const buf = readFileSync(VAULT_PATH);
  const salt = buf.subarray(0, 16), iv = buf.subarray(16, 28), tag = buf.subarray(28, 44), enc = buf.subarray(44);
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase(), salt, 32), iv);
  decipher.setAuthTag(tag);
  const p = JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8"));
  return p.v === 2 ? { state: p.state, userAgent: p.userAgent } : { state: p };
}
