// Decode a base64-encoded little-endian Float32 array (as emitted by
// tools/extract_stock.py) into a Float32Array for upload as an rgba16f texture.
export function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
