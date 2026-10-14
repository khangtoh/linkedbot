import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { CDPSession, Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";
import { saveSession } from "./vault.js";
import { acquire, lock } from "./browser.js";
import { resetBreaker } from "./limits.js";

const W = 1280, H = 800;
const LOGIN_URL = "https://www.linkedin.com/login";

export const LOGIN_PAGE = `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Log in to LinkedIn · linkedbot</title>
<style>
:root{color-scheme:light dark;--bg:oklch(97.8% .006 60);--surface:oklch(99.3% .004 60);--surface2:oklch(95.5% .009 60);--fg:oklch(25% .015 50);--mute:oklch(45% .015 50);--line:oklch(88.5% .01 60);--acc:oklch(56% .14 40);--on:oklch(98.5% .01 60);--ok:oklch(48% .11 150)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(18.5% .01 50);--surface:oklch(22% .012 50);--surface2:oklch(26% .014 50);--fg:oklch(94% .008 60);--mute:oklch(77% .012 60);--line:oklch(34% .014 50);--acc:oklch(72% .12 40);--on:oklch(20% .03 40);--ok:oklch(76% .11 150)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:1.0625rem;margin:0;flex:1;min-width:12rem}#st{color:var(--mute);font-size:.8125rem}
.view{overflow:auto;background:var(--surface2);max-width:1280px;margin:0 auto}
canvas{display:block;width:100%;touch-action:none;cursor:pointer}
.view.zoom canvas{width:200%;touch-action:pan-x pan-y}
.panel{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom));max-width:1280px;margin:0 auto}
label{display:block;font-weight:600;font-size:.875rem;margin-bottom:6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input{flex:1;min-width:0;font:inherit;font-size:16px;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button{font:inherit;font-size:.875rem;font-weight:600;min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:inherit;cursor:pointer}
button.pri{background:var(--acc);border-color:var(--acc);color:var(--on)}
.keys{margin-top:8px}.hint{color:var(--mute);font-size:.8125rem;margin:8px 0 0}
.done{padding:32px 16px;text-align:center}.done strong{color:var(--ok)}
</style>
<header><h1>Log in to LinkedIn</h1><span id=st aria-live=polite></span><button type=button id=zoom aria-pressed=false>Zoom</button></header>
<div class=view id=view><canvas id=c width=${W} height=${H} role=img aria-label="Live view of the LinkedIn login page. Tap a field to select it."></canvas></div>
<div class=panel>
<label for=kb>Type into the field you tapped</label>
<div class=row><input id=kb type=text autocapitalize=off autocorrect=off autocomplete=off spellcheck=false placeholder="Tap a field on the page, then type here"><button type=button id=mask aria-pressed=false aria-controls=kb>Hide</button></div>
<div class="row keys"><button type=button data-key=Backspace aria-label=Backspace>&#9003; Delete</button><button type=button data-key=Tab>Next field</button><button type=button data-key=Enter class=pri>Enter</button><button type=button id=clear>Clear field</button></div>
<p class=hint>What you type goes straight into LinkedIn and is not stored by linkedbot. On a computer you can also click the page and type on your keyboard.</p>
</div>
<script>
var c=document.getElementById('c'),g=c.getContext('2d'),kb=document.getElementById('kb'),st=document.getElementById('st'),view=document.getElementById('view');
var ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'+location.search);
ws.binaryType='blob';
function send(o){if(ws.readyState===1)ws.send(JSON.stringify(o))}
ws.onmessage=async function(e){
  if(typeof e.data==='string'){var m=JSON.parse(e.data);if(m.done){document.body.innerHTML='<div class=done><p><strong>Logged in.</strong> Your session is saved. You can close this tab.</p></div>'}if(m.status!==undefined)st.textContent=m.status;return}
  var bmp=await createImageBitmap(e.data);g.drawImage(bmp,0,0,c.width,c.height);bmp.close();if(st.textContent==='Connecting')st.textContent='';
};
ws.onopen=function(){st.textContent='Connecting'};
ws.onclose=function(){st.textContent='Disconnected. Reload the page to reconnect.'};
function pos(e){var r=c.getBoundingClientRect();return{x:(e.clientX-r.left)*c.width/r.width,y:(e.clientY-r.top)*c.height/r.height}}
// Tapping the page selects a field there; the typing box starts empty for that field.
var down=false;
c.addEventListener('pointerdown',function(e){down=true;send({t:'down',x:pos(e).x,y:pos(e).y});kb.value='';last=''});
c.addEventListener('pointermove',function(e){if(down&&e.buttons)send({t:'move',x:pos(e).x,y:pos(e).y})});
c.addEventListener('pointerup',function(e){if(!down)return;down=false;send({t:'up',x:pos(e).x,y:pos(e).y});if(matchMedia('(pointer: coarse)').matches)kb.focus({preventScroll:true});else c.focus()});
c.addEventListener('pointercancel',function(e){if(down){down=false;send({t:'up',x:pos(e).x,y:pos(e).y})}});
c.addEventListener('wheel',function(e){e.preventDefault();send({t:'wheel',dy:e.deltaY})},{passive:false});
c.tabIndex=0;
// The typing box: send only what changed, so phone keyboards that rewrite a word as you type work.
var last='';
function sync(){var v=kb.value,i=0;while(i<last.length&&i<v.length&&last[i]===v[i])i++;for(var j=i;j<last.length;j++)send({t:'key',key:'Backspace'});if(v.length>i)send({t:'text',text:v.slice(i)});last=v}
kb.addEventListener('input',sync);
kb.addEventListener('keydown',function(e){
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();send({t:'key',key:e.key});kb.value='';last=''}
  else if(e.key==='Backspace'&&kb.value===''){e.preventDefault();send({t:'key',key:'Backspace'})}
});
// On a computer: click the page, then type on the keyboard directly.
c.addEventListener('keydown',function(e){
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key.length===1){e.preventDefault();send({t:'text',text:e.key})}
  else if(['Backspace','Delete','Enter','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].indexOf(e.key)>=0){e.preventDefault();send({t:'key',key:(e.shiftKey&&e.key==='Tab')?'Shift+Tab':e.key})}
});
document.querySelectorAll('[data-key]').forEach(function(b){b.addEventListener('click',function(){send({t:'key',key:b.dataset.key});if(b.dataset.key!=='Backspace'){kb.value='';last=''}else if(kb.value){kb.value=kb.value.slice(0,-1);last=kb.value}})});
document.getElementById('clear').addEventListener('click',function(){send({t:'key',key:'ControlOrMeta+A'});send({t:'key',key:'Backspace'});kb.value='';last=''});
var mask=document.getElementById('mask');
mask.addEventListener('click',function(){var h=kb.type==='text';kb.type=h?'password':'text';mask.textContent=h?'Show':'Hide';mask.setAttribute('aria-pressed',String(h))});
var zoom=document.getElementById('zoom');
zoom.addEventListener('click',function(){var z=view.classList.toggle('zoom');zoom.setAttribute('aria-pressed',String(z));zoom.textContent=z?'Fit':'Zoom'});
</script>`;

// Returns at once with the WebSocket endpoint that will stream the login browser; the browser itself
// starts when the shared lease is free (login goes ahead of queued jobs, behind a running one).
// The caller owns the HTTP side (serving LOGIN_PAGE, authenticating the upgrade);
// `done` settles once the feed is reached and the session is saved, or on timeout.
export async function startLoginStream(): Promise<{ wss: WebSocketServer; done: Promise<void> }> {
  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  let page: Page | undefined;
  const status = (text: string) => { for (const ws of clients) if (ws.readyState === 1) ws.send(JSON.stringify({ status: text })); };

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Screencast only emits on visual change, so give a new client the current frame right away.
    if (page) page.screenshot({ type: "jpeg", quality: 60 }).then((b) => ws.readyState === 1 && ws.send(b)).catch(() => {});
    else {
      const holder = lock.state().holder;
      const busy = holder && holder.holder !== "login" ? `Waiting for the browser: ${holder.label} is using it.` : "Starting the browser.";
      ws.send(JSON.stringify({ status: busy }));
    }
    ws.on("close", () => clients.delete(ws));
    // Applied strictly in order: a backspace must land before the letters that replace it.
    ws.on("message", (raw) => void (inputs = inputs.then(() => handleInput(raw))));
  });

  // Keys the login page may press; text arrives separately as plain insertions.
  const KEYS = new Set(["Backspace", "Delete", "Enter", "Tab", "Shift+Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "ControlOrMeta+A"]);
  let inputs: Promise<void> = Promise.resolve();
  async function handleInput(raw: { toString(): string }): Promise<void> {
      if (!page) return;
      try {
        const m = JSON.parse(raw.toString());
        if (m.t === "down") { await page.mouse.move(m.x, m.y); await page.mouse.down(); }
        else if (m.t === "move") await page.mouse.move(m.x, m.y);
        else if (m.t === "up") { await page.mouse.move(m.x, m.y); await page.mouse.up(); }
        else if (m.t === "wheel") await page.mouse.wheel(0, Number(m.dy) || 0);
        else if (m.t === "text") await page.keyboard.insertText(String(m.text));
        else if (m.t === "key" && KEYS.has(String(m.key))) await page.keyboard.press(String(m.key));
      } catch { /* ignore malformed input / page navigating */ }
  }

  const done = (async () => {
    const lease = await acquire("login", "LinkedIn login", { viewport: { width: W, height: H } });
    try {
      const p = (page = await lease.newPage());
      status("");
      await p.goto(LOGIN_URL).catch(async (e) => {
        console.warn("Initial load failed:", e.message.split("\n")[0]);
        // Chromium's net-error page can't be screencast; show our own page with a retry link.
        await p.goto("about:blank").catch(() => {});
        await p.setContent(`<body style="font:16px system-ui;padding:40px"><h2>Could not reach LinkedIn</h2><p>Check this machine's network, then <a href="${LOGIN_URL}">retry</a>.</p>`).catch(() => {});
      });

      // (Re)attach the screencast; a cross-process navigation can detach the old CDP session.
      let cdp: CDPSession | undefined;
      const startCast = async () => {
        try {
          await cdp?.detach().catch(() => {});
          const c = (cdp = await lease.context.newCDPSession(p));
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
      p.on("framenavigated", (f) => { if (f === p.mainFrame()) void startCast(); });

      await p.waitForURL(/linkedin\.com\/feed/, { timeout: 10 * 60_000 });
      saveSession(await lease.context.storageState(), lease.userAgent);
      resetBreaker();
      for (const ws of clients) ws.send(JSON.stringify({ done: true }));
      console.log("Session saved to the encrypted vault.");
    } finally {
      await new Promise((r) => setTimeout(r, 500));
      for (const ws of clients) ws.close();
      wss.close();
      page = undefined;
      await lease.release();
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
