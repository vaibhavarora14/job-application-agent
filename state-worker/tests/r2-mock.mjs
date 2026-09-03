async function toUint8Array(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  throw new TypeError('Unsupported R2 put body.');
}

async function digestHex(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createMemoryR2() {
  const store = new Map();

  return {
    async get(key) {
      const object = store.get(key);
      if (!object) return null;
      return {
        key,
        etag: object.etag,
        httpEtag: `"${object.etag}"`,
        uploaded: object.uploaded,
        size: object.body.byteLength,
        customMetadata: { ...object.customMetadata },
        httpMetadata: { ...object.httpMetadata },
        async arrayBuffer() {
          return object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.byteLength);
        },
        async text() {
          return new TextDecoder().decode(object.body);
        },
      };
    },
    async head(key) {
      const object = await this.get(key);
      if (!object) return null;
      const { arrayBuffer, text, ...meta } = object;
      return meta;
    },
    async put(key, value, options = {}) {
      const body = await toUint8Array(value);
      const existing = store.get(key);
      const onlyIf = options.onlyIf;
      if (onlyIf) {
        if (existing && onlyIf.etagDoesNotMatch === '*') return null;
        if (!existing && onlyIf.etagMatches) return null;
        if (existing && onlyIf.etagMatches && existing.etag !== onlyIf.etagMatches) return null;
      }
      const etag = await digestHex(body);
      const uploaded = new Date();
      store.set(key, {
        body,
        etag,
        uploaded,
        customMetadata: options.customMetadata ?? {},
        httpMetadata: options.httpMetadata ?? {},
      });
      return {
        key,
        etag,
        httpEtag: `"${etag}"`,
        uploaded,
        size: body.byteLength,
      };
    },
    async list(options = {}) {
      const prefix = options.prefix ?? '';
      const objects = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({
          key,
          etag: object.etag,
          uploaded: object.uploaded,
          size: object.body.byteLength,
        }));
      return { objects, truncated: false };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
