// Turns a run's raw error into what the owner needs: a plain title, what happened, and the one
// action that fixes it. The raw message stays available under "Details".
export type Explained = { title: string; detail: string; action?: { label: string; to?: string; retry?: boolean } };

export function explainError(raw: string | undefined): Explained {
  const msg = raw ?? "";
  if (/No saved LinkedIn session|Log in to LinkedIn first/i.test(msg))
    return { title: "LinkedIn isn't logged in", detail: "linkedbot needs your LinkedIn session to do this. Log in once and run it again.", action: { label: "Log in to LinkedIn", to: "/settings" } };
  if (/paused|Session needs attention|authwall|checkpoint|logged this session out/i.test(msg))
    return { title: "LinkedIn asked to log in again", detail: "All LinkedIn work is paused so nothing keeps knocking on a locked door. Log in again and queued runs continue by themselves.", action: { label: "Log in to LinkedIn", to: "/settings" } };
  if (/Daily cap reached|Would exceed today's cap/i.test(msg))
    return { title: "Today's limit is used up", detail: `${msg.replace(/\.$/, "")}. Daily caps keep your account safe and reset at midnight UTC.` };
  if (/Interrupted by a restart/i.test(msg))
    return { title: "Interrupted", detail: "The server restarted while this was running. Nothing was lost; run it again.", action: { label: "Run again", retry: true } };
  if (/ANTHROPIC_API_KEY|api[_ -]?key|authentication_error|x-api-key|401 .*anthropic/i.test(msg))
    return { title: "The Claude API key is missing or wrong", detail: "This uses Claude. Set ANTHROPIC_API_KEY on the server (scripts/deploy.sh secrets) and try again." };
  if (/timed? ?out|Timeout|net::ERR|ERR_/i.test(msg))
    return { title: "LinkedIn took too long to answer", detail: "It may be slow right now. Try again in a few minutes.", action: { label: "Try again", retry: true } };
  if (/must be|must have|needs "|is required|invalid|Unknown operation/i.test(msg))
    return { title: "Check the input", detail: msg };
  return { title: "Something went wrong", detail: msg || "The run failed without a message." };
}
