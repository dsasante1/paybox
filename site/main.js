// The only script on the sheet: the tabbed data panel, and the copy buttons.
// Line numbers in the code panels are CSS generated content, which browsers
// leave out of a copy -- but each line is its own block element, so the text
// has to be rejoined with newlines rather than read off `textContent`.

/** Flash a short confirmation on a button without losing its label. */
function flash(button, message) {
  const previous = button.dataset.label ?? button.textContent;
  button.dataset.label = previous;
  button.textContent = message;
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1400));
}

async function copy(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Copy failed');
  }
}

/** The text of a code panel, one line per `.l` element. */
function panelText(panel) {
  const lines = [...panel.querySelectorAll('.l')].map((line) => line.textContent);
  return `${lines.join('\n').replace(/[ \t]+$/gm, '')}\n`;
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', () => copy(button, button.dataset.copy));
}

// ---- the data panel -------------------------------------------------------

for (const list of document.querySelectorAll('[role=tablist]')) {
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const panelFor = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

  const select = (tab, { focus = true } = {}) => {
    for (const other of tabs) {
      const chosen = other === tab;
      other.setAttribute('aria-selected', String(chosen));
      other.tabIndex = chosen ? 0 : -1;
      panelFor(other).hidden = !chosen;
    }
    if (focus) tab.focus();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab, { focus: false }));
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, Home: -tabs.length, End: tabs.length }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const index = tabs.indexOf(tab) + step;
      select(tabs[Math.min(Math.max(index, 0), tabs.length - 1)]);
    });
  }

  // The panel's copy button follows whichever tab is showing.
  const bar = list.closest('.panel-bar');
  const button = bar?.querySelector('[data-copy-panel]');
  if (button) {
    button.addEventListener('click', () => {
      const current = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      copy(button, panelText(panelFor(current)));
    });
  }
}
