import { describe, expect, it } from 'vitest';
import type { TerminalThemeColors } from '../types';
import { TERMINAL_THEME_DEFINITIONS } from './config';

const ORIGINAL_THEME_IDS = new Set([
  'polarVeil', 'copperCircuit', 'violetDusk', 'cedarGrove', 'midnightInk',
  'velvetOrchid', 'blueQuarry', 'studioPaper', 'softLinen', 'mintGlass',
  'roseDawn', 'openSky', 'highContrastDark', 'highContrastLight', 'signalSafeDark',
]);

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies readonly (keyof TerminalThemeColors)[];

const CHROMATIC_ANSI_KEYS = ANSI_KEYS.filter((key) => key !== 'black' && key !== 'brightBlack');

const CVD_MATRICES = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
} as const;

function rgb(hex: string): [number, number, number] {
  const raw = hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearRgb(hex: string): [number, number, number] {
  return rgb(hex).map(linear) as [number, number, number];
}

function luminance(hex: string): number {
  const [red, green, blue] = linearRgb(hex);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(left: string, right: string): number {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

function simulateLinear(
  source: [number, number, number],
  matrix: readonly (readonly number[])[],
): [number, number, number] {
  return matrix.map((row) => Math.max(0, Math.min(1, row.reduce((sum, value, index) => sum + value * source[index]!, 0)))) as [number, number, number];
}

function labFromLinear([red, green, blue]: [number, number, number]): [number, number, number] {
  const x = (0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047;
  const y = 0.2126729 * red + 0.7151522 * green + 0.0721750 * blue;
  const z = (0.0193339 * red + 0.1191920 * green + 0.9503041 * blue) / 1.08883;
  const transform = (value: number) => value > (216 / 24389)
    ? Math.cbrt(value)
    : ((24389 / 27) * value + 16) / 116;
  const [fx, fy, fz] = [transform(x), transform(y), transform(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function lab(hex: string, matrix?: readonly (readonly number[])[]): [number, number, number] {
  const source = linearRgb(hex);
  return labFromLinear(matrix ? simulateLinear(source, matrix) : source);
}

function deltaE00([l1, a1, b1]: number[], [l2, a2, b2]: number[]): number {
  const radians = Math.PI / 180;
  const degrees = 180 / Math.PI;
  const c1 = Math.hypot(a1!, b1!);
  const c2 = Math.hypot(a2!, b2!);
  const cAverage = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt((cAverage ** 7) / ((cAverage ** 7) + (25 ** 7))));
  const a1Prime = (1 + g) * a1!;
  const a2Prime = (1 + g) * a2!;
  const c1Prime = Math.hypot(a1Prime, b1!);
  const c2Prime = Math.hypot(a2Prime, b2!);
  const hue = (a: number, b: number) => {
    const value = Math.atan2(b, a) * degrees;
    return value >= 0 ? value : value + 360;
  };
  const h1Prime = hue(a1Prime, b1!);
  const h2Prime = hue(a2Prime, b2!);
  const deltaLPrime = l2! - l1!;
  const deltaCPrime = c2Prime - c1Prime;
  const hueDelta = h2Prime - h1Prime;
  const deltaHueDegrees = c1Prime * c2Prime === 0
    ? 0
    : Math.abs(hueDelta) <= 180
      ? hueDelta
      : hueDelta > 180 ? hueDelta - 360 : hueDelta + 360;
  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin((deltaHueDegrees / 2) * radians);
  const lAveragePrime = (l1! + l2!) / 2;
  const cAveragePrime = (c1Prime + c2Prime) / 2;
  const hAveragePrime = c1Prime * c2Prime === 0
    ? h1Prime + h2Prime
    : Math.abs(h1Prime - h2Prime) <= 180
      ? (h1Prime + h2Prime) / 2
      : (h1Prime + h2Prime + (h1Prime + h2Prime < 360 ? 360 : -360)) / 2;
  const t = 1
    - 0.17 * Math.cos((hAveragePrime - 30) * radians)
    + 0.24 * Math.cos(2 * hAveragePrime * radians)
    + 0.32 * Math.cos((3 * hAveragePrime + 6) * radians)
    - 0.20 * Math.cos((4 * hAveragePrime - 63) * radians);
  const deltaTheta = 30 * Math.exp(-(((hAveragePrime - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt((cAveragePrime ** 7) / ((cAveragePrime ** 7) + (25 ** 7)));
  const sl = 1 + (0.015 * ((lAveragePrime - 50) ** 2)) / Math.sqrt(20 + ((lAveragePrime - 50) ** 2));
  const sc = 1 + 0.045 * cAveragePrime;
  const sh = 1 + 0.015 * cAveragePrime * t;
  const rt = -Math.sin(2 * deltaTheta * radians) * rc;
  const lTerm = deltaLPrime / sl;
  const cTerm = deltaCPrime / sc;
  const hTerm = deltaHPrime / sh;
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm);
}

describe('built-in terminal theme quality', () => {
  it('matches the Sharma CIEDE2000 reference pair', () => {
    expect(deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
  });

  it('keeps required text, selection, and cursor contrast', () => {
    for (const theme of TERMINAL_THEME_DEFINITIONS) {
      const colors = theme.colors;
      expect(contrast(colors.foreground, colors.background), `${theme.id} foreground`).toBeGreaterThanOrEqual(
        theme.id.startsWith('highContrast') ? 7 : 4.5,
      );
      expect(contrast(colors.selectionForeground, colors.selectionBackground), `${theme.id} selection`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.cursor, colors.background), `${theme.id} cursor`).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.cursorAccent, colors.cursor), `${theme.id} cursor accent`).toBeGreaterThanOrEqual(4.5);
      if (ORIGINAL_THEME_IDS.has(theme.id)) {
        for (const key of CHROMATIC_ANSI_KEYS) {
          expect(contrast(colors[key], colors.background), `${theme.id}.${key}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(colors.brightBlack, colors.background), `${theme.id}.brightBlack`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps every theme visually distinct from its nearest neighbor', () => {
    const identityFields: ReadonlyArray<readonly [keyof TerminalThemeColors, number]> = [
      ['background', 4], ['foreground', 2], ['selectionBackground', 2],
      ...ANSI_KEYS.map((key) => [key, 1] as const),
    ];
    for (const theme of TERMINAL_THEME_DEFINITIONS) {
      const nearest = TERMINAL_THEME_DEFINITIONS
        .filter((candidate) => candidate.id !== theme.id)
        .map((candidate) => {
          const totalWeight = identityFields.reduce((sum, [, weight]) => sum + weight, 0);
          return identityFields.reduce((sum, [key, weight]) => (
            sum + deltaE00(lab(theme.colors[key]), lab(candidate.colors[key])) * weight
          ), 0) / totalWeight;
        })
        .sort((left, right) => left - right)[0]!;
      expect(nearest, theme.id).toBeGreaterThanOrEqual(5);
    }
  });

  it('keeps Signal Safe Dark separated under full dichromacy simulation', () => {
    const colors = TERMINAL_THEME_DEFINITIONS.find(({ id }) => id === 'signalSafeDark')!.colors;
    const normalBrightPairs = [
      ['black', 'brightBlack'], ['red', 'brightRed'], ['green', 'brightGreen'], ['yellow', 'brightYellow'],
      ['blue', 'brightBlue'], ['magenta', 'brightMagenta'], ['cyan', 'brightCyan'], ['white', 'brightWhite'],
    ] as const satisfies ReadonlyArray<readonly [keyof TerminalThemeColors, keyof TerminalThemeColors]>;
    for (const [simulation, matrix] of Object.entries(CVD_MATRICES)) {
      expect(deltaE00(lab(colors.red, matrix), lab(colors.green, matrix)), `${simulation} red/green`).toBeGreaterThanOrEqual(10);
      expect(deltaE00(lab(colors.blue, matrix), lab(colors.magenta, matrix)), `${simulation} blue/magenta`).toBeGreaterThanOrEqual(10);
      for (const [normal, bright] of normalBrightPairs) {
        expect(deltaE00(lab(colors[normal], matrix), lab(colors[bright], matrix)), `${simulation} ${normal}/${bright}`).toBeGreaterThanOrEqual(5);
      }
    }
  });
});
