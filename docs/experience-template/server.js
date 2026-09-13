#!/usr/bin/env node
/*
 * Reference room experience — the smallest thing that conforms.
 *
 * Not a piece. It is the wiring a piece needs, with the interesting parts left
 * as one-liners, so the shape of a conforming server is visible in one screen.
 * See docs/ROOM-EXPERIENCE.md for what each message means, and run
 * `node tools/verify-experience.mjs docs/experience-template` to watch it pass.
 *
 * The three things worth copying exactly:
 *
 *   1. `drivers` REPLACES the driver set. It is never a change to apply.
 *   2. `lifecycle` decides whether the piece is live. Never the socket count.
 *   3. Driver ids, hues and caps arrive from outside. Nothing here invents one.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'experience.json'), 'utf8'));

/**
 * Two paths an installation may override from outside (ROOM-EXPERIENCE.md §2):
 * a venue keeps large media on its own disk, and calibration belongs to the
 * machine and the building — it must survive this folder being redeployed.
 * Unset means the manifest path, exactly as before.
 */
const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.join(__dirname, MANIFEST.media?.dir ?? 'media');
const CALIBRATION = process.env.CALIBRATION_FILE
  ? path.resolve(process.env.CALIBRATION_FILE)
  : path.join(__dirname, MANIFEST.calibration?.file ?? 'calibration.json');

/**
 * Everything the show has told us. Replaced wholesale, never merged — which is
 * what makes this server restartable: the first message after a reconnect is
 * the entire truth, so there is no resync path to get wrong.
 */
const show = { lifecycle: 'attract', drivers: new Map() };

const displays = new Set();
const drivers = new Map();          // socket → driverId
let broker = null;                  // the show's socket, for the one message that travels up

// ------------------------------------------------------------------ http

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // Calibration lives in a file, never localStorage: a browser reset or a
  // different profile must not lose a projection mapping somebody hung a
  // projector for.
  if (url === '/calibration') {
    if (req.method === 'GET') {
      const body = fs.existsSync(CALIBRATION) ? fs.readFileSync(CALIBRATION, 'utf8') : '{}';
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      return req.on('end', () => {
        try {
          // CALIBRATION_FILE may name a directory that does not exist yet.
          fs.mkdirSync(path.dirname(CALIBRATION), { recursive: true });
          fs.writeFileSync(CALIBRATION, JSON.stringify(JSON.parse(body), null, 2));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(400);
          res.end(err.message);
        }
      });
    }
  }

  // Media may live outside this folder entirely (MEDIA_DIR) — a venue disk,
  // not the repo. Same traversal guard as the general route below.
  if (url.startsWith('/media/')) {
    const media = path.join(MEDIA_DIR, path.normalize(url.slice('/media'.length)).replace(/^(\.\.[/\\])+/, ''));
    if (!media.startsWith(MEDIA_DIR) || !fs.existsSync(media) || !fs.statSync(media).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(media).toLowerCase()] ?? 'application/octet-stream' });
    return fs.createReadStream(media).pipe(res);
  }

  const file = path.join(__dirname, path.normalize(url === '/' ? '/display.html' : url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// -------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server });
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const toDisplays = (obj) => { for (const d of displays) send(d, obj); };

wss.on('connection', (ws) => {
  let role = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'hello') {
      if (m.role === 'broker') {
        role = 'broker';
        broker = ws;
        return send(ws, {
          t: 'ready',
          experienceId: MANIFEST.experienceId,
          version: MANIFEST.version,
          maxDrivers: MANIFEST.maxDrivers,
          accepts: MANIFEST.inputs,
        });
      }
      if (m.role === 'display') {
        role = 'display';
        displays.add(ws);
        // A display that connects late is told everything, for the same reason we
        // are: arriving in the middle must not be a special case.
        send(ws, { t: 'lifecycle', state: show.lifecycle });
        return send(ws, { t: 'drivers', drivers: [...show.drivers.values()] });
      }
      // A driver. Only one the show authorised, and only with the secret the
      // show gave that driver's phone.
      const authorised = show.drivers.get(m.driverId);
      if (!authorised || authorised.secret !== m.secret) {
        send(ws, { t: 'denied', reason: 'unknown driver' });
        return ws.close();
      }
      role = 'driver';
      drivers.set(ws, m.driverId);
      toDisplays({ t: 'driverJoined', driverId: m.driverId });
      return send(ws, { t: 'claim', driverId: m.driverId, hue: authorised.hue });
    }

    if (role === 'broker') {
      if (m.t === 'lifecycle') {
        show.lifecycle = m.state;
        return toDisplays({ t: 'lifecycle', state: m.state });
      }
      // An event, not a state. Clear whatever the last guest built. Nothing is
      // re-sent on reconnect, and nothing needs to be: a piece that was down
      // through a reset came back with nothing to clear.
      if (m.t === 'reset') return toDisplays({ t: 'reset' });
      if (m.t === 'drivers') {
        // Replace. Never merge. A driver no longer in the set is no longer a
        // driver, whatever socket they still happen to be holding open.
        show.drivers = new Map((m.drivers ?? []).map((d) => [d.driverId, d]));
        for (const [sock, driverId] of drivers) {
          if (!show.drivers.has(driverId)) { drivers.delete(sock); sock.close(); }
        }
        return toDisplays({ t: 'drivers', drivers: [...show.drivers.values()] });
      }
      return;
    }

    if (role === 'display') {
      // The display is where the piece knows its run has ended. The server
      // just carries the word up the broker link — once, when it happens.
      // The show answers by bringing the room home; a `reset` follows.
      if (m.t === 'complete' && broker) return send(broker, { t: 'complete' });
      return;
    }

    if (role === 'driver') {
      const driverId = drivers.get(ws);
      // Ignore an intent this piece never declared — the phone should not be
      // sending it, and acting on it would make the manifest a lie.
      if (!driverId || !MANIFEST.inputs.includes(m.t)) return;
      return toDisplays({ ...m, driverId });
    }
  });

  ws.on('close', () => {
    if (ws === broker) broker = null;
    displays.delete(ws);
    const driverId = drivers.get(ws);
    if (driverId) {
      drivers.delete(ws);
      // Their slot is not ours to reassign. The show will re-cue the phone if
      // the guest is still in the room.
      toDisplays({ t: 'driverLeft', driverId });
    }
  });
});

server.listen(PORT, () => {
  console.log(`${MANIFEST.name} v${MANIFEST.version} — http://localhost:${PORT}/`);
  console.log(`  display  ${MANIFEST.entry.display}`);
  console.log(`  inputs   ${MANIFEST.inputs.join(', ')}`);
  console.log('  waiting for a broker (the show, or tools/experience-harness.mjs)');
});
