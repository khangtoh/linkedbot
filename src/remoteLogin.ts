import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chromium, type CDPSession } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";
import { saveSession } from "./vault.js";
import { normalUserAgent } from "./ua.js";

const W = 1280, H = 800;
const LOGIN_URL = "https://www.linkedin.com/login";

export const LOGIN_PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>linkedbot login</title>
<style>body{margin:0;background:#111;color:#ddd;font:14px system-ui}#bar{padding:8px 12px}
canvas{width:100%;display:block;background:#222;touch-action:none}
#kb{position:fixed;opacity:0;left:0;top:0;width:1px;height:1px}</style>
<div id=bar>Log in below (tap a field to type). This page closes itself when you reach the feed. <span id=st></span></div>
<canvas id=c width=${W} height=${H}></canvas><textarea id=kb autocapitalize=off autocorrect=off spellcheck=false></textarea>
<script>
const c=document.getElementById('c'),g=c.getContext('2d'),kb=document.getElementById('kb'),st=document.getElementById('st');
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'+location.search);
ws.binaryType='blob';
const send=o=>ws.readyState===1&&ws.send(JSON.stringify(o));
ws.onmessage=async e=>{
  if(typeof e.data==='string'){const m=JSON.parse(e.data);if(m.done){document.body.innerHTML='<p style="padding:20px">Logged in. Session saved. You can close this tab.</p>'}return}
  const bmp=await createImageBitmap(e.data);g.drawImage(bmp,0,0,c.width,c.height);bmp.close();
};
ws.onclose=()=>st.textContent=' (disconnected)';
const pos=e=>{const r=c.getBoundingClientRect();return{x:(e.clientX-r.left)*c.width/r.width,y:(e.clientY-r.top)*c.height/r.height}};
c.addEventListener('pointerdown',e=>{c.setPointerCapture(e.pointerId);send({t:'down',...pos(e)});kb.focus()});
c.addEventListener('pointermove',e=>{if(e.buttons)send({t:'move',...pos(e)})});
c.addEventListener('pointerup',e=>send({t:'up',...pos(e)}));
c.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',dy:e.deltaY})},{passive:false});
kb.addEventListener('input',e=>{
  if(e.inputType==='deleteContentBackward')send({t:'key',key:'Backspace'});
  else if(e.data)send({t:'text',text:e.data});
  kb.value='';
});
kb.addEventListener('keydown',e=>{
  if(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete'].includes(e.key)){e.preventDefault();send({t:'key',key:e.key})}
  else if(e.key==='Backspace'&&!kb.value){e.preventDefault();send({t:'key',key:'Backspace'})}
});
</script>`;

// Launches the headless browser and returns the WebSocket endpoint that streams it.
// The caller owns the HTTP side (serving LOGIN_PAGE, authenticating the upgrade);
// `done` settles once the feed is reached and the session is saved, or on timeout.
export async function startLoginStream(): Promise<{ wss: WebSocketServer; done: Promise<void> }> {
  const browser = await chromium.launch({ headless: true });
  const userAgent = normalUserAgent(browser);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, userAgent, locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL).catch(async (e) => {
    console.warn("Initial load failed:", e.message.split("\n")[0]);
    // Chromium's net-error page can't be screencast; show our own page with a retry link.
    await page.goto("about:blank").catch(() => {});
    await page.setContent(`<body style="font:16px system-ui;padding:40px"><h2>Could not reach LinkedIn</h2><p>Check this machine's network, then <a href="${LOGIN_URL}">retry</a>.</p>`).catch(() => {});
  });
  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Screencast only emits on visual change, so give a new client the current frame right away.
    page.screenshot({ type: "jpeg", quality: 60 }).then((b) => ws.readyState === 1 && ws.send(b)).catch(() => {});
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.t === "down") { await page.mouse.move(m.x, m.y); await page.mouse.down(); }
        else if (m.t === "move") await page.mouse.move(m.x, m.y);
        else if (m.t === "up") { await page.mouse.move(m.x, m.y); await page.mouse.up(); }
        else if (m.t === "wheel") await page.mouse.wheel(0, Number(m.dy) || 0);
        else if (m.t === "text") await page.keyboard.insertText(String(m.text));
        else if (m.t === "key") await page.keyboard.press(String(m.key));
      } catch { /* ignore malformed input / page navigating */ }
    });
  });

  // (Re)attach the screencast; a cross-process navigation can detach the old CDP session.
  let cdp: CDPSession | undefined;
  const startCast = async () => {
    try {
      await cdp?.detach().catch(() => {});
      const c = (cdp = await ctx.newCDPSession(page));
      c.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
        const buf = Buffer.from(f.data, "base64");
        for (const ws of clients) if (ws.readyState === 1) ws.send(buf);
        c.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      });
      await c.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: W, maxHeight: H });
    } catch (e) {
      console.warn("screencast (re)start failed:", (e as Error).message.split("\n")[0]);
    }
  };
  await startCast();
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) void startCast(); });

  const done = (async () => {
    try {
      await page.waitForURL(/linkedin\.com\/feed/, { timeout: 10 * 60_000 });
      saveSession(await ctx.storageState(), userAgent);
      for (const ws of clients) ws.send(JSON.stringify({ done: true }));
      console.log("Session saved to the encrypted vault.");
    } finally {
      await new Promise((r) => setTimeout(r, 500));
      for (const ws of clients) ws.close();
      wss.close(); await browser.close();
    }
  })();
  return { wss, done };
}

export async function remoteLogin(opts: { host?: string; port?: number } = {}): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  const token = randomBytes(24).toString("hex");
  const { wss, done } = await startLoginStream();
  const ok = (url?: string) => new URL(url ?? "", "http://x").searchParams.get("t") === token;

  const server = createServer((req, res) => {
    if (!ok(req.url)) { res.writeHead(403).end("forbidden"); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(LOGIN_PAGE);
  });
  server.on("upgrade", (req, sock, head) => {
    if (!ok(req.url)) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws));
  });

  await new Promise<void>((r) => server.listen(port, host, r));
  console.log(`\nOpen this URL in any browser (phone works) and log in:\n  http://${host === "0.0.0.0" ? "<this-machine-ip>" : host}:${port}/?t=${token}\n`);
  console.log("Anything you type travels over this connection. Use localhost / an SSH tunnel / an HTTPS tunnel, not open Wi-Fi.\n");

  try { await done; } finally { server.close(); }
}
