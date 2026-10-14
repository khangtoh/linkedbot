import { useEffect, useState } from "react";
import type { Job, JobSummary } from "../api";
import { explainError } from "../explain";
import { Icon } from "../icons";
import { navigate } from "../router";
import { Button } from "../ui";
import { DataView } from "./DataView";

// How long something has been going, ticking every second: "12 s", "1 min 05 s".
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return <span className="num">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`}</span>;
}

export const isActive = (j?: { status: string }) => j?.status === "queued" || j?.status === "running";

type StageState = "done" | "current" | "pending" | "failed";

// The run as a short timeline: queued, waiting for the browser (only if it had to), working, and how it ended.
export function RunTimeline({ job }: { job: JobSummary }) {
  const p = job.progress;
  const failed = job.status === "error";
  const done = job.status === "done";
  const waiting = job.status === "running" && p?.stage === "waiting";
  const working = job.status === "running" && p?.stage !== "waiting";
  const stages: { key: string; label: string; detail?: React.ReactNode; state: StageState }[] = [
    {
      key: "queued",
      label: job.status === "queued" ? "Queued" : "Started",
      detail: job.status === "queued" ? p?.message ?? "Waiting for its turn" : undefined,
      state: job.status === "queued" ? (p?.stage === "waiting" ? "current" : "current") : "done",
    },
    ...(waiting ? [{ key: "browser", label: "Waiting for the browser", detail: p?.message.replace(/^Waiting for the browser: /, "") ?? "", state: "current" as StageState }] : []),
    {
      key: "working",
      label: "Working",
      detail: working ? p?.message : undefined,
      state: working ? "current" : done || failed ? (failed ? "failed" : "done") : "pending",
    },
    { key: "end", label: failed ? "Failed" : "Done", state: done ? "done" : failed ? "failed" : "pending" },
  ];
  // A failure belongs on the stage where it happened; collapse the last two when it failed.
  const shown = failed ? stages.filter((s) => s.key !== "working") : stages;
  return (
    <ol className="timeline" aria-label="Progress">
      {shown.map((s) => (
        <li key={s.key} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="dot" aria-hidden="true">
            {s.state === "done" ? <Icon name="check" size={14} /> : s.state === "failed" ? <Icon name="x" size={14} /> : s.state === "current" ? <span className="spin" /> : null}
          </span>
          <div className="stage">
            <span className="stage-label">
              {s.label}
              {s.state === "current" && (
                <span className="muted small">
                  {" · "}
                  <Elapsed since={job.progress?.since ?? job.startedAt ?? job.createdAt} />
                </span>
              )}
            </span>
            {s.detail && <span className="stage-detail">{s.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// A failed run: what happened in plain words, and the one action that fixes it.
export function ErrorCard({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  const e = explainError(error);
  return (
    <div className="error-card" role="alert">
      <div className="row" style={{ "--gap": "10px", flexWrap: "nowrap", alignItems: "flex-start" } as React.CSSProperties}>
        <Icon name="alert" size={20} />
        <div className="stack" style={{ "--gap": "4px" } as React.CSSProperties}>
          <strong>{e.title}</strong>
          <p>{e.detail}</p>
        </div>
      </div>
      {e.action && (
        <div>
          {e.action.to ? (
            <Button variant="primary" size="small" onClick={() => navigate(e.action!.to!)}>
              {e.action.label}
            </Button>
          ) : e.action.retry && onRetry ? (
            <Button variant="primary" size="small" icon="play" onClick={onRetry}>
              {e.action.label}
            </Button>
          ) : null}
        </div>
      )}
      {error && error !== e.detail && (
        <details>
          <summary className="small">Details</summary>
          <p className="small mono" style={{ marginTop: 6, overflowWrap: "anywhere" }}>
            {error}
          </p>
        </details>
      )}
    </div>
  );
}

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

// What a run returned, or an explicit "found nothing" instead of a blank area.
export function ResultView({ job }: { job: Job }) {
  if (isEmpty(job.result)) {
    return (
      <div className="note ok">
        <Icon name="check" size={18} />
        <div>
          <strong>It ran, but found nothing.</strong> {job.cmd === "list_leads" ? "No stored leads match. Leads are saved by People searches." : "There was nothing to return for this input."}
        </div>
      </div>
    );
  }
  return <DataView value={job.result} />;
}
