export function normalizeTerminalRemoteAuthority(
  value: unknown,
  localHostname = '',
): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value !== value.trim()) return '';
  const lower = value.toLowerCase();
  if (/[\/?#@]/.test(lower)) return '';
  if (lower.startsWith('[') || lower.endsWith(']')) {
    if (!/^\[[^\[\]]+\]$/.test(lower)) return '';
    try {
      const parsed = new URL(`http://${lower}/`);
      if (parsed.port || !parsed.hostname.includes(':') || parsed.hostname === '[::1]'
        || /^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(parsed.hostname)) return '';
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  if (lower.includes(':')) return '';
  if (/^[0-9.]+$/.test(lower) && lower.includes('.')) {
    if (!/^\d+(?:\.\d+){3}$/.test(lower)) return '';
    const parts = lower.split('.');
    if (parts.some(part => String(Number(part)) !== part)) return '';
    const octets = parts.map(Number);
    if (octets.some(octet => octet < 0 || octet > 255) || octets[0] === 127) return '';
    return octets.join('.');
  }
  const canonical = lower.replace(/\.$/, '');
  const local = localHostname.toLowerCase().replace(/\.$/, '');
  if (canonical === 'localhost' || canonical === local || canonical.length > 253) return '';
  const labels = canonical.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
  return canonical;
}

export function normalizeTerminalRemotePath(value: unknown): string {
  if (typeof value !== 'string' || !value || !value.startsWith('/')) return '';
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}
