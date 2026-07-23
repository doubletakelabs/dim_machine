// Loads custom pages from /custom-pages/<name>/page.js
'use strict';

window.DIM_CUSTOM_PAGES = {};
const customPageLoads = new Map();
let pendingCustomPage = null;
let activeCustomPage = null;

window.DIM = window.DIM || {};
window.DIM.registerPage = function (nameOrFn, maybeFn) {
  const name = typeof nameOrFn === 'function' ? pendingCustomPage : nameOrFn;
  const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn;
  if (!name || typeof fn !== 'function') {
    console.warn('DIM.registerPage: expected (fn) or (name, fn)');
    return;
  }
  window.DIM_CUSTOM_PAGES[name] = fn;
};

/** Resolve assets co-located in the custom page folder. */
window.DIM.pageAsset = function (file) {
  if (!activeCustomPage) return file;
  return `/custom-pages/${encodeURIComponent(activeCustomPage)}/${file}`;
};

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

window.DIM_PAGE_LOADER = {
  has(name) {
    return !!window.DIM_CUSTOM_PAGES[name];
  },

  async load(name) {
    if (window.DIM_CUSTOM_PAGES[name]) return window.DIM_CUSTOM_PAGES[name];
    if (customPageLoads.has(name)) return customPageLoads.get(name);

    const promise = new Promise((resolve, reject) => {
      pendingCustomPage = name;
      const script = document.createElement('script');
      script.src = `/custom-pages/${encodeURIComponent(name)}/page.js`;
      script.onload = () => {
        pendingCustomPage = null;
        resolve(window.DIM_CUSTOM_PAGES[name] ?? null);
      };
      script.onerror = () => {
        pendingCustomPage = null;
        reject(new Error(`custom page not found: ${name}`));
      };
      document.head.appendChild(script);
    }).catch(() => null);

    customPageLoads.set(name, promise);
    return promise;
  },

  setActive(name) {
    activeCustomPage = name;
  },
};
