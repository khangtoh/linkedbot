import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { api, humanize, type Status } from "./api";
import { explainError } from "./explain";
import { Icon, type IconName } from "./icons";
import { navigate } from "./router";

export function Button({ variant = "secondary", size, loading, icon, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" | "danger"; size?: "small"; loading?: boolean; icon?: IconName }) {
  const cls = ["btn", variant !== "secondary" && variant, size, !children && "icon"].filter(Boolean).join(" ");
  return (
    <button type="button" {...rest} className={`${cls} ${rest.className ?? ""}`} disabled={rest.disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="spin" aria-hidden="true" /> : icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const describedBy = [hint && `${fid}-hint`, error && `${fid}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      {children({ id: fid, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && <p id={`${fid}-hint`} className="hint">{hint}</p>}
      {error && (
        <p id={`${fid}-error`} className="error" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      )}
    </div>
  );
}

export function Note({ tone, icon, children }: { tone?: "warn" | "danger" | "ok"; icon?: IconName; children: ReactNode }) {
  return (
    <div className={`note ${tone ?? ""}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon name={icon ?? (tone === "ok" ? "check" : tone ? "alert" : "info")} size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack" aria-hidden="true" style={{ "--gap": "10px" } as React.CSSProperties}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - ((i * 23) % 40)}%` }} />
      ))}
    </div>
  );
}

// A dialog that is a bottom sheet on phones and a centred panel on desktop.
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus();
    };
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="quiet" icon="x" aria-label="Close" data-close onClick={onClose} />
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

// ---------- LinkedIn status and runs, shared by the whole app ----------

export type Toast = { id: string; tone: "ok" | "danger"; title: string; detail?: string; jobId: string };
type StatusCtx = {
  status?: Status;
  refresh: () => Promise<void>;
  toasts: Toast[];
  dismiss: (id: string) => void;
  watch: (jobId: string, on: boolean) => void; // a run shown on screen gets no toast when it ends
};
const Ctx = createContext<StatusCtx>({ refresh: async () => {}, toasts: [], dismiss: () => {}, watch: () => {} });
export const useStatus = () => useContext(Ctx);

const active = (s?: Status) => !!s?.jobs.some((j) => j.status === "queued" || j.status === "running");

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef(new Map<string, string>()); // job id -> last status
  const watching = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const next = await api.status();
      // A run that was queued or running last time and has ended now gets a toast, unless it is on screen.
      for (const j of next.jobs) {
        const before = seen.current.get(j.id);
        if (before && (before === "queued" || before === "running") && (j.status === "done" || j.status === "error") && !watching.current.has(j.id) && j.cmd !== "__preview") {
          const name = humanize(j.cmd);
          const toast: Toast = j.status === "done" ? { id: j.id, tone: "ok", title: `${name} finished`, jobId: j.id } : { id: j.id, tone: "danger", title: `${name} failed`, detail: explainError(j.error).title, jobId: j.id };
          setToasts((t) => [...t.filter((x) => x.id !== toast.id), toast].slice(-3));
          if (toast.tone === "ok") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 6000);
        }
        seen.current.set(j.id, j.status);
      }
      setStatus(next);
    } catch {
      /* signed out or offline: the shell handles it */
    }
  }, []);

  // Every 2 seconds while something runs, every 20 otherwise, and right away when the page comes back.
  const busy = active(status);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), busy ? 2000 : 20_000);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("linkedbot:runstarted", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("linkedbot:runstarted", onVisible);
    };
  }, [refresh, busy]);

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const watch = useCallback((jobId: string, on: boolean) => void (on ? watching.current.add(jobId) : watching.current.delete(jobId)), []);
  return <Ctx.Provider value={{ status, refresh, toasts, dismiss, watch }}>{children}</Ctx.Provider>;
}

// Call after starting a run so the running pill appears without waiting for the next poll.
export const announceRun = () => window.dispatchEvent(new Event("linkedbot:runstarted"));

export function RunningPill() {
  const { status } = useStatus();
  const running = (status?.jobs ?? []).filter((j) => (j.status === "queued" || j.status === "running") && j.cmd !== "__preview");
  if (!running.length) return null;
  const one = running[running.length - 1];
  const text = running.length > 1 ? `${running.length} running` : `${humanize(one.cmd)}${one.progress ? ` · ${one.progress.message}` : ""}`;
  return (
    <button type="button" className="pill accent running-pill" onClick={() => navigate("/activity")} aria-label={`Running: ${text}. Open activity`}>
      <span className="spin" aria-hidden="true" style={{ width: 12, height: 12 }} />
      <span className="running-text">{text}</span>
    </button>
  );
}

export function Toaster() {
  const { toasts, dismiss } = useStatus();
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "danger" ? "alert" : "status"}>
          <Icon name={t.tone === "ok" ? "check" : "alert"} size={20} />
          <div className="grow">
            <strong>{t.title}</strong>
            {t.detail && <span>{t.detail}</span>}
          </div>
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              dismiss(t.id);
              navigate(`/activity?job=${t.jobId}`);
            }}
          >
            {t.tone === "ok" ? "View result" : "What to do"}
          </Button>
          <Button variant="quiet" size="small" icon="x" aria-label="Dismiss" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

export function linkedinState(s?: Status): { label: string; tone: "ok" | "warn" | "danger" | ""; icon: IconName } {
  if (!s) return { label: "Checking", tone: "", icon: "info" };
  if (s.loginInProgress) return { label: "Logging in", tone: "warn", icon: "user" };
  if (!s.session) return { label: "Needs login", tone: "warn", icon: "user" };
  if (s.linkedin.open) return { label: "Paused", tone: "danger", icon: "pause" };
  return { label: "Connected", tone: "ok", icon: "check" };
}

export function StatusPill({ onClick }: { onClick?: () => void }) {
  const { status } = useStatus();
  const st = linkedinState(status);
  return (
    <button type="button" className={`pill ${st.tone}`} onClick={onClick} aria-label={`LinkedIn: ${st.label}. Open settings`}>
      <Icon name={st.icon} size={14} />
      <span className="li-prefix">LinkedIn: </span>
      {st.label}
    </button>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (e: Error) => live && setState({ error: e.message, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
