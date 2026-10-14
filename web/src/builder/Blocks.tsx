import { useId, type ReactNode } from "react";
import { humanize, type OpSummary, type PropSchema } from "../api";
import { Icon } from "../icons";
import { Button } from "../ui";
import { chipLabel, isExpr, type CallNode, type LoopNode, type Node, type Value } from "./model";

// Where a value is being edited: an argument of a step, a loop setting, or an output field.
export type Target = { kind: "arg"; nodeId: string; key: string } | { kind: "items"; nodeId: string } | { kind: "output"; index: number };
export const sameTarget = (a?: Target, b?: Target) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

export type BlockActions = {
  ops: OpSummary[];
  selected?: string;
  target?: Target;
  running?: string; // id of the step whose "Run to here" is in progress
  select: (id: string) => void;
  setTarget: (t: Target) => void;
  pickData: (t: Target) => void;
  update: (id: string, fn: (n: Node) => Node) => void;
  move: (id: string, dir: -1 | 1) => void;
  remove: (id: string) => void;
  runTo: (id: string) => void;
  insert: (afterId: string | null, loopId: string | null) => void;
};

export function Steps({ nodes, loopId, a, start = 1 }: { nodes: Node[]; loopId: string | null; a: BlockActions; start?: number }) {
  return (
    <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
      {nodes.map((n, i) => (
        <div key={n.id} className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
          {n.type === "call" ? <CallBlock node={n} num={`${start + i}`} a={a} first={i === 0} last={i === nodes.length - 1} /> : <LoopBlock node={n} num={`${start + i}`} a={a} first={i === 0} last={i === nodes.length - 1} />}
          <Insert onClick={() => a.insert(n.id, loopId)} label={`Add a step after step ${start + i}`} />
        </div>
      ))}
    </div>
  );
}

export function Insert({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <div className="insert">
      <Button size="small" icon="plus" onClick={onClick} aria-label={label}>
        Add step
      </Button>
    </div>
  );
}

function BlockTools({ node, a, first, last }: { node: Node; a: BlockActions; first: boolean; last: boolean }) {
  const name = node.type === "call" ? humanize(node.op) : "loop";
  return (
    <div className="block-tools">
      <Button variant="quiet" size="small" icon="play" loading={a.running === node.id} onClick={() => a.runTo(node.id)}>
        Run to here
      </Button>
      <span className="spacer" />
      <Button variant="quiet" size="small" icon="up" disabled={first} onClick={() => a.move(node.id, -1)} aria-label={`Move ${name} up`} />
      <Button variant="quiet" size="small" icon="down" disabled={last} onClick={() => a.move(node.id, 1)} aria-label={`Move ${name} down`} />
      <Button variant="quiet" size="small" icon="eyeOff" aria-pressed={!!node.disabled} onClick={() => a.update(node.id, (n) => ({ ...n, disabled: !n.disabled }))} aria-label={node.disabled ? `Turn ${name} back on` : `Skip ${name} for now`} />
      <Button variant="quiet" size="small" icon="trash" onClick={() => a.remove(node.id)} aria-label={`Remove ${name}`} />
    </div>
  );
}

function CallBlock({ node, num, a, first, last }: { node: CallNode; num: string; a: BlockActions; first: boolean; last: boolean }) {
  const op = a.ops.find((o) => o.name === node.op);
  const props = Object.entries(op?.inputSchema.properties ?? {});
  const required = new Set(op?.inputSchema.required ?? []);
  return (
    <section className="block" data-selected={a.selected === node.id} data-disabled={!!node.disabled} aria-label={`Step ${num}: ${humanize(node.op)}`} onClick={(e) => e.target === e.currentTarget && a.select(node.id)}>
      <div className="block-head" onClick={() => a.select(node.id)}>
        <span className="block-num">{num}</span>
        <div className="block-title">
          <strong>{humanize(node.op)}</strong>
          <span>{op ? op.description : "This operation no longer exists."}</span>
        </div>
        {node.disabled && <span className="pill">Skipped</span>}
      </div>
      {props.map(([key, schema]) => (
        <ValueInput
          key={key}
          label={humanize(key)}
          required={required.has(key)}
          schema={schema}
          value={node.args[key]}
          active={a.target?.kind === "arg" && a.target.nodeId === node.id && a.target.key === key}
          onFocus={() => {
            a.select(node.id);
            a.setTarget({ kind: "arg", nodeId: node.id, key });
          }}
          onPick={() => a.pickData({ kind: "arg", nodeId: node.id, key })}
          onChange={(v) => a.update(node.id, (n) => ({ ...(n as CallNode), args: setArg((n as CallNode).args, key, v) }))}
        />
      ))}
      {!props.length && op && <p className="small muted">No inputs needed.</p>}
      <BlockTools node={node} a={a} first={first} last={last} />
    </section>
  );
}

const setArg = (args: Record<string, Value>, key: string, v: Value) => {
  const next = { ...args };
  if (v === undefined || v === "") delete next[key];
  else next[key] = v;
  return next;
};

function LoopBlock({ node, num, a, first, last }: { node: LoopNode; num: string; a: BlockActions; first: boolean; last: boolean }) {
  const items = node.items.$expr ? chipLabel(node.items) : undefined;
  const set = (patch: Partial<LoopNode>) => a.update(node.id, (n) => ({ ...(n as LoopNode), ...patch }));
  return (
    <section className="block" data-selected={a.selected === node.id} data-disabled={!!node.disabled} aria-label={`Step ${num}: for each ${node.as}`}>
      <div className="block-head" onClick={() => a.select(node.id)}>
        <span className="block-num">{num}</span>
        <div className="block-title">
          <strong>
            <Icon name="loop" size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
            For each {node.as}
          </strong>
          <span>Runs the steps inside once per item, up to {node.limit} times.</span>
        </div>
      </div>
      <div className="arg">
        <div className="arg-head">
          <label>In this list</label>
        </div>
        <div className="value-row">
          {items ? (
            <Chip text={items.text} code={!items.simple} active={sameTarget(a.target, { kind: "items", nodeId: node.id })} onClick={() => a.pickData({ kind: "items", nodeId: node.id })} />
          ) : (
            <Button size="small" icon="link" onClick={() => a.pickData({ kind: "items", nodeId: node.id })}>
              Choose a list
            </Button>
          )}
        </div>
      </div>
      <div className="row" style={{ "--gap": "12px", alignItems: "flex-end" } as React.CSSProperties}>
        <div className="field" style={{ flex: "1 1 8rem" }}>
          <label htmlFor={`${node.id}-as`}>Call each item</label>
          <input id={`${node.id}-as`} className="input" value={node.as} onChange={(e) => set({ as: e.target.value.replace(/[^a-zA-Z0-9_]/g, "").replace(/^[^a-zA-Z]+/, "") })} />
        </div>
        <div className="field" style={{ flex: "0 1 7rem" }}>
          <label htmlFor={`${node.id}-limit`}>At most</label>
          <input id={`${node.id}-limit`} className="input" type="number" inputMode="numeric" min={1} max={25} value={node.limit} onChange={(e) => set({ limit: Math.max(1, Math.min(25, Number(e.target.value) || 1)) })} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={node.onError === "skip"} onChange={(e) => set({ onError: e.target.checked ? "skip" : "stop" })} />
        Skip items that fail instead of stopping
      </label>
      <div className="loop-body">
        {node.steps.length ? (
          <>
            <Insert onClick={() => a.insert(null, node.id)} label={`Add a step at the start of the loop`} />
            <Steps nodes={node.steps} loopId={node.id} a={a} start={1} />
          </>
        ) : (
          <div className="stack" style={{ alignItems: "center", padding: "8px 0" } as React.CSSProperties}>
            <p className="small muted">Add the steps to run for each {node.as}.</p>
            <Insert onClick={() => a.insert(null, node.id)} label="Add a step inside the loop" />
          </div>
        )}
      </div>
      <BlockTools node={node} a={a} first={first} last={last} />
    </section>
  );
}

export function Chip({ text, code, active, onClick, onClear }: { text: string; code?: boolean; active?: boolean; onClick?: () => void; onClear?: () => void }) {
  return (
    <span className="row" style={{ "--gap": "2px", flexWrap: "nowrap", maxWidth: "100%" } as React.CSSProperties}>
      <button type="button" className={`chip ${code ? "code" : ""}`} onClick={onClick} aria-label={`Data: ${text}. Change`} style={active ? { outline: "2px solid var(--accent-text)", outlineOffset: 1 } : undefined}>
        <Icon name={code ? "code" : "link"} size={14} />
        <span>{text}</span>
      </button>
      {onClear && <Button variant="quiet" size="small" icon="x" onClick={onClear} aria-label={`Clear ${text}`} />}
    </span>
  );
}

// One input of a step: a typed literal, or data from elsewhere shown as a chip.
export function ValueInput({ label, required, schema, value, active, onFocus, onPick, onChange, extra }: { label: string; required?: boolean; schema?: PropSchema; value: Value; active?: boolean; onFocus: () => void; onPick: () => void; onChange: (v: Value) => void; extra?: ReactNode }) {
  const id = useId();
  const type = schema?.type;
  return (
    <div className="arg">
      <div className="arg-head">
        <label htmlFor={id}>{label}</label>
        {!required && <span className="req">optional</span>}
        {extra}
      </div>
      <div className="value-row" onFocusCapture={onFocus}>
        {isExpr(value) ? (
          (() => {
            const c = chipLabel(value);
            return <Chip text={c.text} code={!c.simple} active={active} onClick={onPick} onClear={() => onChange(undefined)} />;
          })()
        ) : type === "boolean" ? (
          <label className="check">
            <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
            {value ? "Yes" : "No"}
          </label>
        ) : (
          <input
            id={id}
            className="input"
            type={type === "integer" || type === "number" ? "number" : "text"}
            inputMode={type === "integer" || type === "number" ? "numeric" : undefined}
            placeholder={schema?.default !== undefined ? `Default: ${schema.default}` : schema?.description ?? ""}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? undefined : type === "integer" || type === "number" ? Number(e.target.value) : e.target.value)}
            style={active ? { borderColor: "var(--accent-text)" } : undefined}
          />
        )}
        {!isExpr(value) && (
          <Button size="small" icon="link" onClick={onPick} aria-label={`Use data for ${label}`}>
            Use data
          </Button>
        )}
      </div>
    </div>
  );
}
