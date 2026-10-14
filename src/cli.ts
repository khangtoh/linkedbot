import { captureLogin } from "./login.js";
import { remoteLogin } from "./remoteLogin.js";
import { openSession } from "./browser.js";
import { whoami } from "./actions/profile.js";
import { runAgent } from "./agent.js";
import { searchPeople } from "./actions/search.js";
import { loadLeads, leadsToCsv } from "./leads.js";
import { writeFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "login":
    // login            -> local headed browser
    // login --remote [--host 0.0.0.0] [--port 8787] -> browser streamed to any device
    if (rest.includes("--remote")) {
      const arg = (n: string) => rest[rest.indexOf(n) + 1];
      await remoteLogin({ host: rest.includes("--host") ? arg("--host") : undefined, port: rest.includes("--port") ? Number(arg("--port")) : undefined });
    } else await captureLogin();
    break;
  case "whoami": {
    const s = await openSession();
    try { console.log(await whoami(s.page)); } finally { await s.close(); }
    break;
  }
  case "search": {
    // npm run cli -- search "keywords" [pages]
    const pages = /^\d+$/.test(rest[rest.length - 1] ?? "") ? Number(rest.pop()) : 1;
    const s = await openSession();
    try { console.log(await searchPeople(s.page, { keywords: rest.join(" "), pages })); } finally { await s.close(); }
    break;
  }
  case "leads": {
    // npm run cli -- leads [out.csv]
    const leads = loadLeads();
    if (rest[0]) { writeFileSync(rest[0], leadsToCsv(leads)); console.log(`Wrote ${leads.length} leads to ${rest[0]}`); }
    else console.table(leads.map(({ name, headline, location }) => ({ name, headline, location })));
    break;
  }
  case "agent":
    console.log(await runAgent(rest.join(" ")));
    break;
  default:
    console.log("Usage: npm run cli -- <login [--remote] | whoami | search \"keywords\" [pages] | leads [out.csv] | agent \"task\">");
}
