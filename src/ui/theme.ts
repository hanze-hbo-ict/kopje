// Three-way appearance toggle, from Klode (src/theme.js; MIT, © 2026 Codeklad contributors).
import type { ThemeChoice } from '../project/model.ts';

const CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];

export function createTheme(
  button: HTMLButtonElement,
  initial: ThemeChoice,
  onChange: (resolved: 'light' | 'dark', choice: ThemeChoice) => void,
) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let choice = initial;
  function update() {
    const resolved = choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.theme = resolved;
    button.dataset.themeChoice = choice;
    const next = CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
    const description = `${choice[0].toUpperCase() + choice.slice(1)} appearance. Switch to ${next} appearance`;
    button.setAttribute('aria-label', description);
    button.title = description;
    for (const icon of button.querySelectorAll<SVGElement>('[data-theme-icon]')) {
      icon.toggleAttribute('hidden', icon.dataset.themeIcon !== choice);
    }
    onChange(resolved, choice);
  }
  media.addEventListener('change', update);
  button.addEventListener('click', () => {
    choice = CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
    update();
  });
  update();
}
