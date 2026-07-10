// Interactive page library (contract §6). Each renderer fills the stage and
// wires up the interactions that get promoted to canonical input events.
// window.DIM is provided by client.js: { emit(type, payload), vars }.
'use strict';

(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ${key} interpolation from the display-variable store, live-updated on setVar.
  const interp = (s) => String(s ?? '').replace(/\$\{([\w.]+)\}/g,
    (_, k) => window.DIM.vars[k] ?? '–');

  const renderers = {
    waiting: (el, p) => {
      el.innerHTML = `
        <div class="page-center">
          <div class="pulse"></div>
          <div class="page-title">${esc(interp(p.title ?? 'Please wait'))}</div>
          ${p.subtitle ? `<div class="page-sub">${esc(interp(p.subtitle))}</div>` : ''}
        </div>`;
    },

    blank: (el) => { el.innerHTML = ''; },

    text: (el, p) => {
      el.innerHTML = `
        <div class="page-center ${p.dismissible ? 'tappable' : ''}">
          ${p.title ? `<div class="page-title">${esc(interp(p.title))}</div>` : ''}
          ${p.body ? `<div class="page-body">${esc(interp(p.body))}</div>` : ''}
          ${(p.buttons ?? []).map((b) =>
            `<button class="page-btn" data-btn="${esc(b.id)}">${esc(interp(b.label))}</button>`).join('')}
          ${p.dismissible ? '<div class="page-hint">tap to continue</div>' : ''}
        </div>`;
      for (const btn of el.querySelectorAll('[data-btn]'))
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.DIM.emit(`button:${btn.dataset.btn}`);
        });
      if (p.dismissible)
        el.firstElementChild.addEventListener('click', () => window.DIM.emit('pageDismiss'));
    },

    prompt: (el, p) => {
      el.innerHTML = `
        <div class="page-center">
          ${p.title ? `<div class="page-title">${esc(interp(p.title))}</div>` : ''}
          ${p.question ? `<div class="page-body">${esc(interp(p.question))}</div>` : ''}
          <div class="choices">
            ${(p.choices ?? []).map((c) =>
              `<button class="page-btn choice" data-choice="${esc(c.id)}">${esc(interp(c.label))}</button>`).join('')}
          </div>
        </div>`;
      for (const btn of el.querySelectorAll('[data-choice]'))
        btn.addEventListener('click', () => window.DIM.emit(`choice:${btn.dataset.choice}`));
    },

    gestureSurface: (el, p) => {
      el.innerHTML = `
        <div class="gesture-area">
          ${p.hint ? `<div class="page-hint">${esc(interp(p.hint))}</div>` : ''}
          <div class="gesture-dot" style="display:none"></div>
        </div>`;
      const area = el.firstElementChild;
      const dot = area.querySelector('.gesture-dot');
      const wantSwipes = p.swipes !== false;
      const wantDrag = p.drag !== false;
      const wantTap = p.tap !== false;
      let start = null;

      const norm = (t) => {
        const r = area.getBoundingClientRect();
        return { x: (t.clientX - r.left) / r.width, y: (t.clientY - r.top) / r.height };
      };
      const pt = (e) => e.touches?.[0] ?? e.changedTouches?.[0] ?? e;

      area.addEventListener('pointerdown', (e) => {
        start = { ...norm(pt(e)), t: performance.now(), moved: false };
        try { area.setPointerCapture(e.pointerId); } catch {}
      });
      area.addEventListener('pointermove', (e) => {
        if (!start || !wantDrag) return;
        const c = norm(pt(e));
        if (Math.hypot(c.x - start.x, c.y - start.y) > 0.02) start.moved = true;
        // drag.move is PAGE-LOCAL (contract §3): update the dot, emit nothing
        if (start.moved) {
          dot.style.display = 'block';
          dot.style.left = `${c.x * 100}%`;
          dot.style.top = `${c.y * 100}%`;
        }
      });
      area.addEventListener('pointerup', (e) => {
        if (!start) return;
        const c = norm(pt(e));
        const dx = c.x - start.x, dy = c.y - start.y;
        const dist = Math.hypot(dx, dy);
        const dt = (performance.now() - start.t) / 1000;
        dot.style.display = 'none';
        if (dist > 0.15 && dt < 0.6 && wantSwipes) {
          const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
          window.DIM.emit(`swipe.${dir}`, { velocity: Math.round((dist / dt) * 100) / 100 });
        } else if (start.moved && wantDrag) {
          window.DIM.emit('drag.end', { x: Math.round(c.x * 1000) / 1000, y: Math.round(c.y * 1000) / 1000 });
        } else if (!start.moved && wantTap) {
          window.DIM.emit('tap', { x: Math.round(c.x * 1000) / 1000, y: Math.round(c.y * 1000) / 1000 });
        }
        start = null;
      });
    },

    audioPlayer: (el, p) => {
      el.innerHTML = `
        <div class="page-center">
          <div class="pulse playing"></div>
          ${p.title ? `<div class="page-title">${esc(interp(p.title))}</div>` : ''}
          ${p.subtitle ? `<div class="page-sub">${esc(interp(p.subtitle))}</div>` : ''}
        </div>`;
    },

    videoPlayer: (el, p) => {
      el.innerHTML = `
        <div class="page-center">
          ${p.hint ? `<div class="page-hint">${esc(interp(p.hint))}</div>` : ''}
        </div>`;
    },
  };

  window.DIM_PAGES = {
    render(el, page, props) {
      const fn = renderers[page] ?? renderers.waiting;
      fn(el, props ?? {});
    },
  };
})();
