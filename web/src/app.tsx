import { useEffect, useState } from "react";
import { api, signedOut } from "./api";
import { Icon, type IconName } from "./icons";
import { Link, navigate, usePath } from "./router";
import { RunningPill, StatusPill, StatusProvider, Toaster, useStatus } from "./ui";
import { SignIn } from "./screens/SignIn";
import { Library } from "./screens/Library";
import { Builder } from "./screens/Builder";
import { Activity } from "./screens/Activity";
import { Settings } from "./screens/Settings";
import { Generate } from "./screens/Generate";

const NAV: { to: string; label: string; icon: IconName; match: (p: string) => boolean }[] = [
  { to: "/", label: "Library", icon: "library", match: (p) => p === "/" || p.startsWith("/ops") },
  { to: "/build", label: "Build", icon: "build", match: (p) => p.startsWith("/build") },
  { to: "/generate", label: "Generate", icon: "sparkle", match: (p) => p.startsWith("/generate") },
  { to: "/activity", label: "Activity", icon: "activity", match: (p) => p.startsWith("/activity") },
  { to: "/settings", label: "Settings", icon: "settings", match: (p) => p.startsWith("/settings") },
];

export function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  useEffect(() => {
    api.session().then((s) => setAuth(s.signedIn ? "in" : "out"), () => setAuth("out"));
    const out = () => setAuth("out");
    signedOut.addEventListener("signedout", out);
    return () => signedOut.removeEventListener("signedout", out);
  }, []);
  if (auth === "checking") return <div className="signin" aria-busy="true" />;
  if (auth === "out") return <SignIn onSignedIn={() => setAuth("in")} />;
  return (
    <StatusProvider>
      <Shell />
    </StatusProvider>
  );
}

function Shell() {
  const path = usePath();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="linkedbot studio, Library">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="var(--accent)" />
            <path d="M10 9v14h12" stroke="var(--on-accent)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="brand-word">studio</span>
        </Link>
        <span className="spacer" />
        <RunningPill />
        <Loads />
        <StatusPill onClick={() => navigate("/settings")} />
      </header>
      <nav className="tabs" aria-label="Studio">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} aria-current={n.match(path) ? "page" : undefined}>
            <Icon name={n.icon} size={22} />
            {n.label}
          </Link>
        ))}
      </nav>
      <main className="main" id="main">
        <Route path={path} />
      </main>
      <Toaster />
    </div>
  );
}

// Today's LinkedIn page loads left, always in view: spend is never a surprise.
function Loads() {
  const { status } = useStatus();
  if (!status) return null;
  const { view_profile, search } = status.capsLeft;
  return (
    <span className="loads num" title="LinkedIn page loads left today">
      <span className="visually-hidden">Left today: </span>
      {view_profile} views · {search} searches
    </span>
  );
}

function Route({ path }: { path: string }) {
  const tool = /^\/build\/([a-z][a-z0-9_]*)$/.exec(path);
  if (path === "/" || path.startsWith("/ops")) return <Library />;
  if (path === "/build") return <Builder key="new" />;
  if (tool) return <Builder key={tool[1]} name={tool[1]} />;
  if (path.startsWith("/generate")) return <Generate />;
  if (path.startsWith("/activity")) return <Activity />;
  if (path.startsWith("/settings")) return <Settings />;
  return <Library />;
}
