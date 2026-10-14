import { useState } from "react";
import { Icon } from "../icons";

// Shows a result the way a person reads it: a table for a list of records, a tree otherwise.
// With onPick, every field can be tapped to use it elsewhere (the builder inserts it as a chip).
export type Pick = { path: (string | number)[]; label: string; isList: boolean };

const isRecordList = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x));

const short = (v: unknown) => {
  if (v === null || v === undefined) return "empty";
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v || "empty";
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") return `${Object.keys(v).length} fields`;
  return String(v);
};

export function DataView({ value, onPick, rootLabel }: { value: unknown; onPick?: (p: Pick) => void; rootLabel?: string }) {
  if (value === undefined) return <p className="small muted">No output.</p>;
  if (isRecordList(value) && !onPick) return <Table rows={value} />;
  return (
    <div className="tree" role={onPick ? "list" : undefined}>
      <Node k={rootLabel} value={value} path={[]} onPick={onPick} depth={0} />
    </div>
  );
}

function Node({ k, value, path, onPick, depth }: { k?: string; value: unknown; path: (string | number)[]; onPick?: (p: Pick) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const composite = value !== null && typeof value === "object";
  // In a list of records, the fields of the first item stand for "each item".
  const entries: [string, unknown, (string | number)[]][] = !composite
    ? []
    : Array.isArray(value)
      ? isRecordList(value)
        ? Object.entries(value[0]).map(([ck, cv]) => [`each › ${ck}`, cv, [...path, 0, ck]])
        : value.slice(0, 20).map((cv, i) => [`${i + 1}`, cv, [...path, i]])
      : Object.entries(value as Record<string, unknown>).map(([ck, cv]) => [ck, cv, [...path, ck]]);

  const pick = onPick && k !== undefined ? () => onPick({ path, label: k, isList: Array.isArray(value) }) : undefined;
  const row = k !== undefined && (
    <div className="row" style={{ "--gap": "0" } as React.CSSProperties} role={onPick ? "listitem" : undefined}>
      {composite && (
        <button type="button" className="btn quiet icon small" aria-expanded={open} aria-label={open ? `Collapse ${k}` : `Expand ${k}`} onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={16} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 150ms" }} />
        </button>
      )}
      <button type="button" className="tree-row" style={{ flex: 1 }} onClick={pick ?? (composite ? () => setOpen(!open) : undefined)} disabled={!pick && !composite}>
        <span className="k">{k}</span>
        <span className="v">{short(value)}</span>
        {pick && <span className="use">Use</span>}
      </button>
    </div>
  );
  if (!composite) return row || <p>{short(value)}</p>;
  return (
    <>
      {row}
      {(open || k === undefined) && (
        <div className={k === undefined ? "" : "tree-children"}>
          {entries.map(([ck, cv, cp]) => (
            <Node key={cp.join(".")} k={ck} value={cv} path={cp} onPick={onPick} depth={depth + 1} />
          ))}
          {Array.isArray(value) && !isRecordList(value) && value.length > 20 && <p className="small muted">and {value.length - 20} more</p>}
        </div>
      )}
    </>
  );
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = r[c];
                return <td key={c}>{typeof v === "string" && /^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noreferrer">{v.replace(/^https?:\/\/(www\.)?/, "")}</a> : short(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
