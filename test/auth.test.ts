import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { useTempDataDir } from "./helpers.js";

useTempDataDir(); // token: apple-banana-cherry-delta
const auth = await import("../src/auth.js");

const req = (authorization: string | undefined, xff: string, remote = "10.0.0.1") =>
  ({ headers: { authorization, "x-forwarded-for": xff }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

test("tokens match regardless of case and separators", () => {
  assert.equal(auth.tokenMatches("apple-banana-cherry-delta"), true);
  assert.equal(auth.tokenMatches("  Apple Banana  CHERRY-delta "), true);
  assert.equal(auth.tokenMatches("apple-banana-cherry"), false);
  assert.equal(auth.tokenMatches(""), false);
});

test("authenticate accepts the bearer token and rejects others", () => {
  assert.deepEqual(auth.authenticate(req("Bearer apple banana cherry delta", "1.1.1.1")), { ok: true, principal: { via: "bearer" } });
  assert.deepEqual(auth.authenticate(req("Bearer nope", "1.1.1.2")), { ok: false, status: 401 });
  assert.deepEqual(auth.authenticate(req(undefined, "1.1.1.2")), { ok: false, status: 401 });
});

test("ten failures in a minute block that address, including a correct token", () => {
  for (let i = 0; i < 10; i++) assert.equal(auth.authenticate(req("Bearer wrong", "9.9.9.9")).ok, false);
  assert.deepEqual(auth.authenticate(req("Bearer apple-banana-cherry-delta", "9.9.9.9")), { ok: false, status: 429 });
  assert.equal(auth.authenticate(req("Bearer apple-banana-cherry-delta", "8.8.8.8")).ok, true);
});

test("the rightmost X-Forwarded-For entry is the client address", () => {
  assert.equal(auth.clientIp(req(undefined, "6.6.6.6, 9.9.9.9")), "9.9.9.9");
  assert.equal(auth.clientIp(req(undefined, "")), "10.0.0.1");
  // a client cannot escape the block by prepending its own entry
  assert.deepEqual(auth.authenticate(req("Bearer apple-banana-cherry-delta", "1.2.3.4, 9.9.9.9")), { ok: false, status: 429 });
});
