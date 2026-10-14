import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { Button, Field } from "../ui";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.signIn(token);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "Too many attempts. Try again in a minute." : err instanceof ApiError && err.status === 401 ? "That token doesn't match." : "Couldn't reach linkedbot. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form className="stack" style={{ "--gap": "20px" } as React.CSSProperties} onSubmit={submit}>
        <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
          <h1>linkedbot studio</h1>
          <p className="muted">Sign in with your four-word token.</p>
        </div>
        <Field label="Four-word token" error={error} hint="Spaces or hyphens between the words both work.">
          {(p) => (
            <div className="row" style={{ "--gap": "8px", flexWrap: "nowrap" } as React.CSSProperties}>
              <input {...p} className="input" type={shown ? "text" : "password"} autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
              <Button icon={shown ? "eyeOff" : "eye"} aria-controls={p.id} aria-pressed={shown} onClick={() => setShown(!shown)}>
                {shown ? "Hide" : "Show"}
              </Button>
            </div>
          )}
        </Field>
        <Button variant="primary" type="submit" loading={busy}>
          Sign in
        </Button>
        <p className="small muted">This device stays signed in for 30 days, or until the token is replaced.</p>
      </form>
    </main>
  );
}
