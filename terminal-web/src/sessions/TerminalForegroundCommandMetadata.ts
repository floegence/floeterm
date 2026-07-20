const MAX_PROGRAM_BYTES = 64;
const textEncoder = new TextEncoder();

export function normalizeTerminalForegroundCommandDisplayName(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text || textEncoder.encode(text).byteLength > MAX_PROGRAM_BYTES) return '';
  return /^[A-Za-z0-9._+@-]+$/.test(text) ? text : '';
}
