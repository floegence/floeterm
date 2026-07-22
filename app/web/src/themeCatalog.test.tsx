// @vitest-environment jsdom

import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_THEME_DEFINITIONS } from '@floegence/floeterm-terminal-web';
import { applyTerminalThemeShell, ThemeSelector } from './themeCatalog';

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-appearance');
  document.documentElement.removeAttribute('style');
});

describe('theme catalog demo integration', () => {
  it('maps new light and dark themes onto complete shell appearance baselines', () => {
    applyTerminalThemeShell(document.documentElement, 'studioPaper');
    expect(document.documentElement.dataset.theme).toBe('studioPaper');
    expect(document.documentElement.dataset.themeAppearance).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#f7f8fa');

    applyTerminalThemeShell(document.documentElement, 'polarVeil');
    expect(document.documentElement.dataset.themeAppearance).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#10201f');

    applyTerminalThemeShell(document.documentElement, 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeAppearance).toBe('light');
  });

  it('renders one accessible, uniquely labeled option per catalog item', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onThemeChange = vi.fn();
    render(() => (
      <ThemeSelector themeName="signalSafeDark" onThemeChange={onThemeChange} />
    ), host);

    const select = host.querySelector('select[aria-label="Terminal theme"]') as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(select.value).toBe('signalSafeDark');
    expect(options).toHaveLength(20);
    expect(options.map((option) => option.value)).toEqual(TERMINAL_THEME_DEFINITIONS.map(({ id }) => id));
    expect(new Set(options.map((option) => option.text)).size).toBe(20);

    select.value = 'openSky';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onThemeChange).toHaveBeenCalledWith('openSky');
  });
});
