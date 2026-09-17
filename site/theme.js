// Theme, applied before the first paint.
//
// Loaded from <head> without `defer` on purpose: a visitor who chose dark must
// not see a white page first. That costs one blocking request for a file this
// small, which is cheaper than the flash. It is also why this is not part of
// main.js, which runs at the end of the body.
//
// The palette itself is CSS. All this does is set `color-scheme` on the root,
// via a `data-theme` attribute, and remember the choice:
//
//   auto   no attribute — `color-scheme: light dark`, the OS decides
//   light  force the light sheet
//   dark   force the dark one
//
// So a visitor with JavaScript off still gets their system preference.

(() => {
  const KEY = 'paybox-theme';
  const MODES = ['auto', 'light', 'dark'];

  const stored = (() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      // Private mode, or storage denied. Not a reason to fail to render.
      return null;
    }
  })();

  let mode = MODES.includes(stored) ? stored : 'auto';

  const apply = () => {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  };

  apply();

  // The control is in the body, which does not exist yet at this point.
  const wire = () => {
    const select = document.querySelector('[data-theme-select]');
    const label = document.querySelector('[data-theme-label]');
    if (!select) return;

    const show = () => {
      select.value = mode;
      if (label) label.textContent = mode[0].toUpperCase() + mode.slice(1);
    };

    show();
    // The switch is hidden until here, so a visitor without this script is
    // not offered a control that cannot work.
    document.documentElement.setAttribute('data-theme-ready', '');

    select.addEventListener('change', () => {
      mode = MODES.includes(select.value) ? select.value : 'auto';
      apply();
      show();
      try {
        if (mode === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, mode);
      } catch {
        // The theme still applies for this visit; it just will not persist.
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();
