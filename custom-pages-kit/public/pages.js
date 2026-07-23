// Custom page renderer — loads folders from public/custom-pages/
'use strict';

(() => {
  function loadCustomStyles(name) {
    const id = `dim-custom-css-${name}`;
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `/custom-pages/${encodeURIComponent(name)}/styles.css`;
    link.onerror = () => link.remove();
    document.head.appendChild(link);
  }

  function waiting(el, props) {
    el.innerHTML = `
      <div class="page-center">
        <div class="page-title">${props?.title ?? 'Page not found'}</div>
        <div class="page-body">${props?.body ?? 'No custom-pages/<name>/page.js for this ?page= value.'}</div>
      </div>`;
  }

  window.DIM_PAGES = {
    async render(el, page, props) {
      if (el._dimCleanup) {
        el._dimCleanup();
        el._dimCleanup = null;
      }
      const fn = await window.DIM_PAGE_LOADER?.load(page);
      if (fn) {
        window.DIM_PAGE_LOADER.setActive(page);
        loadCustomStyles(page);
        el._dimCleanup = fn(el, props ?? {}) ?? null;
        return;
      }
      window.DIM_PAGE_LOADER?.setActive(null);
      waiting(el, props);
    },
  };
})();
