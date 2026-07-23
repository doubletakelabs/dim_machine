# Custom pages (show machine)

Drop-in folder for pages built in the **custom-pages-kit** (standalone dev environment).

```
custom-pages/
  myPage/
    page.js       ← required
    styles.css    ← optional
    …             ← assets
```

Referenced in show JSON: `{ "command": "showPage", "params": { "page": "myPage" } }`

List installed: `GET /api/custom-pages`

**Build & test locally:** use `custom-pages-kit/` — see `custom-pages-kit/CUSTOM-PAGES.md`.

Example (also in kit): **`cursorArena/`**
