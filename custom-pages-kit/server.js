// Minimal static server + WebSocket relay for custom page development.
import express from 'express';
import { createServer } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachPreviewRelay } from './preview-relay.js';

const PORT = process.env.PORT || 3333;
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const customPagesDir = join(publicDir, 'custom-pages');

const app = express();
app.use(express.static(publicDir));

app.get('/api/custom-pages', (_req, res) => {
  try {
    res.json(
      readdirSync(customPagesDir)
        .filter((name) => !name.startsWith('_'))
        .filter((name) => existsSync(join(customPagesDir, name, 'page.js')))
        .sort(),
    );
  } catch {
    res.json([]);
  }
});

const httpServer = createServer(app);
attachPreviewRelay(httpServer);

httpServer.listen(PORT, () => {
  console.log('DIM Custom Pages — dev server');
  console.log(`  preview:  http://localhost:${PORT}/page-preview.html?page=cursorArena&u=1`);
  console.log(`  tab two:  http://localhost:${PORT}/page-preview.html?page=cursorArena&u=2`);
});
