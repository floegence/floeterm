export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export function normalizeThemeColor(value: string | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(trimmed);
  if (!rgb) return null;

  const channels = rgb.slice(1).map(channel => Number(channel));
  if (channels.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null;
  }

  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function parseThemeColor(value: string | undefined): RgbColor | null {
  const normalized = normalizeThemeColor(value);
  if (!normalized) return null;
  const hex = normalized.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function formatThemeColor(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function relativeLuminance(color: RgbColor): number {
  const linear = [color.r, color.g, color.b].map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(left: RgbColor, right: RgbColor): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function mixColor(source: RgbColor, target: RgbColor, amount: number): RgbColor {
  const channel = (left: number, right: number) => Math.round(left + (right - left) * amount);
  return {
    r: channel(source.r, target.r),
    g: channel(source.g, target.g),
    b: channel(source.b, target.b),
  };
}

function closestContrastingMix(
  background: RgbColor,
  target: RgbColor,
  minimumRatio: number,
): { color: RgbColor; amount: number } | null {
  if (contrastRatio(background, target) < minimumRatio) return null;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const middle = (low + high) / 2;
    if (contrastRatio(background, mixColor(background, target, middle)) >= minimumRatio) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return { color: mixColor(background, target, high), amount: high };
}

export function deriveContrastingThemeColor(
  background: RgbColor,
  minimumRatio: number,
): RgbColor {
  const blackTarget = { r: 0, g: 0, b: 0 };
  const whiteTarget = { r: 255, g: 255, b: 255 };
  const black = closestContrastingMix(background, blackTarget, minimumRatio);
  const white = closestContrastingMix(background, whiteTarget, minimumRatio);
  if (!black && !white) {
    return contrastRatio(background, blackTarget) >= contrastRatio(background, whiteTarget)
      ? blackTarget
      : whiteTarget;
  }
  if (!black) return white!.color;
  if (!white) return black.color;
  return black.amount <= white.amount ? black.color : white.color;
}
