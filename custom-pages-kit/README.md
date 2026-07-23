# DIM Custom Pages Kit

**Standalone** — zip this folder and share it. No other repo required.

```sh
npm install
npm start
```

Open **http://localhost:3333/page-preview.html?page=cursorArena&u=1**  
Second tab: **…&u=2** to test relay.

**Full guide:** [CUSTOM-PAGES.md](./CUSTOM-PAGES.md)

**Handoff:** copy your `public/custom-pages/<name>/` folder to the show machine's `public/custom-pages/` when ready.

## What's in the kit

| File | Purpose |
|---|---|
| `CUSTOM-PAGES.md` | Authoring guide (feed to your LLM) |
| `server.js` | Dev static file server |
| `preview-relay.js` | WebSocket relay for multi-tab preview |
| `public/page-preview.html` | Phone preview UI |
| `public/page-loader.js` | Loads your `page.js` files |
| `public/preview-mock.js` | Mock `DIM.*` APIs for preview |
| `public/pages.js` | Page render host |
| `public/custom-pages/` | **Your pages go here** |
