import { useMemo, useState } from "react";
import { api, humanize, type OpSummary } from "../api";
import { Icon } from "../icons";
import { Link, navigate } from "../router";
import { Button, Empty, Note, Skeleton, useAsync } from "../ui";
import { RunSheet } from "./RunSheet";

// Hidden from the Library: the generator has its own tab, and the agent is for MCP-less use.
const HIDDEN = new Set(["generate_api"]);
const KINDS = [
  { key: "tool", title: "Your tools", empty: "Tools you build by chaining operations appear here." },
  { key: "api", title: "Generated APIs", empty: "APIs you generate for LinkedIn pages appear here." },
  { key: "builtin", title: "Built in", empty: "" },
] as const;

export function Library() {
  const { data, error, loading, reload } = useAsync(() => api.ops(true), []);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState<OpSummary>();
  const ops = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A draft and its published version share a name: show one row, marked as having a draft.
    const byName = new Map<string, OpSummary & { hasDraft?: boolean }>();
    for (const op of data ?? []) {
      if (HIDDEN.has(op.name) || (q && !`${op.name} ${op.description}`.toLowerCase().includes(q))) continue;
      const seen = byName.get(op.name);
      if (!seen) byName.set(op.name, { ...op, hasDraft: op.status === "draft" });
      else if (op.status === "draft") seen.hasDraft = true;
      else byName.set(op.name, { ...op, hasDraft: true });
    }
    return [...byName.values()];
  }, [data, query]);

  return (
    <>
      <div className="page-head">
        <div style={{ flex: 1 }}>
          <h1>Library</h1>
          <p>Everything linkedbot can do for you. Each one is also a tool for your AI assistants.</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => navigate("/build")}>
          New tool
        </Button>
      </div>
      <div className="field" style={{ marginBottom: 20, maxWidth: "28rem" }}>
        <label htmlFor="lib-search" className="visually-hidden">
          Search the library
        </label>
        <input id="lib-search" className="input" type="search" placeholder="Search by name or what it does" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {loading && !data && <Skeleton lines={6} />}
      {error && (
        <Note tone="danger">
          Couldn't load the library: {error}.{" "}
          <button type="button" className="btn quiet small" onClick={reload}>
            Try again
          </button>
        </Note>
      )}
      {data &&
        KINDS.map((k) => {
          const items = ops.filter((o) => o.kind === k.key);
          if (!items.length && (k.key === "builtin" || query)) return null;
          return (
            <section key={k.key} aria-labelledby={`lib-${k.key}`}>
              <h2 className="section-title" id={`lib-${k.key}`}>
                {k.title} <span className="num">{items.length || ""}</span>
              </h2>
              {items.length ? (
                <div className="list">
                  {items.map((op) => (
                    <Row key={op.name} op={op} onRun={() => setRunning(op)} />
                  ))}
                </div>
              ) : (
                <p className="small muted" style={{ padding: "8px 4px 4px" }}>
                  {k.empty}{" "}
                  {k.key === "tool" ? <Link to="/build">Build one</Link> : <Link to="/generate">Generate one</Link>}
                </p>
              )}
            </section>
          );
        })}
      {data && !ops.length && query && <Empty title="Nothing matches">Try other words, or build a new tool.</Empty>}
      {running && <RunSheet op={running} onClose={() => setRunning(undefined)} />}
    </>
  );
}

function Row({ op, onRun }: { op: OpSummary & { hasDraft?: boolean }; onRun: () => void }) {
  const published = op.status === "published";
  return (
    <div className="list-item">
      <div className="grow">
        <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
          <span className="title">{humanize(op.name)}</span>
          {!published && <span className="pill warn">Draft</span>}
          {published && op.hasDraft && <span className="pill">Draft changes</span>}
        </div>
        <p className="sub">{op.description}</p>
      </div>
      {op.kind === "tool" && (
        <Button variant="quiet" size="small" onClick={() => navigate(`/build/${op.name}`)}>
          Edit
        </Button>
      )}
      {published && (
        <Button size="small" icon="play" onClick={onRun} aria-label={`Run ${humanize(op.name)}`}>
          <span className="visually-hidden">Run</span>
        </Button>
      )}
      {!published && op.kind !== "tool" && <Icon name="chevron" size={18} className="muted" />}
    </div>
  );
}
