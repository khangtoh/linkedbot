import { useState, type FormEvent } from "react";
import { api, ApiError, humanize, untilDone, type Job } from "../api";
import { Link } from "../router";
import { announceRun, Button, Field, Note, useStatus } from "../ui";
import { ErrorCard, RunTimeline } from "./RunView";
import { DataView } from "./DataView";

type GenResult = { ok: boolean; reason?: string; draft?: string; problems?: string[]; output?: unknown; pageLoads: number; events: string[] };

// Journey 4, first version: describe, let the generator work on the server, review the draft.
// The live browser view and correcting by pointing come next.
export function Generate() {
  const { status, refresh } = useStatus();
  const [description, setDescription] = useState("");
  const [exampleUrl, setExampleUrl] = useState("");
  const [budget, setBudget] = useState(5);
  const [job, setJob] = useState<Job<GenResult>>();
  const [error, setError] = useState<string>();
  const [published, setPublished] = useState(false);

  const urlError = exampleUrl && !/^https:\/\/www\.linkedin\.com\/(in|company|search\/results|jobs|posts|feed\/update)\//.test(exampleUrl) ? "Use a LinkedIn page address, for example https://www.linkedin.com/company/anthropic/about/" : undefined;

  async function start(e: FormEvent) {
    e.preventDefault();
    if (urlError) return;
    setError(undefined);
    setPublished(false);
    try {
      const started = (await api.run("generate_api", { description, exampleUrl, budget })) as Job<GenResult>;
      setJob(started);
      announceRun();
      setJob(await untilDone(started, setJob));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the generator.");
    } finally {
      void refresh();
    }
  }

  async function publish(name: string) {
    try {
      await api.publish(name);
      setPublished(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't publish.");
    }
  }

  const running = job && (job.status === "queued" || job.status === "running");
  const result = job?.result;
  return (
    <>
      <div className="page-head">
        <div style={{ flex: 1 }}>
          <h1>Generate an API</h1>
          <p>Describe data you want from a LinkedIn page. The generator works out how to read it and saves a draft for you to check.</p>
        </div>
      </div>
      <div className="stack" style={{ "--gap": "24px", maxWidth: "40rem" } as React.CSSProperties}>
        {!status?.session && (
          <Note tone="warn" icon="user">
            The generator reads LinkedIn with your session. <Link to="/settings">Log in to LinkedIn</Link> first.
          </Note>
        )}
        <form className="stack" style={{ "--gap": "16px" } as React.CSSProperties} onSubmit={start}>
          <Field label="What should it return?" hint="For example: a company's name, industry, size, headquarters and website.">
            {(p) => <textarea {...p} className="input" value={description} onChange={(e) => setDescription(e.target.value)} required minLength={10} />}
          </Field>
          <Field label="An example page" error={urlError} hint="A LinkedIn page where that data is shown.">
            {(p) => <input {...p} className="input" type="url" inputMode="url" placeholder="https://www.linkedin.com/company/…/about/" value={exampleUrl} onChange={(e) => setExampleUrl(e.target.value)} required />}
          </Field>
          <Field label="Page loads it may use" hint={`Each counts toward today's caps (${status?.capsLeft.view_profile ?? "?"} profile views left). Testing on a page that is already open is free.`}>
            {(p) => <input {...p} className="input" type="number" inputMode="numeric" min={2} max={10} value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={{ maxWidth: "8rem" }} />}
          </Field>
          <div>
            <Button variant="primary" type="submit" icon="sparkle" loading={running} disabled={!status?.session}>
              Generate
            </Button>
          </div>
          <p className="small muted">This uses Claude, so each generation also costs a little on your Anthropic account.</p>
        </form>
        {error && <Note tone="danger">{error}</Note>}
        {job && (running || job.status === "error") && (
          <section className="stack" aria-label="Generation" style={{ "--gap": "12px" } as React.CSSProperties}>
            <RunTimeline job={job} />
            {running && <p className="small muted">It opens the page, studies it and tests what it finds. This usually takes a few minutes; you can leave this screen.</p>}
          </section>
        )}
        {job?.status === "error" && <ErrorCard error={job.error} />}
        {result && !result.ok && <ErrorCard error={`The generator stopped: ${result.reason}`} />}
        {result?.ok && result.draft && (
          <section className="stack" aria-labelledby="gen-result">
            <h2 id="gen-result">Draft: {humanize(result.draft)}</h2>
            <p className="small muted">Used {result.pageLoads} page load(s). This is what it returned on the example page:</p>
            <DataView value={result.output} />
            {!!result.problems?.length && <Note tone="warn">Needs fixing before it can be published: {result.problems.join("; ")}</Note>}
            {published ? (
              <Note tone="ok">Published. It is in your Library and available to your AI assistants.</Note>
            ) : (
              <div className="row">
                <Button variant="primary" icon="check" onClick={() => publish(result.draft!)} disabled={!!result.problems?.length}>
                  Looks right, publish
                </Button>
                <Button onClick={() => void api.remove(result.draft!, true).finally(() => setJob(undefined))}>Discard and try again</Button>
              </div>
            )}
          </section>
        )}
        {!!result?.events?.length && (
          <details>
            <summary className="small">What the generator did ({result.events.length} steps)</summary>
            <pre className="json" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
              {result.events.join("\n")}
            </pre>
          </details>
        )}
      </div>
    </>
  );
}
