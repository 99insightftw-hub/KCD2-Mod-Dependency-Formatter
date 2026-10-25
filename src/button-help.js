'use strict';
(() => {
  const helpById = {
    'nav-game': 'Jump to choosing and checking your game folder.',
    'nav-plugins': 'Jump to dependency results and downloads.',
    'nav-fixes': 'Jump to the mod list preview, update and backups.',
    browse: 'Choose the folder where KCD2 is installed.',
    scan: 'Check installed files and load-order entries. Creates a missing mod_order.txt only when safe; never replaces an existing list. Vortex profile switches and Workshop activation are not verified.',
    detect: 'Look for KCD2 on this computer. You can choose which copy to use.',
    'browse-exe': 'Find KingdomCome.exe to select your game folder.',
    cancel: 'Ask the current task to stop safely. A file change may need to finish first.',
    'choose-download-folder': 'Choose the folder where you save plugin downloads.',
    'refresh-downloads': 'Look again for finished ZIP or 7z downloads in the chosen folder.',
    download: 'Choose a supported ZIP or 7z file to review. Nothing is installed yet.',
    'dependency-alert-choose': 'Choose a downloaded ZIP or 7z to review. Nothing is installed yet.',
    install: 'Install the files you reviewed. Saves a backup first. Close KCD2 before using it.',
    export: 'Save files arranged for manual installation in another folder. This is not a Vortex installer and does not install them in your game.',
    'export-vortex': 'Export packages for Vortex plus a required helper extension. Read INSTALL.txt before importing. This does not change Vortex or deploy files.',
    'install-vortex': 'Send this reviewed dependency to the connected Vortex profile. Vortex imports, enables and deploys it. Answer any conflicts or permissions in Vortex; this app does not bypass them.',
    'refresh-vortex': 'Check whether the Vortex helper is running with the intended game and profile. Does not install or deploy anything.',
    'export-vortex-helper': 'Save the helper extension ZIP for one-time installation in Vortex Extensions. Enable it and restart Vortex, then check the connection here.',
    preview: 'Show the full mod list, including folders that were left out before. Nothing changes yet.',
    undo: 'Undo the last change made since you opened this app. Stops if those files changed again.',
    apply: 'Save the reviewed mod list, creating mod_order.txt if needed. Saves a backup first. Close KCD2 before using it.',
    recover: 'Choose a saved backup record to undo an older change, even after restarting this app.',
    'launch-devmode': 'Start KCD2 with extra console commands enabled. Steam may ask you to confirm.'
  };
  const pairs = new WeakMap();
  const livePairs = new Set();
  const layer = document.createElement('div');
  layer.className = 'button-help-layer';
  document.body.append(layer);
  const topLayer = typeof HTMLElement.prototype.showPopover === 'function';
  let serial = 0, active = null, hideTimer = null;
  function explanation(button) {
    if (Object.hasOwn(helpById, button.id)) return helpById[button.id];
    if (button.closest('#choices')) return 'Use this game folder and check its setup.';
    const label = (window.i18n?.originalText(button) || button.textContent).trim();
    if (/GitHub release/i.test(label)) return 'Open the creator’s GitHub release page. Nothing is installed.';
    if (/Verify on author page/i.test(label)) return 'Open the creator’s page to compare versions. Nothing is installed.';
    if (/author page|^Download/i.test(label)) return 'Open the creator’s download page in your browser. Nothing is installed.';
    if (/^Review files$/i.test(label)) return 'Show the files and where they would go. Nothing is installed yet.';
    return button.dataset.help || 'Use “' + label + '” to continue with this action.';
  }
  function close() {
    clearTimeout(hideTimer);
    if (active) {
      if (topLayer && active.tip.matches(':popover-open')) active.tip.hidePopover();
      active.tip.hidden = true; active.help.setAttribute('aria-expanded', 'false');
    }
    active = null;
  }
  function position(pair) {
    const rect = pair.help.getBoundingClientRect(), margin = 12;
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    pair.tip.style.maxWidth = Math.max(1, Math.min(300, width - margin * 2)) + 'px';
    const box = pair.tip.getBoundingClientRect();
    pair.tip.style.left = Math.max(margin, Math.min(rect.left, width - box.width - margin)) + 'px';
    const below = rect.bottom + 8;
    pair.tip.style.top = (below + box.height <= height - margin ? below : Math.max(margin, rect.top - box.height - 8)) + 'px';
  }
  function show(pair) {
    clearTimeout(hideTimer);
    if (active !== pair) close();
    const text = window.i18n?.translate(explanation(pair.button)) || explanation(pair.button); if (pair.tip.textContent !== text) pair.tip.textContent = text;
    pair.tip.hidden = false;
    if (topLayer && !pair.tip.matches(':popover-open')) pair.tip.showPopover();
    pair.help.setAttribute('aria-expanded', 'true');
    active = pair;
    position(pair);
  }
  function later(pair) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (active === pair && document.activeElement !== pair.help && !pair.help.matches(':hover') && !pair.tip.matches(':hover')) close();
    }, 180);
  }
  function decorate(button) {
    let pair = pairs.get(button);
    if (!pair || button.parentNode !== pair.wrap) {
      const wrap = document.createElement('span'), help = document.createElement('span'), tip = document.createElement('span');
      wrap.className = 'button-help-pair';
      help.className = 'button-help'; help.textContent = '?'; help.tabIndex = 0;
      help.setAttribute('role', 'button'); help.setAttribute('aria-expanded', 'false');
      tip.className = 'button-help-tooltip'; tip.id = 'button-help-' + (++serial); tip.hidden = true; tip.setAttribute('role', 'tooltip');
      if (topLayer) tip.setAttribute('popover', 'manual');
      help.setAttribute('aria-describedby', tip.id);
      button.before(wrap); wrap.append(button, help); layer.append(tip);
      pair = { button, wrap, help, tip }; pairs.set(button, pair);
      livePairs.add(pair);
      help.addEventListener('pointerenter', () => show(pair));
      help.addEventListener('pointerleave', () => later(pair));
      help.addEventListener('focus', () => show(pair));
      help.addEventListener('blur', () => later(pair));
      tip.addEventListener('pointerenter', () => clearTimeout(hideTimer));
      tip.addEventListener('pointerleave', () => later(pair));
      help.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); show(pair); });
      help.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(pair); }
      });
    }
    if (!pair.tip.isConnected) layer.append(pair.tip);
    livePairs.add(pair);
    if (pair.wrap.hidden !== button.hidden) pair.wrap.hidden = button.hidden;
    const label = (window.i18n?.originalText(button) || button.textContent).trim();
    const helpLabel = 'Help for ' + (label || 'this button');
    const translatedLabel = window.i18n?.translate(helpLabel) || helpLabel;
    if (pair.help.getAttribute('aria-label') !== translatedLabel) pair.help.setAttribute('aria-label', translatedLabel);
    const text = window.i18n?.translate(explanation(button)) || explanation(button); if (pair.tip.textContent !== text) pair.tip.textContent = text;
  }
  function refresh() {
    if (!layer.isConnected) document.body.append(layer);
    for (const pair of livePairs) if (!pair.button.isConnected || pair.button.parentNode !== pair.wrap || !pair.help.isConnected) {
      if (active === pair) close();
      pair.tip.remove(); livePairs.delete(pair);
      if (pair.wrap.isConnected && pair.button.parentNode !== pair.wrap) pair.wrap.remove();
    }
    document.querySelectorAll('button').forEach(decorate);
    if (active && (!active.help.isConnected || !active.help.getClientRects().length)) close();
  }
  new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('pointerdown', event => { if (active && !active.wrap.contains(event.target) && !active.tip.contains(event.target)) close(); });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  window.addEventListener('languagechange', refresh);
  refresh();
})();
