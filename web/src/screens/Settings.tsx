import { useState } from "react";
import { api, ApiError, type ClaudeSettings, type ClaudeTest } from "../api";
import { Icon } from "../icons";
import { Button, Field, linkedinState, Note, Skeleton, useAsync, useStatus } from "../ui";

const ACCENTS = [
  { key: "terracotta", label: "Terracotta", swatch: "oklch(56% 0.14 40)" },
  { key: "amber", label: "Amber", swatch: "oklch(66% 0.14 68)" },
  { key: "sage", label: "Sage", swatch: "oklch(50% 0.08 150)" },
  { key: "plum", label: "Plum", swatch: "oklch(48% 0.12 330)" },
];

export function Settings() {
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="stack" style={{ "--gap": "36px", maxWidth: "44rem" } as React.CSSProperties}>
        <LinkedIn />
        <Claude />
        <ConnectClient />
        <Appearance />
        <Account />
      </div>
    </>
  );
}

function LinkedIn() {
  const { status, refresh } = useStatus();
  const st = linkedinState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function login() {
    setBusy(true);
    setError(undefined);
    // Open the tab first: browsers block pop-ups opened after an await.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await api.startLogin();
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(refresh, 1500);
    } catch (e) {
      tab?.close();
      setError(e instanceof ApiError ? e.message : "Couldn't start the login.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="stack" aria-labelledby="set-li">
      <h2 id="set-li">LinkedIn</h2>
      <div className="row">
        <span className={`pill ${st.tone}`}>
          <Icon name={st.icon} size={14} /> {st.label}
        </span>
        {status?.linkedin.open && <span className="small muted">{status.linkedin.reason}</span>}
      </div>
      <p className="muted prose">
        linkedbot works on your own LinkedIn account. Log in once in a live browser view; you type your email, password and any security check yourself. It is needed again only if LinkedIn signs the session out.
      </p>
      {status?.linkedin.open && (
        <Note tone="danger" icon="pause">
          <strong>All LinkedIn work is paused</strong> so nothing keeps knocking on a locked door. Log in again to resume; queued runs then continue.
        </Note>
      )}
      <div>
        <Button variant={status?.session && !status.linkedin.open ? "secondary" : "primary"} icon="external" loading={busy} onClick={login}>
          {status?.session ? "Log in to LinkedIn again" : "Log in to LinkedIn"}
        </Button>
      </div>
      <p className="small muted">The login page opens in a new tab and works for 10 minutes. Email and password work; Google and Apple buttons may not.</p>
      {error && <Note tone="danger">{error}</Note>}
      <Note icon="shield">Everything linkedbot runs is read-only on LinkedIn: it can't post, connect or message. Viewing a profile is still visible to its owner.</Note>
    </section>
  );
}

const FEATURES = [
  { key: "agent", label: "Agent", hint: "Used by “Ask the agent”." },
  { key: "generator", label: "API generator", hint: "Used by “Generate an API”. Stronger models write better selectors." },
] as const;

function Claude() {
  const { data, error, loading, reload } = useAsync(api.claude, []);
  const [settings, setSettings] = useState<ClaudeSettings>();
  const [saveError, setSaveError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ClaudeTest>();
  const s = settings ?? data;
  const label = (id: string) => s?.models.find((m) => m.id === id)?.label ?? id;

  async function pick(feature: "agent" | "generator", value: string) {
    setSaveError(undefined);
    setTest(undefined);
    try {
      setSettings(await api.setClaudeModels({ [feature]: value || null }));
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Couldn't save the model.");
    }
  }
  async function runTest() {
    setTesting(true);
    setTest(undefined);
    try {
      setTest(await api.testClaude(s?.features.agent.model));
    } catch (e) {
      setTest({ ok: false, model: s?.features.agent.model ?? "", ms: 0, error: e instanceof ApiError ? e.message : "The test didn't run." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="stack" aria-labelledby="set-claude">
      <h2 id="set-claude">Claude</h2>
      {loading && !s && <Skeleton lines={2} />}
      {error && !s && (
        <Note tone="danger">
          Couldn't load the Claude settings. <Button size="small" variant="quiet" onClick={reload}>Try again</Button>
        </Note>
      )}
      {s && (
        <>
          <div className="row">
            <span className={`pill ${s.configured ? "ok" : "warn"}`}>
              <Icon name={s.configured ? "check" : "alert"} size={14} /> {s.configured ? "Enabled" : "Not set"}
            </span>
            {s.configured && (
              <span className="small muted">
                {s.keyHint && <code className="mono">{s.keyHint}</code>} from {s.source}
              </span>
            )}
          </div>
          <p className="muted prose">“Ask the agent” and “Generate an API” use the Claude API with a key kept on the server. The key never reaches this page.</p>
          {!s.configured && (
            <Note tone="warn">
              Set <code className="mono">ANTHROPIC_API_KEY</code> on the server: export it and run <code className="mono">scripts/deploy.sh secrets deploy</code>, or export it before <code className="mono">npm run serve</code> locally.
            </Note>
          )}
          {FEATURES.map((f) => {
            const cur = s.features[f.key];
            return (
              <Field key={f.key} label={f.label} hint={f.hint}>
                {(props) => (
                  <select {...props} className="input" value={cur.chosen ? cur.model : ""} onChange={(e) => pick(f.key, e.target.value)}>
                    <option value="">Default ({label(cur.default)})</option>
                    {s.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.price}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            );
          })}
          <p className="small muted">Prices are per million input / output tokens. A change applies from the next run.</p>
          {saveError && <Note tone="danger">{saveError}</Note>}
          <div className="row">
            <Button icon="play" loading={testing} disabled={!s.configured} onClick={runTest}>
              Test connection
            </Button>
            <span className="small muted">One tiny request to {label(s.features.agent.model)}, a few dozen tokens.</span>
          </div>
          {test && (
            <div aria-live="polite">
              {test.ok ? (
                <Note tone="ok">
                  Connected to {label(test.model)} in {(test.ms / 1000).toFixed(1)} s{test.tokens !== undefined && `, ${test.tokens} tokens`}.
                  {test.reply && <> It replied “{test.reply}”.</>}
                </Note>
              ) : (
                <Note tone="danger">{test.error}</Note>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ConnectClient() {
  const url = `${location.origin}/mcp`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the URL is selectable */
    }
  };
  return (
    <section className="stack" aria-labelledby="set-mcp">
      <h2 id="set-mcp">Connect an AI assistant</h2>
      <p className="muted prose">Your operations and tools are available to any MCP client at this address. They all use your four-word token.</p>
      <div className="row">
        <code className="mono input" style={{ flex: 1, display: "flex", alignItems: "center", overflowX: "auto", whiteSpace: "nowrap" }}>
          {url}
        </code>
        <Button icon={copied ? "check" : "copy"} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <h3>Claude and ChatGPT (web and apps)</h3>
      <p className="muted prose">Add a custom connector with the address above and no client id. A linkedbot sign-in page opens: type your four-word token and choose Allow.</p>
      <h3>Claude Code, Cursor, VS Code, Gemini CLI</h3>
      <p className="muted prose">Add the address with the header below, using your token.</p>
      <pre className="json">{`claude mcp add --transport http linkedbot ${url} \\\n  --header "Authorization: Bearer <your four-word token>"`}</pre>
    </section>
  );
}

function Appearance() {
  const [accent, setAccent] = useState(document.documentElement.dataset.accent ?? "terracotta");
  const pick = (key: string) => {
    setAccent(key);
    document.documentElement.dataset.accent = key;
    try {
      localStorage.setItem("accent", key);
    } catch {
      /* not remembered on this device */
    }
  };
  return (
    <section className="stack" aria-labelledby="set-look">
      <h2 id="set-look">Appearance</h2>
      <p className="muted">Accent colour on this device. Light and dark follow your system setting.</p>
      <div className="swatches" role="group" aria-label="Accent colour">
        {ACCENTS.map((a) => (
          <button key={a.key} type="button" className="swatch" aria-pressed={accent === a.key} onClick={() => pick(a.key)}>
            <i style={{ background: a.swatch }} />
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Account() {
  return (
    <section className="stack" aria-labelledby="set-acct">
      <h2 id="set-acct">This device</h2>
      <p className="muted prose">Signed in for 30 days. Replacing the token (scripts/deploy.sh token) signs out every device and every connected assistant.</p>
      <div>
        <Button variant="danger" onClick={() => api.signOut().finally(() => location.reload())}>
          Sign out
        </Button>
      </div>
    </section>
  );
}
