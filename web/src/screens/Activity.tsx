import { useEffect, useState } from "react";
import { api, humanize, type Job, type JobSummary } from "../api";
import { explainError } from "../explain";
import { Icon } from "../icons";
import { Link } from "../router";
import { Empty, Note, Sheet, Skeleton, useAsync, useStatus } from "../ui";
import { DataView } from "./DataView";
import { ErrorCard, isActive, ResultView, RunTimeline } from "./RunView";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const label = (cmd: string) => (cmd === "__preview" ? "Studio preview" : humanize(cmd));
const TONE = { done: "ok", error: "danger", running: "accent", queued: "" } as const;
const WORD = { done: "Done", error: "Failed", running: "Running", queued: "Queued" } as const;

export function Activity() {
  const [tab, setTab] = useState<"runs" | "leads">("runs");
  return (
    <>
      <div className="page-head">
        <div style={{ flex: 1 }}>
          <h1>Activity</h1>
          <p>Runs from the studio, your AI assistants and the API all appear here.</p>
        </div>
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === "runs"} onClick={() => setTab("runs")}>
            Runs
          </button>
          <button type="button" aria-pressed={tab === "leads"} onClick={() => setTab("leads")}>
            Leads
          </button>
        </div>
      </div>
      {tab === "runs" ? <Runs /> : <Leads />}
    </>
  );
}

function Runs() {
  const { status, watch } = useStatus();
  // A toast's "View result" lands here with ?job=<id>.
  const [openId, setOpenId] = useState<string | undefined>(() => new URLSearchParams(location.search).get("job") ?? undefined);
  const close = () => {
    setOpenId(undefined);
    if (location.search) history.replaceState(null, "", location.pathname);
  };
  if (!status) return <Skeleton lines={5} />;
  const jobs = [...status.jobs].reverse();
  const open = jobs.find((j) => j.id === openId);
  return (
    <>
      {status.queue.paused && (
        <Note tone="danger" icon="pause">
          <strong>LinkedIn work is paused.</strong> {status.linkedin.reason}. Queued runs continue after you <Link to="/settings">log in to LinkedIn again</Link>.
        </Note>
      )}
      {!jobs.length ? (
        <Empty title="Nothing has run yet">Run something from the Library, or ask an AI assistant connected over MCP.</Empty>
      ) : (
        <div className="list" style={{ marginTop: 16 }}>
          {jobs.map((j) => (
            <button key={j.id} type="button" className="list-item" onClick={() => setOpenId(j.id)}>
              <div className="grow">
                <span className="title">{label(j.cmd)}</span>
                <p className="sub num">
                  {isActive(j) && j.progress ? j.progress.message : j.status === "error" ? explainError(j.error).title : when(j.createdAt)}
                </p>
              </div>
              <span className={`pill ${TONE[j.status]}`}>
                {isActive(j) && <span className="spin" aria-hidden="true" style={{ width: 12, height: 12 }} />}
                {WORD[j.status]}
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ))}
        </div>
      )}
      {openId && <RunDetail id={openId} summary={open} title={open ? label(open.cmd) : "Run"} onClose={close} watch={watch} />}
    </>
  );
}

function RunDetail({ id, summary, title, onClose, watch }: { id: string; summary?: JobSummary; title: string; onClose: () => void; watch: (id: string, on: boolean) => void }) {
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState<string>();
  // Follow the run live while it is open; its end needs no toast meanwhile.
  useEffect(() => {
    watch(id, true);
    let live = true;
    const load = () => api.job(id).then((j) => live && setJob(j), (e: Error) => live && setError(e.message));
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => {
      live = false;
      clearInterval(t);
      watch(id, false);
    };
  }, [id, watch]);
  const current = job ?? (summary as Job | undefined);
  return (
    <Sheet title={title} onClose={onClose}>
      {!current && !error && <Skeleton />}
      {error && <Note tone="danger">{error}</Note>}
      {current && (
        <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
          <p className="small muted num">
            Started {when(current.createdAt)}
            {current.finishedAt ? ` · finished ${when(current.finishedAt)}` : ""}
          </p>
          <RunTimeline job={current} />
          {!!job?.input && Object.keys(job.input as object).length > 0 && job.cmd !== "__preview" && (
            <details>
              <summary className="small">Input</summary>
              <div style={{ marginTop: 8 }}>
                <DataView value={job.input} />
              </div>
            </details>
          )}
          {current.status === "error" && <ErrorCard error={current.error} />}
          {job?.status === "done" && <ResultView job={job} />}
        </div>
      )}
    </Sheet>
  );
}

function Leads() {
  const { data, error, loading } = useAsync(() => api.leads(), []);
  if (loading) return <Skeleton lines={6} />;
  if (error) return <Note tone="danger">{error}</Note>;
  if (!data?.length) return <Empty title="No leads yet">People found by searches are saved here, without duplicates.</Empty>;
  return (
    <div className="stack">
      <div className="row">
        <span className="muted num">{data.length} leads</span>
        <span className="spacer" />
        <a className="btn small" href="/api/leads.csv" download="leads.csv">
          Download CSV
        </a>
      </div>
      <DataView value={data.map(({ name, headline, location, url }) => ({ name, headline, location, url }))} />
    </div>
  );
}
