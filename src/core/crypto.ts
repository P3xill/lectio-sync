const BASE32_HEX = "0123456789abcdefghijklmnopqrstuv";
const encoder = new TextEncoder();
const MAX_CACHED_EVENT_IDS = 2_000;
const eventIds = new Map<string, string>();

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
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
  // IDs are immutable for this exact account/source tuple. Cache only these
  // hashes in memory; event fingerprints must always reflect fresh contents.
  const key = `${schoolId}:${studentId}:${sourceId}`;
  const cached = eventIds.get(key);
  if (cached) return cached;
  const digest = await sha256(key);
  const id = `1ec710${base32Hex(digest).slice(0, 40)}`;
  if (eventIds.size >= MAX_CACHED_EVENT_IDS) eventIds.clear();
  eventIds.set(key, id);
  return id;
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await sha256(JSON.stringify(value));
  return base32Hex(digest).slice(0, 32);
}
