#!/usr/bin/env node
/**
 * Stand in for the show, so a room experience can be built without one.
 *
 *   node tools/experience-harness.mjs ws://localhost:8080 [--port 7420]
 *
 * Connects to the experience **as a broker** — the same role, the same messages,
 * the same socket the show uses. Then serves a control page with lifecycle
 * buttons and driver slots, and a driver page to open on as many phones as you
 * like. Each phone connects **straight to the experience**, exactly as a real
 * handset does, with a driverId and secret this harness issued.
 *
 * The point is that there is no dev mode. The experience cannot tell whether the
 * broker is this or the show, so the path exercised on every refresh is the one
 * that ships.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const endpoint = args.find((a) => a.startsWith('ws://') || a.startsWith('wss://')) ?? 'ws://localhost:8080';
// Not 7000: macOS AirPlay Receiver holds it, and the failure is an EADDRINUSE
// stack trace that looks like the harness is broken.
const PORT = Number(args[args.indexOf('--port') + 1]) || 7420;
const HUES = [190, 28, 320, 95, 265, 55];

const state = { lifecycle: 'attract', drivers: [], remote: null, linked: false };
const panels = new Set();

const lanIP = () => Object.values(networkInterfaces()).flat()
  .find((i) => i?.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';

// ------------------------------------------------------------- broker link

let broker = null;
function connect() {
  broker = new WebSocket(endpoint);
  broker.on('open', () => {
    state.linked = true;
    broker.send(JSON.stringify({
      t: 'hello', role: 'broker', roomId: 'harness', experienceId: null, contract: 1,
    }));
    push();
    announce();
  });
  broker.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.t === 'ready') { state.remote = m; announce(); }
    } catch { /* not ours */ }
  });
  broker.on('close', () => {
    state.linked = false;
    state.remote = null;
    announce();
    setTimeout(connect, 1000);
  });
  broker.on('error', () => {});
}

/** Everything the experience should believe. Always the whole truth. */
function push() {
  if (broker?.readyState !== 1) return;
  broker.send(JSON.stringify({ t: 'lifecycle', state: state.lifecycle }));
  broker.send(JSON.stringify({ t: 'drivers', drivers: state.drivers }));
}

function announce() {
  const message = JSON.stringify({
    t: 'harness',
    linked: state.linked,
    remote: state.remote,
    lifecycle: state.lifecycle,
    drivers: state.drivers,
    endpoint,
  });
  for (const p of panels) { if (p.readyState === 1) p.send(message); }
}

function addDriver() {
  const cap = state.remote?.maxDrivers ?? HUES.length;
  if (state.drivers.length >= cap) return;
  const taken = new Set(state.drivers.map((d) => d.hue));
  state.drivers.push({
    driverId: `d-${randomUUID().slice(0, 8)}`,
    hue: HUES.find((h) => !taken.has(h)) ?? HUES[state.drivers.length % HUES.length],
    secret: randomUUID(),
  });
  push();
  announce();
}

// ---------------------------------------------------------------- pages

const PANEL = (ip) => `<!doctype html><meta charset="utf-8"><title>Experience harness</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{margin:0;background:#0b0b10;color:#e7e9ee;font:14px/1.6 ui-monospace,Menlo,monospace;padding:24px}
 h1{font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:#8888a0;margin:0 0 16px}
 button{background:#1d1d28;color:#e7e9ee;border:1px solid #2a2a38;border-radius:6px;
   padding:8px 14px;font:inherit;cursor:pointer;margin:0 6px 6px 0}
 button.on{background:#2e6fdb;border-color:#2e6fdb}
 .card{border:1px solid #1d1d28;border-radius:10px;padding:16px;margin-bottom:16px;max-width:640px}
 .chip{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;margin-right:6px}
 code{background:#14141f;padding:2px 6px;border-radius:4px}
 .muted{color:#8888a0}
 a{color:#7fb3ff}
</style>
<h1>Experience harness</h1>
<div class="card">
  <div id="link" class="muted">connecting…</div>
  <div class="muted">broker → <code>${endpoint}</code></div>
</div>
<div class="card">
  <div class="muted" style="margin-bottom:8px">Lifecycle</div>
  <div id="life"></div>
  <p class="muted" style="margin:10px 0 0;font-size:12px">
    Attract must come from here, not from the socket count — a guest can stand in
    the room without driving.
  </p>
  <hr style="border:0;border-top:1px solid #1d1d28;margin:14px 0">
  <button id="reset">send reset</button>
  <p class="muted" style="margin:6px 0 0;font-size:12px">
    An event, not a state. The piece should clear what the last guest built —
    and should <em>not</em> clear it merely for going to <code>settling</code>,
    because they may walk back in.
  </p>
</div>
<div class="card">
  <div class="muted" style="margin-bottom:8px">Drivers</div>
  <div id="drivers"></div>
  <button id="add">+ add driver</button>
  <button id="clear">remove all</button>
  <p class="muted" style="margin:10px 0 0;font-size:12px">
    Open <a href="/drive">http://${ip}:${PORT}/drive</a> on a phone — one tab or
    browser per driver. Each connects straight to the experience.
  </p>
</div>
<script>
const $=(i)=>document.getElementById(i);
const ws=new WebSocket('ws://'+location.host);
ws.onopen=()=>ws.send(JSON.stringify({t:'panel'}));
let s={};
ws.onmessage=(e)=>{s=JSON.parse(e.data);render();};
const LIFE=['attract','live','settling'];
function render(){
  $('link').innerHTML = s.linked
    ? '<span style="color:#58c98a">linked</span> — '+(s.remote
        ? s.remote.experienceId+' v'+s.remote.version+' · max '+s.remote.maxDrivers+' · accepts '+(s.remote.accepts||[]).join(', ')
        : '<span class="muted">no <code>ready</code> yet — the experience should answer the broker hello</span>')
    : '<span style="color:#e0705a">not connected</span> — is the experience running?';
  $('life').innerHTML = LIFE.map((l)=>'<button data-l="'+l+'"'+(s.lifecycle===l?' class="on"':'')+'>'+l+'</button>').join('');
  for (const b of $('life').querySelectorAll('[data-l]'))
    b.onclick=()=>ws.send(JSON.stringify({t:'lifecycle',state:b.dataset.l}));
  $('drivers').innerHTML = (s.drivers||[]).length
    ? s.drivers.map((d)=>'<span class="chip" style="background:hsl('+d.hue+' 60% 30%)">'+d.driverId+'</span>').join('')
    : '<span class="muted">none — the experience should be in attract</span>';
}
$('reset').onclick=()=>ws.send(JSON.stringify({t:'reset'}));
$('add').onclick=()=>ws.send(JSON.stringify({t:'addDriver'}));
$('clear').onclick=()=>ws.send(JSON.stringify({t:'clearDrivers'}));
</script>`;

const DRIVER = `<!doctype html><meta charset="utf-8"><title>Driver</title>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<style>
 html,body{margin:0;height:100%;background:#0b0b10;color:#e7e9ee;overscroll-behavior:none;
   touch-action:none;font:13px/1.5 ui-monospace,Menlo,monospace;-webkit-user-select:none;user-select:none}
 #pad{position:fixed;inset:0;display:grid;place-items:center}
 #id{opacity:.5;text-align:center}
 #log{position:fixed;bottom:12px;left:12px;right:12px;opacity:.45;font-size:11px;text-align:center}
</style>
<div id="pad"><div id="id">connecting…</div></div>
<div id="log"></div>
<script>
// The same recogniser the show's phone client uses: intent leaves here, physics
// stays on the wall. Deltas are fractions of THIS screen, so device size drops out.
const $=(i)=>document.getElementById(i);
const SWIPE_MIN=60, SWIPE_MAX_MS=900, TAP_MAX_PX=20, HOLD_MS=400;
let exp=null, me=null;

fetch('/claim').then(r=>r.json()).then((c)=>{
  if(!c.driverId){ $('id').textContent='no free driver slot — add one in the harness'; return; }
  me=c;
  document.body.style.background='hsl('+c.hue+' 45% 12%)';
  $('id').textContent=c.driverId;
  let opened=false;
  $('log').textContent='connecting to '+c.endpoint;
  exp=new WebSocket(c.endpoint);
  exp.onopen=()=>{opened=true;$('log').textContent='';
    exp.send(JSON.stringify({t:'hello',role:'driver',driverId:c.driverId,secret:c.secret}));};
  exp.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.t==='denied') $('id').textContent='denied: '+m.reason;};
  // "Never opened" and "opened then dropped" are different faults and used to
  // read the same. The first is almost always an address this phone cannot
  // reach; the second is the experience closing the socket.
  exp.onclose=()=>{
    $('id').textContent = opened ? 'disconnected' : 'could not reach the experience';
    $('log').textContent = opened ? '' : c.endpoint+' — is that address reachable from this phone?';
  };
});
const send=(o)=>{ if(exp&&exp.readyState===1){exp.send(JSON.stringify(o)); $('log').textContent=JSON.stringify(o);} };

let start=null,last=null,held=false,holdTimer=null,queued=false,acc={dx:0,dy:0};
const pad=$('pad');
pad.addEventListener('pointerdown',(e)=>{
  pad.setPointerCapture(e.pointerId);
  start=last={x:e.clientX,y:e.clientY,at:Date.now()};
  holdTimer=setTimeout(()=>{held=true;send({t:'hold',on:true});},HOLD_MS);
});
pad.addEventListener('pointermove',(e)=>{
  if(!start) return;
  const now=Date.now();
  acc.dx+=e.clientX-last.x; acc.dy+=e.clientY-last.y;
  if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>TAP_MAX_PX&&holdTimer){clearTimeout(holdTimer);holdTimer=null;}
  last={x:e.clientX,y:e.clientY,at:now};
  if(queued) return; queued=true;
  requestAnimationFrame(()=>{queued=false;
    if(!acc.dx&&!acc.dy) return;
    send({t:'drag',dx:acc.dx/innerWidth,dy:acc.dy/innerHeight}); acc={dx:0,dy:0};});
});
function end(e){
  if(!start) return;
  clearTimeout(holdTimer); holdTimer=null;
  const dx=e.clientX-start.x, dy=e.clientY-start.y, ms=Date.now()-start.at;
  const dist=Math.hypot(dx,dy);
  if(held){held=false;send({t:'hold',on:false});}
  else if(dist<=TAP_MAX_PX) send({t:'tap'});
  else {
    const dt=Math.max(1,Date.now()-last.at);
    const still=dt>120;
    send({t:'release',vx:still?0:(dx/innerWidth)/(ms/1000),vy:still?0:(dy/innerHeight)/(ms/1000)});
    if(dist>=SWIPE_MIN&&ms<=SWIPE_MAX_MS){
      const h=Math.abs(dx)>=Math.abs(dy);
      send({t:'swipe',direction:h?(dx>0?'right':'left'):(dy>0?'down':'up'),
            dx:dx/innerWidth,dy:dy/innerHeight});
    }
  }
  start=null;
}
pad.addEventListener('pointerup',end);
pad.addEventListener('pointercancel',end);
for(const ev of ['touchmove','gesturestart','contextmenu','dblclick'])
  document.addEventListener(ev,(e)=>e.preventDefault(),{passive:false});
</script>`;

// --------------------------------------------------------------- serving

/**
 * The experience endpoint, as an address the *requester* can actually reach.
 *
 * The endpoint on the command line is written from this machine's point of
 * view, and `ws://localhost:8080` means the phone itself once the page is on a
 * phone. Whatever host it used to reach the harness is by definition reachable
 * from where it is standing, so borrow that and keep the experience's port.
 */
function reachableFrom(req) {
  const url = new URL(endpoint);
  if (!/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(url.hostname)) return endpoint;
  const host = (req.headers.host ?? '').split(':')[0];
  if (!host || /^(localhost|127\.)/.test(host)) return endpoint;
  url.hostname = host;
  return url.toString().replace(/\/$/, '');
}

let claimIndex = 0;
const http = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/drive') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(DRIVER);
  }
  if (url === '/claim') {
    // Hand out slots round-robin so a second phone gets a second driver rather
    // than fighting the first for one.
    const driver = state.drivers[claimIndex++ % Math.max(1, state.drivers.length)];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(driver ? { ...driver, endpoint: reachableFrom(req) } : {}));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PANEL(lanIP()));
});

new WebSocketServer({ server: http }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'panel') { panels.add(ws); return announce(); }
    if (m.t === 'lifecycle') { state.lifecycle = m.state; push(); return announce(); }
    // Fired once, never reconciled — exactly as the show sends it.
    if (m.t === 'reset') { return broker?.readyState === 1 && broker.send(JSON.stringify({ t: 'reset' })); }
    if (m.t === 'addDriver') return addDriver();
    if (m.t === 'clearDrivers') { state.drivers = []; push(); return announce(); }
  });
  ws.on('close', () => panels.delete(ws));
});

http.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  port ${PORT} is taken — try: node tools/experience-harness.mjs ${endpoint} --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

http.listen(PORT, () => {
  const ip = lanIP();
  console.log('');
  console.log('  EXPERIENCE HARNESS ──────────────────────────');
  console.log(`  broker →  ${endpoint}`);
  console.log(`  panel  →  http://${ip}:${PORT}/`);
  console.log(`  phones →  http://${ip}:${PORT}/drive`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
  connect();
});
