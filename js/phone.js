// The editor inside the Planetarium phone app (window.WALL_APP, set by the app's local server).
//
// On a phone the assistant is the main thing and editing is kept light: the page becomes one
// column with the preview on top and one panel at a time below it (assistant, layers, adjust).
// The 3D view, project files and the other desktop tools are left out; "export" adds the
// wallpaper to the app's library. Nothing here runs in a browser or in the desktop program.
(() => {
  'use strict';
  if (!window.WALL_APP) return;

  const t = window.WallI18n.t;
  const $ = (id) => document.getElementById(id);
  const workspace = document.querySelector('.workspace');
  const tabs = $('appTabs');

  document.documentElement.classList.add('app-mode');
  tabs.hidden = false;
  $('exportBtn').textContent = t`套用為桌布`;
  // Enter starts a new line here (see assistant.js), so the desktop hint about it does not apply.
  $('assistantInput').placeholder = t`描述想要的畫面…`;

  function show(tab) {
    workspace.dataset.tab = tab;
    for (const button of tabs.querySelectorAll('[data-tab]')) {
      const on = button.dataset.tab === tab;
      button.classList.toggle('primary', on);
      button.setAttribute('aria-selected', String(on));
    }
  }
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) show(button.dataset.tab);
  });
  // The assistant panel stays open underneath; the tabs decide whether it is on screen.
  window.spatialAssistant.setOpen(true);
  show('assistant');

  // Opened from a wallpaper in the library ("change with AI"): load that pack once the last
  // session's work has been restored, so the restore does not replace it.
  const packId = new URLSearchParams(location.search).get('pack');
  if (packId) {
    window.spatialEditor.restored
      .then(() => fetch(`/api/app/pack?id=${encodeURIComponent(packId)}`, { headers: { 'x-wall-editor': '1' } }))
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((bytes) => window.spatialEditor.loadPack(new Uint8Array(bytes)))
      .then(() => {
        // Reloading the page should not load the pack over later work.
        history.replaceState(null, '', location.pathname);
        show('assistant');
      })
      .catch((error) => window.alert(t`無法開啟這張桌布:${error.message}`));
  }
})();
