// Shared cursor dots demo — see custom-pages-kit/CUSTOM-PAGES.md
DIM.registerPage(function (el, props) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CHANNEL = props.channel ?? 'cursor';
  el.innerHTML = `
    <div class="cursor-arena">
      ${props.title ? `<div class="cursor-arena-title">${esc(props.title)}</div>` : ''}
      ${props.hint ? `<div class="cursor-arena-hint">${esc(props.hint)}</div>` : ''}
      <div class="cursor-stage"></div>
    </div>`;

  const stage = el.querySelector('.cursor-stage');
  const dots = new Map();

  const upsert = (msg) => {
    const id = msg.from.userId;
    if (msg.payload == null) {
      dots.get(id)?.remove();
      dots.delete(id);
      return;
    }
    let dot = dots.get(id);
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'cursor-dot' + (msg.self ? ' self' : '');
      dot.textContent = msg.from.label.replace('Phone ', 'P');
      stage.appendChild(dot);
      dots.set(id, dot);
    }
    dot.style.left = `${msg.payload.x * 100}%`;
    dot.style.top = `${msg.payload.y * 100}%`;
    dot.className = 'cursor-dot' + (msg.self ? ' self' : '');
  };

  const offRelay = DIM.relay.on(CHANNEL, upsert);

  const norm = (e) => {
    const r = stage.getBoundingClientRect();
    const t = e.touches?.[0] ?? e;
    return {
      x: Math.round(((t.clientX - r.left) / r.width) * 1000) / 1000,
      y: Math.round(((t.clientY - r.top) / r.height) * 1000) / 1000,
    };
  };
  const onTap = (e) => DIM.relay.send(CHANNEL, norm(e));
  stage.addEventListener('pointerdown', onTap);

  return () => {
    offRelay();
    stage.removeEventListener('pointerdown', onTap);
  };
});
