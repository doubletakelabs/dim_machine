# Custom phone pages — authoring guide

Feed this file to your coding LLM when building interactive pages for **DIM Machine**.

This guide is **self-contained**. You do not need the full show runtime to build and test a page — only this dev kit folder.

---

## Quick start

**Requirements:** Node.js 18+

```sh
npm install
npm start              # → http://localhost:3333
```

Open in your browser:

```
http://localhost:3333/page-preview.html?page=cursorArena
```

Test multiplayer relay in **two tabs** — use different `u` values so each tab is a separate phone:

```
http://localhost:3333/page-preview.html?page=cursorArena&u=1
http://localhost:3333/page-preview.html?page=cursorArena&u=2
```

Tap in one tab — the other should show a cursor dot move. (Relay goes through the dev server's WebSocket, not BroadcastChannel.)

---

## What you're building

Custom pages run full-screen on audience phones during a live show. Each page is a folder with a `page.js` file that draws UI and handles touch.

The platform gives you two communication channels:

| API | Purpose |
|---|---|
| **`DIM.emit`** | Send **story inputs** to the show state machine (branch the narrative). In preview, these log to the browser console. |
| **`DIM.relay`** | Send **anything you want** to other phones in real time (shared cursors, drawing, voting, games). Preview simulates this across browser tabs. |

Use `emit` when the *show logic* needs to react. Use `relay` when phones need to sync with each other directly.

---

## Your page folder

Create a folder under **`public/custom-pages/`** in this kit:

```
public/custom-pages/
  myCoolPage/              ← folder name = page ID
    page.js                ← required
    styles.css             ← optional
    img/                   ← optional assets
      sprite.png
```

Copy **`public/custom-pages/_template/`** to get started.

### `page.js` shape

The folder name is your page ID. Register one renderer:

```javascript
DIM.registerPage(function (el, props) {
  // 1. Build UI inside el (full-screen div)
  el.innerHTML = '<div class="my-page">...</div>';

  // 2. Wire interactions
  el.querySelector('.board').addEventListener('pointerdown', (e) => {
    const pt = norm(el, e);
    DIM.relay.send('myChannel', pt);
    // DIM.emit('tap', pt);  // optional: advance the story
  });

  // 3. Listen for peer updates — update DOM incrementally, don't rebuild everything
  const off = DIM.relay.on('myChannel', (msg) => {
    if (msg.payload == null) return removePeer(msg.from.userId);
    updatePeer(msg.from, msg.payload);
  });

  // 4. Return cleanup when the page unmounts
  return () => off();
});
```

`props` is JSON passed from the show definition when the page is displayed. During preview, pass props in the URL:

```
?page=myCoolPage&props={"title":"Hello","level":3}
```

---

## Preview URL parameters

| Param | Example | Meaning |
|---|---|---|
| `page` | `cursorArena` | Folder name under `custom-pages/` |
| `u` | `1`, `2` | Simulated phone identity (for relay testing) |
| `props` | `{"title":"Hi"}` | JSON props passed to your renderer |

---

## Platform APIs

### Identity — `DIM.self`

```javascript
{ userId: "preview-u-1", label: "Phone 1", token: "preview-1" }
```

In a live show, `userId` / `label` come from the real phone session.

### Assets — `DIM.pageAsset('img/sprite.png')`

Returns a URL under your page folder:

```
/custom-pages/myCoolPage/img/sprite.png
```

```javascript
el.innerHTML = `<img src="${DIM.pageAsset('img/sprite.png')}" alt="">`;
```

### Styles — `styles.css`

Optional file next to `page.js`. Loaded automatically when your page mounts.

### Display variables — `DIM.vars`

In a live show, the author can push values via `setVar` (e.g. scores). In preview, set manually in the console: `DIM.vars['global.points'] = 5`.

### Story inputs — `DIM.emit(type, payload?)`

| Type | Payload |
|---|---|
| `tap` | `{ x, y }` normalized 0–1 |
| `button:<id>` | — |
| `choice:<id>` | — |
| `swipe.left` / `.right` / `.up` / `.down` | `{ velocity }` |
| `drag.end` | `{ x, y }` |
| `shake` | — |
| `pageDismiss` | — |

Custom event names work too. In preview, emitted events appear in the browser console as `[preview emit]`.

### Peer relay — `DIM.relay`

#### Send

```javascript
DIM.relay.send(channel, payload, { persist: true })
```

| | |
|---|---|
| `channel` | Any name you invent: `"cursor"`, `"draw"`, `"vote"`, `"game.state"` |
| `payload` | Any JSON value (~8 KB max). `null` = remove / peer left |
| `persist` | Default `true` — last value remembered per user (late joiners sync). `false` for fire-and-forget |

#### Receive

```javascript
const off = DIM.relay.on(channel, (msg) => {
  msg.from   // { userId, label, token }
  msg.payload
  msg.at     // timestamp ms
  msg.self   // true if you sent it
});
off(); // unsubscribe — call from your cleanup function
```

In preview, relay works across tabs in the same browser via BroadcastChannel. In a live show, relay goes through the show server to all phones in the same room.

---

## Normalized coordinates

Use **0–1** so layouts match across phone sizes:

```javascript
function norm(el, e) {
  const r = el.getBoundingClientRect();
  const t = e.touches?.[0] ?? e;
  return {
    x: Math.round(((t.clientX - r.left) / r.width) * 1000) / 1000,
    y: Math.round(((t.clientY - r.top) / r.height) * 1000) / 1000,
  };
}
```

---

## Example: shared cursors

See **`public/custom-pages/cursorArena/`** — tap sends `{ x, y }` on channel `"cursor"`, all tabs see each other's dots.

---

## Patterns

### Collaborative drawing

```javascript
DIM.relay.send('draw', { phase: 'move', x, y }, { persist: false });
```

### Live voting

```javascript
DIM.relay.send('vote', { choice: 'A' });
DIM.relay.on('vote', (msg) => { tally[msg.from.userId] = msg.payload.choice; });
```

### Hybrid relay + story

```javascript
DIM.relay.send('paint', { cells });  // peers see it live
DIM.emit('artworkComplete');         // state machine advances (live show only)
```

---

## Limits (live show)

| | |
|---|---|
| Payload size | ~8 KB JSON |
| Rate | ~40 msgs/sec per phone per channel |
| Channel name | `[a-zA-Z][a-zA-Z0-9._:-]{0,63}` |
| Relay audience | Everyone in the same room, or all phones if no room |

Preview has no rate limits.

---

## Handoff — adding your page to a live show

When your page is ready, copy **only your page folder** to the show machine:

```
your-page/   →   <show-machine>/public/custom-pages/your-page/
```

Include everything in the folder: `page.js`, `styles.css`, images, fonts, etc.

The show operator restarts the server (or re-loads the show). Your page is referenced in the show JSON by **folder name**:

```json
{
  "type": "output",
  "command": "showPage",
  "params": {
    "page": "myCoolPage",
    "props": { "title": "Hello", "level": 3 }
  }
}
```

You do **not** need to copy anything else from this kit — the show machine already has the runtime, page loader, and relay server.

---

## Checklist

- [ ] Folder lives in `public/custom-pages/<pageName>/`
- [ ] `page.js` calls `DIM.registerPage(function (el, props) { ... })`
- [ ] Cleanup returned if you use `DIM.relay.on` or `addEventListener`
- [ ] Handles `payload === null` (peer left)
- [ ] Tested in preview with two tabs (`&u=1` and `&u=2`)
- [ ] Page folder copied to show machine's `public/custom-pages/`

---

## Example LLM prompt

> I'm using the DIM Custom Pages kit (CUSTOM-PAGES.md). Create a page in folder `graffitiWall` under `public/custom-pages/`. Include `page.js` and `styles.css`. Full-screen dark canvas. On pointer drag, draw locally and relay `{ phase, x, y, color }` on channel `graffiti` with persist false. On pointer up relay `{ phase: 'end' }`. Listen on `graffiti` and draw other users' strokes. Random color per user in closure. Normalized coordinates. Return cleanup.

---

## Kit layout

```
custom-pages-kit/
  CUSTOM-PAGES.md          ← this file
  README.md
  package.json
  server.js
  preview-relay.js         ← platform (don't edit)
  public/
    page-preview.html      ← open this to test
    page-loader.js         ← platform (don't edit)
    preview-mock.js        ← platform (don't edit)
    pages.js               ← platform (don't edit)
    custom-pages/          ← your work goes here
      _template/
      cursorArena/         ← example
```
