import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();
const limits = await import("../src/limits.js");

test("consume counts against remaining() and stops at the cap", () => {
  const before = limits.remaining().search;
  limits.consume("search");
  assert.equal(limits.remaining().search, before - 1);
  for (let i = 1; i < before; i++) limits.consume("search");
  assert.equal(limits.remaining().search, 0);
  assert.throws(() => limits.consume("search"), /Daily cap reached/);
});

test("assertBudget refuses a run that would not fit", () => {
  assert.doesNotThrow(() => limits.assertBudget({ view_profile: 1 }));
  assert.throws(() => limits.assertBudget({ view_profile: 1000 }), /Would exceed today's cap for "view_profile"/);
});

test("isCapCategory accepts only known categories", () => {
  assert.equal(limits.isCapCategory("view_profile"), true);
  assert.equal(limits.isCapCategory("like"), false);
});

test("the breaker persists, and waitForBreakerClosed resolves on reset", async () => {
  assert.equal(limits.breakerState().open, false);
  limits.tripBreaker("LinkedIn showed /authwall");
  assert.deepEqual({ ...limits.breakerState(), since: undefined }, { open: true, reason: "LinkedIn showed /authwall", since: undefined });
  let resumed = false;
  const waiting = limits.waitForBreakerClosed().then(() => (resumed = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resumed, false);
  limits.resetBreaker();
  await waiting;
  assert.equal(resumed, true);
});
