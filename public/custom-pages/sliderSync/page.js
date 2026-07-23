// Fifteen shared sliders — changes relay to every phone in the room.
DIM.registerPage(function (el, props) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COUNT = 15;
  const CHANNEL = 'sliders';

  el.innerHTML = `
    <div class="slider-sync">
      ${props.title ? `<div class="slider-sync-title">${esc(props.title)}</div>` : ''}
      <div class="slider-sync-hint">${esc(props.hint ?? 'Move any slider — everyone sees it live.')}</div>
      <div class="slider-list"></div>
    </div>`;

  const list = el.querySelector('.slider-list');
  const sliders = [];
  const latestAt = new Array(COUNT).fill(0);
  let syncing = false;

  const rows = Array.from({ length: COUNT }, (_, i) => {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
      <label class="slider-label" for="slider-${i}">Slider ${i + 1}</label>
      <input class="slider-input" id="slider-${i}" type="range" min="0" max="100" value="50" />
      <span class="slider-value">50</span>`;
    list.appendChild(row);
    const input = row.querySelector('.slider-input');
    const valueEl = row.querySelector('.slider-value');
    sliders.push(input);
    return { input, valueEl };
  });

  const setSlider = (index, value, at = Date.now()) => {
    if (index < 0 || index >= COUNT) return;
    if (at < latestAt[index]) return;
    latestAt[index] = at;

    syncing = true;
    sliders[index].value = value;
    rows[index].valueEl.textContent = value;
    syncing = false;
  };

  const onInput = (index) => {
    if (syncing) return;
    const value = Number(sliders[index].value);
    rows[index].valueEl.textContent = value;
    latestAt[index] = Date.now();
    DIM.relay.send(CHANNEL, { index, value });
  };

  const onRelay = (msg) => {
    if (msg.payload == null) return;
    const { index, value } = msg.payload;
    if (typeof index !== 'number' || typeof value !== 'number') return;
    setSlider(index, value, msg.at ?? Date.now());
  };

  const offs = sliders.map((input, index) => {
    const handler = () => onInput(index);
    input.addEventListener('input', handler);
    return () => input.removeEventListener('input', handler);
  });

  const offRelay = DIM.relay.on(CHANNEL, onRelay);

  return () => {
    offRelay();
    offs.forEach((off) => off());
  };
});
