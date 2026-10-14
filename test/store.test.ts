import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { useTempDataDir } from "./helpers.js";

const dir = useTempDataDir();
const { readJson, writeJsonAtomic } = await import("../src/store.js");

test("writeJsonAtomic then readJson round-trips and leaves no temp file", () => {
  const path = `${dir}/a/b.json`;
  writeJsonAtomic(path, { n: 1 });
  assert.deepEqual(readJson(path, null), { n: 1 });
  assert.deepEqual(readdirSync(`${dir}/a`), ["b.json"]);
});

test("readJson returns the fallback for a missing file", () => {
  assert.deepEqual(readJson(`${dir}/missing.json`, []), []);
});

test("a corrupt file is moved aside instead of throwing", () => {
  const path = `${dir}/jobs.json`;
  writeFileSync(path, '[{"id":"half-writ');
  assert.deepEqual(readJson(path, []), []);
  assert.equal(existsSync(path), false);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("jobs.json.corrupt-")));
});
