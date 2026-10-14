import { captureLogin } from "./login.js";
import { remoteLogin } from "./remoteLogin.js";
import { closeBrowser } from "./browser.js";
import { loadLeads, leadsToCsv } from "./leads.js";
import { listOps, runTopLevel, summarize } from "./ops/index.js";
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
  case "whoami":
    console.log(await runTopLevel("whoami", {}));
    break;
  case "search": {
    // npm run cli -- search "keywords" [pages]
    const pages = /^\d+$/.test(rest[rest.length - 1] ?? "") ? Number(rest.pop()) : 1;
    console.log(await runTopLevel("search_people", { keywords: rest.join(" "), pages }));
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
    console.log(await runTopLevel("agent", { task: rest.join(" ") }));
    break;
  case "ops":
    console.table(listOps({ drafts: true }).map(summarize).map(({ name, kind, status, description }) => ({ name, kind, status, description: description.slice(0, 60) })));
    break;
  case "generate": {
    // npm run cli -- generate "what you want" <example LinkedIn URL> [budget]
    const budget = /^\d+$/.test(rest[2] ?? "") ? Number(rest[2]) : undefined;
    console.log(JSON.stringify(await runTopLevel("generate_api", { description: rest[0], exampleUrl: rest[1], ...(budget ? { budget } : {}) }), null, 2));
    break;
  }
  case "run":
    // npm run cli -- run <operation> ['{"json":"input"}']
    console.log(JSON.stringify(await runTopLevel(rest[0], JSON.parse(rest[1] ?? "{}"), { allowDrafts: true }), null, 2));
    break;
  default:
    console.log("Usage: npm run cli -- <login [--remote] | whoami | search \"keywords\" [pages] | leads [out.csv] | agent \"task\" | ops | run <operation> [json] | generate \"description\" <url> [budget]>");
}

// The browser stays warm for back-to-back work in the server; a CLI run is over, so close it.
await closeBrowser();
