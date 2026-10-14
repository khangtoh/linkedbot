import { useState } from "react";
import { api, ApiError } from "../api";
import { Icon } from "../icons";
import { Button, linkedinState, Note, useStatus } from "../ui";

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
