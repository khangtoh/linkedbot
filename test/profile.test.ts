import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { listen, useTempDataDir } from "./helpers.js";

useTempDataDir();
const { whoami } = await import("../src/actions/profile.js");

// A profile page whose name is drawn by script a moment after load, the way LinkedIn does it,
// and one where the usual elements are missing so only the title and description remain.
const site = await listen((req, res) => {
  const late = `<title>(3) Ada Lovelace | LinkedIn</title><main id=m></main><script>setTimeout(()=>{document.getElementById('m').innerHTML='<h1>Ada Lovelace</h1><div class="text-body-medium">Head of Data</div>'},700)</script>`;
  const bare = `<title>Grace Hopper | LinkedIn</title><meta name="description" content="VP Engineering at Compilers Inc"><main><p>new layout</p></main>`;
  res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/bare" ? bare : late);
});
const browser = await chromium.launch();
after(async () => {
  await browser.close();
  await site.close();
});

// whoami goes to linkedin.com; send it to the local page instead.
async function run(path: string) {
  const page = await browser.newPage();
  await page.route("https://www.linkedin.com/in/me/", (r) => r.fulfill({ status: 302, headers: { location: `${site.base}${path}` } }));
  const out = await whoami(page);
  await page.close();
  return out;
}

test("whoami waits for a name drawn after load", async () => {
  const out = await run("/late");
  assert.equal(out.name, "Ada Lovelace");
  assert.equal(out.headline, "Head of Data");
});

test("whoami falls back to the title and description", async () => {
  const out = await run("/bare");
  assert.equal(out.name, "Grace Hopper");
  assert.equal(out.headline, "VP Engineering at Compilers Inc");
});
