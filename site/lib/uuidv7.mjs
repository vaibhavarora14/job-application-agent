/**
 * RFC 9562 UUIDv7. PostHog session ids must be v7; `crypto.randomUUID()` is v4.
 *
 * @param {number} [timestampMs]
 * @param {Uint8Array} [randomBytes]
 * @returns {string}
 */
export function uuidv7(timestampMs = Date.now(), randomBytes) {
  const bytes = randomBytes && randomBytes.byteLength >= 16
    ? Uint8Array.from(randomBytes.subarray(0, 16))
    : crypto.getRandomValues(new Uint8Array(16));
  const ts = BigInt(timestampMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isUuidV7(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
