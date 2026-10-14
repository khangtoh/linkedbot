import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, humanize, untilDone, type Job, type OpSummary, type PropSchema } from "../api";
import { announceRun, Button, Field, Note, Sheet, useStatus } from "../ui";
import { ErrorCard, isActive, ResultView, RunTimeline } from "./RunView";

// Run a published operation: a form from its input schema, then the run itself, live. Runs are
// background jobs: closing the sheet does not stop one, and the top bar keeps showing it.
export function RunSheet({ op, onClose }: { op: OpSummary; onClose: () => void }) {
  const props = Object.entries(op.inputSchema.properties ?? {});
  const required = new Set(op.inputSchema.required ?? []);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState<string>();
  const { refresh, watch } = useStatus();
  const abort = useRef<AbortController | undefined>(undefined);

  // While this sheet shows a run, its end needs no toast; when the sheet closes, the toast takes over.
  useEffect(() => {
    if (!job) return;
    watch(job.id, true);
    return () => watch(job.id, false);
  }, [job?.id, watch]);
  useEffect(() => () => abort.current?.abort(), []);

  async function start(e?: FormEvent) {
    e?.preventDefault();
    setError(undefined);
    const input: Record<string, unknown> = {};
    for (const [k, p] of props) {
      const v = values[k];
      if (v === undefined || v === "") continue;
      input[k] = p.type === "integer" || p.type === "number" ? Number(v) : v;
    }
    try {
      const started = await api.run(op.name, input);
      setJob(started);
      announceRun();
      abort.current?.abort();
      abort.current = new AbortController();
      setJob(await untilDone(started, setJob, abort.current.signal));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : "Couldn't start the run. Check your connection and try again.");
    } finally {
      void refresh();
    }
  }

  const running = isActive(job);
  return (
    <Sheet
      title={humanize(op.name)}
      onClose={onClose}
      footer={
        running ? (
          <Button onClick={onClose}>Keep running in background</Button>
        ) : job ? (
          <>
            <Button onClick={onClose}>Done</Button>
            <Button variant="primary" icon="play" onClick={() => void start()}>
              Run again
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="run-form" icon="play">
              Run
            </Button>
          </>
        )
      }
    >
      <form id="run-form" className="stack" style={{ "--gap": "16px" } as React.CSSProperties} onSubmit={start}>
        <p className="muted">{op.description}</p>
        <fieldset disabled={running} className="stack" style={{ "--gap": "16px", border: 0, padding: 0, margin: 0 } as React.CSSProperties}>
          {props.map(([k, p]) => (
            <InputField key={k} name={k} schema={p} required={required.has(k)} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
          ))}
        </fieldset>
        {!job && op.usesLinkedIn && <p className="cost">Every page this opens counts toward today's LinkedIn caps (shown at the top). It runs in the background: you can close this and keep going.</p>}
        {error && <Note tone="danger">{error}</Note>}
      </form>
      {job && (
        <section className="stack run-live" aria-label="Run" style={{ "--gap": "16px", marginTop: 20 } as React.CSSProperties}>
          <RunTimeline job={job} />
          {running && op.usesLinkedIn && <p className="small muted">Pages load at a human pace on purpose, so this can take a minute.</p>}
          {job.status === "error" && <ErrorCard error={job.error} onRetry={() => void start()} />}
          {job.status === "done" && <ResultView job={job} />}
        </section>
      )}
    </Sheet>
  );
}

export function InputField({ name, schema, required, value, onChange }: { name: string; schema: PropSchema; required: boolean; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  const label = `${humanize(name)}${required ? "" : " (optional)"}`;
  if (schema.type === "boolean") {
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  const numeric = schema.type === "integer" || schema.type === "number";
  return (
    <Field label={label} hint={schema.description}>
      {(p) => (
        <input
          {...p}
          className="input"
          inputMode={numeric ? "numeric" : undefined}
          type={numeric ? "number" : "text"}
          min={schema.minimum}
          max={schema.maximum}
          placeholder={schema.default !== undefined ? `Default: ${schema.default}` : undefined}
          required={required}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
