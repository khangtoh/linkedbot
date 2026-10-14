import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { sleep, useTempDataDir } from "./helpers.js";

const dir = useTempDataDir();
// A job that was running and one that was queued when the machine stopped.
writeFileSync(`${dir}/jobs.json`, JSON.stringify([
  { id: "a", cmd: "echo", input: { n: 1 }, status: "running", createdAt: "2026-01-01T00:00:00Z" },
  { id: "b", cmd: "echo", input: { n: 2 }, status: "queued", createdAt: "2026-01-01T00:00:01Z" },
]));

const jobs = await import("../src/jobs.js");
const limits = await import("../src/limits.js");

const order: string[] = [];
const runners: Record<string, (input: any, report: (m: string) => void) => Promise<unknown>> = {
  echo: async (input) => { order.push(`start ${input.n}`); await sleep(input.ms ?? 5); order.push(`end ${input.n}`); return input; },
  fail: async () => { throw new Error("boom"); },
  slowly: async (_input, report) => { report("Opening your profile"); await sleep(80); report("Reading the page"); await sleep(80); return "ok"; },
};
jobs.initJobs((cmd) => runners[cmd]);

test("boot recovery fails the interrupted job and resumes the queued one", async () => {
  assert.equal(jobs.getJob("a")?.status, "error");
  assert.equal(jobs.getJob("a")?.error, "Interrupted by a restart.");
  const b = await jobs.waitForJob("b", 1000);
  assert.equal(b?.status, "done");
  assert.deepEqual(b?.result, { n: 2 });
});

test("jobs run one at a time, in order", async () => {
  order.length = 0;
  const x = jobs.enqueue("echo", { n: 10, ms: 30 });
  const y = jobs.enqueue("echo", { n: 11 });
  await jobs.waitForJob(y.id, 1000);
  assert.equal(jobs.getJob(x.id)?.status, "done");
  assert.deepEqual(order, ["start 10", "end 10", "start 11", "end 11"]);
});

test("an identical call while the first is unfinished joins it", async () => {
  const first = jobs.enqueue("echo", { n: 20, ms: 30, tag: { a: 1, b: 2 } });
  const again = jobs.enqueue("echo", { tag: { b: 2, a: 1 }, ms: 30, n: 20 });
  assert.equal(again.id, first.id);
  await jobs.waitForJob(first.id, 1000);
  assert.notEqual(jobs.enqueue("echo", { n: 20, ms: 30, tag: { a: 1, b: 2 } }).id, first.id);
});

test("errors and unknown operations end the job with an error", async () => {
  assert.equal((await jobs.waitForJob(jobs.enqueue("fail", {}).id, 1000))?.error, "boom");
  assert.match((await jobs.waitForJob(jobs.enqueue("nope", {}).id, 1000))?.error ?? "", /Unknown operation "nope"/);
});

test("waitForJob returns the job as it stands when time runs out", async () => {
  const slow = jobs.enqueue("echo", { n: 30, ms: 200 });
  const early = await jobs.waitForJob(slow.id, 20);
  assert.ok(early && early.status !== "done");
  await jobs.waitForJob(slow.id, 1000);
});

test("an open breaker holds jobs in the queue until it closes", async () => {
  limits.tripBreaker("test");
  const held = jobs.enqueue("echo", { n: 40 });
  await sleep(50);
  assert.equal(jobs.getJob(held.id)?.status, "queued");
  assert.deepEqual(jobs.queueState(), { paused: true, pending: 1 });
  limits.resetBreaker();
  assert.equal((await jobs.waitForJob(held.id, 1000))?.status, "done");
});

test("markInterrupted fails the running job", async () => {
  const running = jobs.enqueue("echo", { n: 50, ms: 200 });
  await sleep(30);
  jobs.markInterrupted();
  assert.equal(jobs.getJob(running.id)?.error, "Interrupted by a restart.");
  await sleep(250);
});

test("a running job says what it is doing, and a queued one why it waits", async () => {
  const first = jobs.enqueue("slowly", { n: 1 });
  const second = jobs.enqueue("echo", { n: 60 });
  assert.equal(jobs.getJob(second.id)?.progress?.stage, "queued");
  assert.match(jobs.getJob(second.id)?.progress?.message ?? "", /Waiting for the run ahead of it/);
  await sleep(40);
  assert.deepEqual({ ...jobs.getJob(first.id)?.progress, since: undefined }, { stage: "working", message: "Opening your profile", since: undefined });
  await sleep(90);
  assert.equal(jobs.getJob(first.id)?.progress?.message, "Reading the page");
  await jobs.waitForJob(second.id, 1000);
  assert.equal(jobs.getJob(first.id)?.progress, undefined); // cleared when it ends
});
