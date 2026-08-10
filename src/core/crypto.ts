const BASE32_HEX = "0123456789abcdefghijklmnopqrstuv";

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export function base32Hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_HEX[(value << (5 - bits)) & 31];
  return output;
}

export async function stableGoogleEventId(schoolId: string, studentId: string, sourceId: string): Promise<string> {
  const digest = await sha256(`${schoolId}:${studentId}:${sourceId}`);
  return `1ec710${base32Hex(digest).slice(0, 40)}`;
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await sha256(JSON.stringify(value));
  return base32Hex(digest).slice(0, 32);
}
