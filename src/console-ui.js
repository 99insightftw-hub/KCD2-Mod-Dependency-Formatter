'use strict';
(() => {
  const header = document.querySelector('.masthead');
  let headerOffset = 0;
  function measureHeader() {
    headerOffset = Math.ceil(header.getBoundingClientRect().height) + 12;
    document.documentElement.style.setProperty('--header-offset', headerOffset + 'px');
  }
  new ResizeObserver(measureHeader).observe(header);
  measureHeader();
  const tapes = [...document.querySelectorAll('.tape-top')];
  // Keep this explicitly requested, small app-local feedback independent of Windows window animations.
  const clickAnimations = new WeakMap();
  const scanStatus = document.getElementById('launch-status');
  const reflectScanning = () => header.classList.toggle('tapes-scanning', scanStatus?.getAttribute('aria-busy') === 'true');
  if (scanStatus) new MutationObserver(reflectScanning).observe(scanStatus, { attributes: true, attributeFilter: ['aria-busy'] });
  reflectScanning();

  for (const tape of document.querySelectorAll('.tape-top')) tape.addEventListener('click', event => {
    event.preventDefault();
    clickAnimations.get(tape)?.cancel();
    clickAnimations.set(tape, tape.animate([
      { transform: 'scale(1) rotate(0deg)' },
      { transform: 'scale(.94) rotate(-3deg)', offset: .3 },
      { transform: 'scale(1.025) rotate(2deg)', offset: .68 },
      { transform: 'scale(1) rotate(0deg)' }
    ], { duration: 280, easing: 'ease-out' }));
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  const buttons = [...document.querySelectorAll('.console-nav-button')];
  const sections = buttons.map(button => document.getElementById(button.dataset.section));
  function select(id) {
    for (const button of buttons) {
      if (button.dataset.section === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
  for (const button of buttons) button.addEventListener('click', () => {
    const section = document.getElementById(button.dataset.section);
    if (!section) return;
    select(section.id);
    section.scrollIntoView({ behavior: 'auto', block: 'start' });
    const heading = section.querySelector('h2');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  });
  let pending = false;
  window.addEventListener('scroll', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      let current = sections[0];
      for (const section of sections) if (section && section.getBoundingClientRect().top <= headerOffset + 20) current = section;
      if (scrollY + innerHeight >= document.documentElement.scrollHeight - 4) current = sections.at(-1);
      if (current) select(current.id);
    });
  }, { passive: true });
})();
