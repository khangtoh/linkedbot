import { captureLogin } from "./login.js";
import { openSession } from "./browser.js";
import { whoami } from "./actions/profile.js";
import { runAgent } from "./agent.js";

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "login":
    await captureLogin();
    break;
  case "whoami": {
    const s = await openSession();
    try { console.log(await whoami(s.page)); } finally { await s.close(); }
    break;
  }
  case "agent":
    await runAgent(rest.join(" "));
    break;
  default:
    console.log("Usage: npm run cli -- <login | whoami | agent \"task\">");
}
