// Copy button in the corner of a panel, modelled on Krash's (https://krash.pages.dev):
// a copy icon that turns into a check and says "Copied" (or "Copy failed") for 1.5 s.
const ICONS = {
  copy: ['M9 9h10v11H9z', 'M15 9V5a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
  check: ['m5 12.5 4.5 4.5L19 7'],
};

/** Appends the button (and its live status text) to `parent`. */
export function addCopyButton(parent: HTMLElement, id: string, label: string, getText: () => string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button copy-button';
  button.id = id;
  button.setAttribute('aria-label', label);
  button.dataset.tooltip = label;
  button.dataset.tooltipPos = 'top-end';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  button.append(svg);
  const status = document.createElement('span');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');

  const show = (state: 'idle' | 'copied' | 'failed') => {
    svg.replaceChildren(...ICONS[state === 'copied' ? 'check' : 'copy'].map((d) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      return path;
    }));
    const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : '';
    button.dataset.tooltip = text || label;
    if (state === 'idle') delete button.dataset.copyState;
    else button.dataset.copyState = state;
    status.textContent = text;
  };
  show('idle');

  let timer: number | undefined;
  button.addEventListener('click', async () => {
    let state: 'copied' | 'failed' = 'copied';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(getText());
    } catch {
      state = 'failed';
    }
    show(state);
    clearTimeout(timer);
    timer = window.setTimeout(() => show('idle'), 1500);
  });
  parent.append(button, status);
  return button;
}
