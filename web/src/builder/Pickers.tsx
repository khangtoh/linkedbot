import { useMemo, useState } from "react";
import { humanize, type OpSummary } from "../api";
import { Icon } from "../icons";
import { Link } from "../router";
import { DataView, type Pick } from "../screens/DataView";
import { Button, Sheet } from "../ui";
import { exprFor, loopsAround, visibleBefore, type InputDef, type Node, type Source, type ToolDraft } from "./model";
import type { Target } from "./Blocks";

// Operations a tool may call: published, and not the agent or the generator.
const NOT_CALLABLE = new Set(["agent", "generate_api"]);

export function OpPicker({ ops, exclude, onPick, onLoop, onClose }: { ops: OpSummary[]; exclude?: string; onPick: (op: OpSummary) => void; onLoop: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return ops.filter((o) => o.status === "published" && !NOT_CALLABLE.has(o.name) && o.name !== exclude && (!t || `${o.name} ${o.description}`.toLowerCase().includes(t)));
  }, [ops, q, exclude]);
  return (
    <Sheet title="Add a step" onClose={onClose}>
      <div className="stack">
        <label htmlFor="op-search" className="visually-hidden">
          Search operations
        </label>
        <input id="op-search" className="input" type="search" placeholder="What should this step do?" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="list">
          {!q && (
            <button type="button" className="list-item" onClick={onLoop}>
              <Icon name="loop" />
              <div className="grow">
                <span className="title">Repeat for each item in a list</span>
                <p className="sub">Run some steps once per result, for example read each person a search found.</p>
              </div>
            </button>
          )}
          {list.map((o) => (
            <button key={o.name} type="button" className="list-item" onClick={() => onPick(o)}>
              <Icon name={o.kind === "tool" ? "build" : o.kind === "api" ? "sparkle" : "library"} />
              <div className="grow">
                <span className="title">{humanize(o.name)}</span>
                <p className="sub">{o.description}</p>
              </div>
            </button>
          ))}
        </div>
        {!list.length && (
          <p className="small muted">
            Nothing matches. If linkedbot can't do it yet, you can{" "}
            <Link to="/generate" onClick={onClose}>
              generate an API
            </Link>{" "}
            for it.
          </p>
        )}
      </div>
    </Sheet>
  );
}

export type StepPreview = { status: string; output?: unknown; error?: string; firstItem?: unknown };

// Everything a value can come from at this point in the tool, with real data where a preview ran.
export function DataPicker({ tool, target, previews, onPick, onRunTo, onClose }: { tool: ToolDraft; target: Target; previews: Record<string, StepPreview>; onPick: (expr: string) => void; onRunTo: (id: string) => void; onClose: () => void }) {
  const nodeId = target.kind === "output" ? null : target.nodeId;
  const steps: Node[] = nodeId === null ? tool.steps : visibleBefore(tool.steps, nodeId);
  // A loop's own list cannot use its own item; inside a loop, its item is available.
  const loops = nodeId === null ? [] : loopsAround(tool.steps, nodeId).filter((l) => !(target.kind === "items" && l.id === nodeId));
  const [raw, setRaw] = useState("");
  const pick = (source: Source, loopVar?: string) => (p: Pick) => onPick(exprFor(source, p.path, loopVar));

  return (
    <Sheet title={target.kind === "items" ? "Choose a list" : "Use data"} onClose={onClose}>
      <div className="stack" style={{ "--gap": "20px" } as React.CSSProperties}>
        {target.kind === "items" && <p className="small muted">Pick a list from an earlier step. The loop runs once per item in it.</p>}

        {loops.map((l) => (
          <Group key={l.id} title={`Each ${l.as}`} hint={previews[l.id]?.firstItem === undefined ? "Run the loop once to see the fields of an item." : "The first item, as an example."}>
            <Button size="small" icon="link" onClick={() => onPick(`$${l.as}`)}>
              The whole {l.as}
            </Button>
            {previews[l.id]?.firstItem !== undefined && <DataView value={previews[l.id].firstItem} rootLabel={l.as} onPick={pick({ kind: "item", id: l.id }, l.as)} />}
          </Group>
        ))}

        {tool.inputs.length > 0 && (
          <Group title="This tool's inputs">
            <div className="row">
              {tool.inputs.map((i: InputDef) => (
                <Button key={i.key} size="small" icon="link" onClick={() => onPick(`input.${i.key}`)}>
                  {humanize(i.key)}
                </Button>
              ))}
            </div>
          </Group>
        )}

        {steps.map((s) => {
          const name = s.type === "call" ? humanize(s.op) : `For each ${s.as} (results)`;
          const pv = previews[s.id];
          return (
            <Group key={s.id} title={`Step: ${name}`} hint={s.id}>
              {pv?.status === "done" && pv.output !== undefined ? (
                <DataView value={pv.output} rootLabel={s.id} onPick={pick({ kind: "step", id: s.id })} />
              ) : pv?.error ? (
                <p className="small" style={{ color: "var(--danger)" }}>Its last run failed: {pv.error}</p>
              ) : (
                <div className="row">
                  <Button size="small" icon="link" onClick={() => onPick(`steps.${s.id}.output`)}>
                    Its whole result
                  </Button>
                  <Button size="small" variant="quiet" icon="play" onClick={() => onRunTo(s.id)}>
                    Run to here to see its data
                  </Button>
                </div>
              )}
            </Group>
          );
        })}

        {!steps.length && !loops.length && !tool.inputs.length && <p className="muted">Nothing to use yet. Add an input to the tool, or a step before this one.</p>}

        <details>
          <summary className="small">Write an expression</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="small muted">
              JSONata over <code className="mono">input</code> and <code className="mono">steps.&lt;id&gt;.output</code>
              {loops.length ? `, plus $${loops.map((l) => l.as).join(", $")}` : ""}.
            </p>
            <input className="input mono" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="steps.found.output.sample[0..4]" aria-label="Expression" />
            <div>
              <Button size="small" disabled={!raw.trim()} onClick={() => onPick(raw.trim())}>
                Use this expression
              </Button>
            </div>
          </div>
        </details>
      </div>
    </Sheet>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
      <h3>
        {title} {hint && <span className="small muted" style={{ fontWeight: 400 }}>· {hint}</span>}
      </h3>
      {children}
    </section>
  );
}
