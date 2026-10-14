import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./vault.js";
import { readJson, writeJsonAtomic } from "./store.js";
import { breakerState, waitForBreakerClosed } from "./limits.js";

// Serial job queue. One job at a time: there is a single LinkedIn session and the pacing in
// limits.ts assumes serial use. Jobs live on disk because the host may stop an idle machine
// before a caller comes back for the result.
export type JobStatus = "queued" | "running" | "done" | "error";
export type Job = {
  id: string;
  cmd: string;
  input: unknown;
  status: JobStatus;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  // What it is doing right now, in plain words (kept in memory; cleared when the job ends).
  progress?: Progress;
};
export type Progress = { stage: "queued" | "waiting" | "working"; message: string; since: string };
export type Report = (message: string, stage?: "waiting" | "working") => void;
export type Runner = (input: any, report: Report) => Promise<unknown>;

const PATH = `${DATA_DIR}/jobs.json`;
const KEEP = 50; // finished jobs kept; unfinished ones are never dropped

let jobs: Job[] = [];
let resolveRunner: (cmd: string) => Runner | undefined = () => undefined;
let chain: Promise<void> = Promise.resolve();
const waiters = new Map<string, Set<() => void>>();

const now = () => new Date().toISOString();
const finished = (j: Job) => j.status === "done" || j.status === "error";

// Same operation with the same input, regardless of key order: retried calls join the queued job.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const keyOf = (cmd: string, input: unknown) => `${cmd}\u0000${stable(input)}`;

function save(): void {
  while (jobs.length > KEEP) {
    const i = jobs.findIndex(finished);
    if (i < 0) break;
    jobs.splice(i, 1);
  }
  writeJsonAtomic(PATH, jobs);
}

function notify(id: string): void {
  for (const w of waiters.get(id) ?? []) w();
  waiters.delete(id);
}

const setProgress = (job: Job, stage: Progress["stage"], message: string) => {
  if (job.progress?.stage !== stage || job.progress.message !== message) job.progress = { stage, message, since: now() };
};

async function runJob(job: Job): Promise<void> {
  if (breakerState().open) setProgress(job, "waiting", "Paused until LinkedIn is logged in again");
  await waitForBreakerClosed(); // LinkedIn paused: stay queued until the next login
  job.status = "running";
  job.startedAt = now();
  setProgress(job, "working", "Starting");
  save();
  try {
    const run = resolveRunner(job.cmd);
    if (!run) throw new Error(`Unknown operation "${job.cmd}".`);
    job.result = await run(job.input, (message, stage = "working") => setProgress(job, stage, message));
    job.status = "done";
  } catch (e) {
    job.error = (e as Error).message;
    job.status = "error";
  }
  job.finishedAt = now();
  delete job.progress;
  save();
  notify(job.id);
}

const schedule = (job: Job) => void (chain = chain.then(() => runJob(job)));

// Loads jobs from disk: the one that was running when the machine stopped is failed, queued ones resume.
export function initJobs(resolve: (cmd: string) => Runner | undefined): void {
  resolveRunner = resolve;
  jobs = readJson<Job[]>(PATH, []);
  for (const j of jobs) {
    delete j.progress;
    if (j.status === "running") Object.assign(j, { status: "error", error: "Interrupted by a restart.", finishedAt: now() });
    if (j.status === "queued") setProgress(j, "queued", "Waiting for its turn");
  }
  save();
  for (const j of jobs) if (j.status === "queued") schedule(j);
}

export function enqueue(cmd: string, input: unknown): Job {
  const key = keyOf(cmd, input);
  const same = jobs.find((j) => !finished(j) && keyOf(j.cmd, j.input) === key);
  if (same) return same;
  const job: Job = { id: randomBytes(8).toString("hex"), cmd, input, status: "queued", createdAt: now() };
  const ahead = jobs.filter((j) => !finished(j)).length;
  setProgress(job, "queued", ahead ? `Waiting for ${ahead === 1 ? "the run ahead of it" : `${ahead} runs ahead of it`} to finish` : "Starting soon");
  jobs.push(job);
  save();
  schedule(job);
  return job;
}

export const getJob = (id: string) => jobs.find((j) => j.id === id);
export const recentJobs = (n: number) => jobs.slice(-n);
export const queueState = () => ({ paused: breakerState().open, pending: jobs.filter((j) => !finished(j)).length });

// Resolves with the job once it has finished, or as it stands after `ms`.
export function waitForJob(id: string, ms: number): Promise<Job | undefined> {
  const job = getJob(id);
  if (!job || finished(job)) return Promise.resolve(job);
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set();
    waiters.set(id, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      resolve(getJob(id));
    };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

// On shutdown the running job cannot finish; record that instead of leaving it "running".
export function markInterrupted(): void {
  let changed = false;
  for (const j of jobs) {
    if (j.status !== "running") continue;
    Object.assign(j, { status: "error", error: "Interrupted by a restart.", finishedAt: now() });
    notify(j.id);
    changed = true;
  }
  if (changed) save();
}
