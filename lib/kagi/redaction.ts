// Credentials are ASCII cookie octets. Decode individual escapes so malformed
// neighboring UTF-8/percent sequences cannot hide an otherwise valid reflection.
export function credentialBearing(value: string, token: string): boolean {
  for (let depth = 0; depth <= 4; depth++) {
    if (value.includes(token)) return true;
    const decoded = value.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === value) return false;
    // Unresolved nesting fails closed rather than escaping the inspection bound.
    if (depth === 4) return true;
    value = decoded;
  }
  return false;
}
export function redactText(value: string, token?: string): string {
  return token && credentialBearing(value, token) ? '[redacted]' : value;
}
