// Copy this folder, rename it, and build your page.
// Folder name = page name referenced in the show (showPage params.page).

DIM.registerPage(function (el, props) {
  el.innerHTML = `
    <div class="page-center">
      <div class="page-title">${props.title ?? 'My page'}</div>
      <div class="page-body">${props.body ?? 'Edit page.js in your folder.'}</div>
      <button class="page-btn" id="go">Say hello</button>
    </div>`;

  const btn = el.querySelector('#go');
  const onClick = () => DIM.emit('button:hello');
  btn.addEventListener('click', onClick);

  return () => btn.removeEventListener('click', onClick);
});
