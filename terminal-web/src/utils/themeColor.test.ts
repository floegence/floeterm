import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  deriveContrastingThemeColor,
  normalizeThemeColor,
  parseThemeColor,
} from './themeColor';

describe('themeColor', () => {
  it('normalizes supported theme color syntaxes without accepting out-of-range channels', () => {
    expect(normalizeThemeColor('#AbC')).toBe('#aabbcc');
    expect(normalizeThemeColor('rgb(1, 20, 255)')).toBe('#0114ff');
    expect(normalizeThemeColor('rgb(256, 0, 0)')).toBeNull();
  });

  it('finds the closest black-or-white mix that satisfies contrast', () => {
    for (const source of ['#ffffff', '#111827', 'rgb(120, 130, 140)']) {
      const background = parseThemeColor(source)!;
      const derived = deriveContrastingThemeColor(background, 4.5);
      expect(contrastRatio(background, derived)).toBeGreaterThanOrEqual(4.49);
    }
  });

  it('uses the strongest black-or-white endpoint when a requested ratio is impossible', () => {
    const background = parseThemeColor('#777')!;
    const derived = deriveContrastingThemeColor(background, 7);
    expect(derived).toEqual({ r: 0, g: 0, b: 0 });
    expect(contrastRatio(background, derived)).toBeGreaterThan(4.68);
  });
});
