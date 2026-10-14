import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, costText, humanize, untilDone, type OpSummary, type PreviewResult } from "../api";
import { Icon } from "../icons";
import { Link, navigate } from "../router";
import { Button, Empty, Field, Note, Skeleton, useStatus } from "../ui";
import { Chip, Insert, sameTarget, Steps, ValueInput, type BlockActions, type Target } from "../builder/Blocks";
import { DataPicker, OpPicker, type StepPreview } from "../builder/Pickers";
import { DataView, type Pick } from "./DataView";
import {
  chipLabel,
  emptyTool,
  exprFor,
  findNode,
  fromDefinition,
  insertNode,
  isExpr,
  loopsAround,
  moveNode,
  removeNode,
  testInput,
  toDefinition,
  truncatedAt,
  uniqueId,
  updateNode,
  visibleBefore,
  type CallNode,
  type InputDef,
  type LoopNode,
  type Node,
  type ToolDraft,
  type Value,
} from "../builder/model";

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
type Save = { state: "idle" | "saving" | "saved" | "error"; problems: string[]; message?: string };

// Journey 3: compose a tool by chaining operations. The stack on the left is the tool; the preview
// shows what a step really returned, and tapping a field there uses it in the input being edited.
export function Builder({ name }: { name?: string }) {
  const [tool, setTool] = useState<ToolDraft>();
  const [ops, setOps] = useState<OpSummary[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [target, setTarget] = useState<Target>();
  const [picker, setPicker] = useState<{ afterId: string | null; loopId: string | null }>();
  const [dataFor, setDataFor] = useState<Target>();
  const [previews, setPreviews] = useState<Record<string, StepPreview>>({});
  const [running, setRunning] = useState<string>();
  const [runNote, setRunNote] = useState<{ tone?: "danger" | "warn" | "ok"; text: string }>();
  const [save, setSave] = useState<Save>({ state: "idle", problems: [] });
  const [published, setPublished] = useState<number>();
  const [paneOpen, setPaneOpen] = useState(false);
  const { refresh } = useStatus();
  const savedName = useRef<string | undefined>(name);
  const loadedDraft = useRef(false);

  useEffect(() => {
    api.ops(false).then(setOps, () => setOps([]));
    if (!name) return setTool(emptyTool());
    api.op(name, true).then(
      (def) => {
        loadedDraft.current = def.status === "draft";
        setTool(fromDefinition(def));
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [name]);

  // ---------- saving: drafts save themselves; publishing is a choice ----------
  const persist = useCallback(async (t: ToolDraft) => {
    if (!NAME.test(t.name)) return;
    setSave((s) => ({ ...s, state: "saving" }));
    try {
      const { errors } = await api.saveDraft(toDefinition(t));
      setSave({ state: "saved", problems: errors });
      if (savedName.current !== t.name) {
        savedName.current = t.name;
        history.replaceState(null, "", `/studio/build/${t.name}`); // keep the URL, without remounting
      }
    } catch (e) {
      setSave({ state: "error", problems: [], message: e instanceof ApiError && e.status === 409 ? `"${t.name}" is already used. Pick another name.` : (e as Error).message });
    }
  }, []);
  const first = useRef(true);
  useEffect(() => {
    if (!tool) return;
    if (first.current) {
      first.current = false;
      // Opening a tool must not create a draft. A published one is valid as it stands; an existing
      // draft is re-saved (unchanged) only to learn what still blocks publishing.
      if (name && loadedDraft.current) void persist(tool);
      else if (name) setSave({ state: "saved", problems: [] });
      return;
    }
    setPublished(undefined);
    const t = setTimeout(() => void persist(tool), 900);
    return () => clearTimeout(t);
  }, [tool, persist, name]);

  const edit = (fn: (t: ToolDraft) => ToolDraft) => setTool((t) => (t ? fn(t) : t));
  const setSteps = (fn: (s: Node[]) => Node[]) => edit((t) => ({ ...t, steps: fn(t.steps) }));

  // ---------- previews ----------
  const runTo = useCallback(
    async (id: string) => {
      if (!tool) return;
      setRunning(id);
      setSelected(id);
      setPaneOpen(true);
      setRunNote(undefined);
      try {
        let job = await api.preview(truncatedAt(tool, id), testInput(tool), 2);
        if (job.status !== "done" && job.status !== "error") {
          setRunNote({ text: job.status === "queued" ? "Waiting for its turn: one thing runs on LinkedIn at a time." : "Running at a human pace; this can take a minute." });
          job = await untilDone(job);
        }
        if (job.status === "error") return setRunNote({ tone: "danger", text: job.error ?? "The preview failed." });
        const r = job.result as PreviewResult;
        if (r.problems?.length) return setRunNote({ tone: "warn", text: `Fix this first: ${r.problems.join(" ")}` });
        setPreviews((p) => ({ ...p, ...collect(r) }));
        setRunNote(r.error ? { tone: "danger", text: r.error } : { tone: "ok", text: `Ran up to here, using ${costText(r.cost)}. Loops ran their first 2 items.` });
      } catch (e) {
        setRunNote({ tone: "danger", text: (e as Error).message });
      } finally {
        setRunning(undefined);
        void refresh();
      }
    },
    [tool, refresh],
  );

  // ---------- inserting data ----------
  const insertExpr = useCallback(
    (t: Target, expr: string) => {
      const v: Value = { $expr: expr };
      if (t.kind === "arg") setSteps((s) => updateNode(s, t.nodeId, (n) => ({ ...(n as CallNode), args: { ...(n as CallNode).args, [t.key]: v } })));
      else if (t.kind === "items") setSteps((s) => updateNode(s, t.nodeId, (n) => ({ ...(n as LoopNode), items: v })));
      else edit((tl) => ({ ...tl, rawOutput: undefined, outputFields: tl.outputFields.map((f, i) => (i === t.index ? { ...f, value: v } : f)) }));
      setDataFor(undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // A field tapped in the preview pane goes into the input being edited, if that input can see it.
  const pickFromPane = (p: Pick, from: { kind: "step" | "item"; id: string }) => {
    if (!tool || !target) return setRunNote({ tone: "warn", text: "Tap an input of a step first, then tap the data to use there." });
    const tid = target.kind === "output" ? null : target.nodeId;
    if (from.kind === "item") {
      const loop = loopsAround(tool.steps, tid ?? "").find((l) => l.id === from.id);
      if (!loop) return setRunNote({ tone: "warn", text: "That item only exists inside its loop. Pick an input of a step inside the loop." });
      return insertExpr(target, exprFor({ kind: "item", id: loop.id }, p.path, loop.as));
    }
    const visible = tid === null ? tool.steps : visibleBefore(tool.steps, tid);
    if (!visible.some((n) => n.id === from.id)) return setRunNote({ tone: "warn", text: "That step comes later, or is inside a loop this input can't see. Use an earlier step, or the loop's results." });
    insertExpr(target, exprFor({ kind: "step", id: from.id }, p.path));
  };

  const actions: BlockActions = {
    ops,
    selected,
    target,
    running,
    select: (id) => setSelected(id),
    setTarget,
    pickData: (t) => {
      setTarget(t);
      setDataFor(t);
    },
    update: (id, fn) => setSteps((s) => updateNode(s, id, fn)),
    move: (id, dir) => setSteps((s) => moveNode(s, id, dir)),
    remove: (id) => {
      setSteps((s) => removeNode(s, id));
      if (selected === id) setSelected(undefined);
    },
    runTo: (id) => void runTo(id),
    insert: (afterId, loopId) => setPicker({ afterId, loopId }),
  };

  if (loadError) return <Note tone="danger">Couldn't open this tool: {loadError}</Note>;
  if (!tool) return <Skeleton lines={8} />;

  const sel = selected ? findNode(tool.steps, selected) : undefined;
  const canPublish = NAME.test(tool.name) && save.state === "saved" && !save.problems.length;

  return (
    <>
      <div className="page-head">
        <Link to="/" className="btn quiet small" aria-label="Back to the library">
          <Icon name="back" size={18} /> Library
        </Link>
        <div style={{ flexBasis: "100%" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{name ? humanize(tool.name) : tool.name ? humanize(tool.name) : "New tool"}</h1>
          <p aria-live="polite" className="small">
            {save.state === "saving" ? "Saving…" : save.state === "saved" ? (published ? `Published as version ${published}.` : "Draft saved.") : save.state === "error" ? save.message : NAME.test(tool.name) ? "" : "Give it a name to save it as a draft."}
          </p>
        </div>
        <Button
          variant="primary"
          icon="check"
          disabled={!canPublish}
          onClick={async () => {
            try {
              const op = await api.publish(tool.name);
              setPublished(op.version);
            } catch (e) {
              setSave((s) => ({ ...s, problems: (e as ApiError).body?.errors ?? [(e as Error).message] }));
            }
          }}
        >
          Publish
        </Button>
      </div>

      <div className="builder">
        <div className="stack" style={{ "--gap": "28px" } as React.CSSProperties}>
          {published && (
            <Note tone="ok">
              <strong>Published.</strong> It's in your Library and is now a tool your AI assistants can call. Assistants that already loaded their tool list can reach it with run_operation until they refresh.
            </Note>
          )}
          <About tool={tool} isNew={!name} edit={edit} />
          <Inputs tool={tool} edit={edit} />
          <section className="stack" aria-labelledby="b-steps">
            <h2 id="b-steps">Steps</h2>
            {tool.steps.length ? (
              <>
                <Insert onClick={() => setPicker({ afterId: null, loopId: null })} label="Add a step at the start" />
                <Steps nodes={tool.steps} loopId={null} a={actions} />
              </>
            ) : (
              <Empty title="Add a first step" action={<Button variant="primary" icon="plus" onClick={() => setPicker({ afterId: null, loopId: null })}>Add a step</Button>}>
                Each step runs an operation. Later steps can use what earlier ones returned.
              </Empty>
            )}
          </section>
          <Output tool={tool} edit={edit} target={target} setTarget={setTarget} pickData={(t) => { setTarget(t); setDataFor(t); }} />
          {!!save.problems.length && (
            <Note tone="warn">
              <strong>Before you can publish:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {save.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Note>
          )}
          <Note icon="shield">Tools are read-only: every step only reads LinkedIn, and each run is checked against today's caps before it starts.</Note>
        </div>

        <aside className="preview-pane" data-open={paneOpen} aria-label="Preview" hidden={!tool.steps.length}>
          <div className="pane-head">
            <button type="button" className="btn quiet small" aria-expanded={paneOpen} onClick={() => setPaneOpen(!paneOpen)} style={{ marginLeft: -8 }}>
              <Icon name="up" size={16} style={{ transform: paneOpen ? "rotate(180deg)" : undefined }} />
              <span className="visually-hidden">{paneOpen ? "Shrink" : "Expand"} preview</span>
            </button>
            <h2 style={{ flex: 1, fontSize: "1rem" }}>{sel ? (sel.node.type === "call" ? humanize(sel.node.op) : `For each ${sel.node.as}`) : "Preview"}</h2>
            {sel && (
              <Button size="small" icon="play" loading={running === sel.node.id} onClick={() => void runTo(sel.node.id)}>
                Run to here
              </Button>
            )}
          </div>
          <div className="pane-body stack">
            {runNote && <Note tone={runNote.tone}>{runNote.text}</Note>}
            {!sel && <p className="small muted">Select a step and run it to see what it returns. Then tap an input of a later step and tap a field here to use it.</p>}
            {sel && <PaneData node={sel.node} preview={previews[sel.node.id]} onPick={pickFromPane} target={target} />}
          </div>
        </aside>
      </div>

      {picker && (
        <OpPicker
          ops={ops}
          exclude={tool.name}
          onClose={() => setPicker(undefined)}
          onLoop={() => {
            const id = uniqueId(tool.steps, "each");
            setSteps((s) => insertNode(s, { id, type: "forEach", items: { $expr: "" }, as: "item", limit: 5, onError: "skip", steps: [] }, picker));
            setSelected(id);
            setPicker(undefined);
            setDataFor({ kind: "items", nodeId: id });
          }}
          onPick={(op) => {
            const id = uniqueId(tool.steps, op.name.split("_")[0] === "search" ? "found" : op.name);
            setSteps((s) => insertNode(s, { id, type: "call", op: op.name, args: {} }, picker));
            setSelected(id);
            setPicker(undefined);
          }}
        />
      )}
      {dataFor && <DataPicker tool={tool} target={dataFor} previews={previews} onClose={() => setDataFor(undefined)} onPick={(e) => insertExpr(dataFor, e)} onRunTo={(id) => { setDataFor(undefined); void runTo(id); }} />}
    </>
  );
}

// Turns a preview result into per-step data: top-level steps from `steps`, steps inside loops from
// the first pass of the trace ("loop[0]/inner").
function collect(r: PreviewResult): Record<string, StepPreview> {
  const out: Record<string, StepPreview> = {};
  for (const [id, s] of Object.entries(r.steps ?? {})) out[id] = s as StepPreview;
  for (const t of r.trace ?? []) {
    const parts = t.path.split("/");
    if (parts.length < 2 || !parts.slice(0, -1).every((p) => p.endsWith("[0]"))) continue;
    const id = parts.at(-1)!;
    out[id] = t.error ? { status: "error", error: t.error } : { status: "done", output: t.output };
  }
  return out;
}

function PaneData({ node, preview, onPick, target }: { node: Node; preview?: StepPreview; onPick: (p: Pick, from: { kind: "step" | "item"; id: string }) => void; target?: Target }) {
  if (!preview) return <p className="small muted">Not run yet. "Run to here" runs the tool up to this step with your test inputs.</p>;
  if (preview.status === "skipped") return <p className="small muted">This step is turned off.</p>;
  if (preview.error) return <Note tone="danger">{preview.error}</Note>;
  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      {target && <p className="small muted">Tap a field to use it in the input you're editing.</p>}
      {node.type === "forEach" && preview.firstItem !== undefined && (
        <section className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <h3>Each {node.as} (the first one)</h3>
          <DataView value={preview.firstItem} rootLabel={node.as} onPick={(p) => onPick(p, { kind: "item", id: node.id })} />
        </section>
      )}
      <section className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        {node.type === "forEach" && <h3>Results</h3>}
        <DataView value={preview.output} rootLabel={node.id} onPick={(p) => onPick(p, { kind: "step", id: node.id })} />
      </section>
    </div>
  );
}

function About({ tool, isNew, edit }: { tool: ToolDraft; isNew: boolean; edit: (fn: (t: ToolDraft) => ToolDraft) => void }) {
  const nameError = tool.name && !NAME.test(tool.name) ? "Use lowercase letters, digits and underscores, starting with a letter." : undefined;
  return (
    <section className="stack" aria-labelledby="b-about">
      <h2 id="b-about">About this tool</h2>
      {isNew && (
        <Field label="Name" error={nameError} hint="This is how assistants call it, for example find_and_read.">
          {(p) => <input {...p} className="input mono" autoCapitalize="off" spellCheck={false} value={tool.name} onChange={(e) => edit((t) => ({ ...t, name: e.target.value.toLowerCase().replace(/[\s-]+/g, "_") }))} />}
        </Field>
      )}
      <Field label="What it does" hint="Assistants read this to decide when to use it. Say what it returns.">
        {(p) => <textarea {...p} className="input" rows={3} value={tool.description} onChange={(e) => edit((t) => ({ ...t, description: e.target.value }))} />}
      </Field>
    </section>
  );
}

function Inputs({ tool, edit }: { tool: ToolDraft; edit: (fn: (t: ToolDraft) => ToolDraft) => void }) {
  const set = (i: number, patch: Partial<InputDef>) => edit((t) => ({ ...t, inputs: t.inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  return (
    <section className="stack" aria-labelledby="b-inputs">
      <h2 id="b-inputs">Inputs</h2>
      <p className="small muted">What the tool asks for when it runs. The test value is used for previews here.</p>
      {tool.inputs.map((inp, i) => (
        <div key={i} className="block" style={{ gap: 10 }}>
          <div className="row" style={{ "--gap": "10px", alignItems: "flex-end" } as React.CSSProperties}>
            <div className="field" style={{ flex: "1 1 9rem" }}>
              <label htmlFor={`in-key-${i}`}>Name</label>
              <input id={`in-key-${i}`} className="input mono" value={inp.key} autoCapitalize="off" spellCheck={false} onChange={(e) => set(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "_") })} />
            </div>
            <div className="field" style={{ flex: "0 1 8rem" }}>
              <label htmlFor={`in-type-${i}`}>Kind</label>
              <select id={`in-type-${i}`} className="input" value={inp.type} onChange={(e) => set(i, { type: e.target.value as InputDef["type"], test: "" })}>
                <option value="string">Text</option>
                <option value="integer">Number</option>
                <option value="boolean">Yes / no</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor={`in-test-${i}`}>Test value</label>
            {inp.type === "boolean" ? (
              <label className="check">
                <input id={`in-test-${i}`} type="checkbox" checked={!!inp.test} onChange={(e) => set(i, { test: e.target.checked })} /> {inp.test ? "Yes" : "No"}
              </label>
            ) : (
              <input id={`in-test-${i}`} className="input" type={inp.type === "integer" ? "number" : "text"} value={String(inp.test)} onChange={(e) => set(i, { test: e.target.value })} />
            )}
          </div>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={inp.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
            </label>
            <span className="spacer" />
            <Button variant="quiet" size="small" icon="trash" onClick={() => edit((t) => ({ ...t, inputs: t.inputs.filter((_, j) => j !== i) }))}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button size="small" icon="plus" onClick={() => edit((t) => ({ ...t, inputs: [...t.inputs, { key: t.inputs.length ? `input_${t.inputs.length + 1}` : "keywords", type: "string", required: true, description: "", test: "" }] }))}>
          Add an input
        </Button>
      </div>
    </section>
  );
}

function Output({ tool, edit, target, setTarget, pickData }: { tool: ToolDraft; edit: (fn: (t: ToolDraft) => ToolDraft) => void; target?: Target; setTarget: (t: Target) => void; pickData: (t: Target) => void }) {
  const raw = tool.rawOutput;
  return (
    <section className="stack" aria-labelledby="b-out">
      <h2 id="b-out">What it returns</h2>
      {raw !== undefined && isExpr(raw) ? (
        <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
          <p className="small muted">Set as an expression (for example by an assistant):</p>
          <Chip text={chipLabel(raw).text} code onClear={() => edit((t) => ({ ...t, rawOutput: undefined }))} />
        </div>
      ) : !tool.outputFields.length ? (
        <p className="small muted">The last step's result. Or choose fields to return instead:</p>
      ) : null}
      {tool.outputFields.map((f, i) => (
        <div key={i} className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
            <label className="visually-hidden" htmlFor={`out-key-${i}`}>
              Field name
            </label>
            <input id={`out-key-${i}`} className="input mono" style={{ flex: 1 }} value={f.key} onChange={(e) => edit((t) => ({ ...t, outputFields: t.outputFields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))} />
            <Button variant="quiet" size="small" icon="trash" aria-label={`Remove ${f.key}`} onClick={() => edit((t) => ({ ...t, outputFields: t.outputFields.filter((_, j) => j !== i) }))} />
          </div>
          <ValueInput
            label={`Value of ${f.key || "field"}`}
            required
            value={f.value}
            active={sameTarget(target, { kind: "output", index: i })}
            onFocus={() => setTarget({ kind: "output", index: i })}
            onPick={() => pickData({ kind: "output", index: i })}
            onChange={(v) => edit((t) => ({ ...t, outputFields: t.outputFields.map((x, j) => (j === i ? { ...x, value: v } : x)) }))}
          />
        </div>
      ))}
      <div>
        <Button size="small" icon="plus" onClick={() => edit((t) => ({ ...t, rawOutput: undefined, outputFields: [...t.outputFields, { key: `field_${t.outputFields.length + 1}`, value: undefined }] }))}>
          Add a field to return
        </Button>
      </div>
    </section>
  );
}

export { navigate };
