/** Small explicit wire fixture, independent from the production decoder. */
export function uint(value: bigint, size: number): number[] {
  const encoded: number[] = [];
  let remaining = BigInt.asUintN(size * 8, value);
  for (let index = 0; index < size; index += 1) { encoded.push(Number(remaining & 255n)); remaining >>= 8n; }
  return encoded;
}
export function leb(value: number): number[] {
  const encoded: number[] = [];
  let remaining = value;
  do { const byte = remaining % 128; remaining = Math.floor(remaining / 128); encoded.push(byte | (remaining === 0 ? 0 : 128)); } while (remaining > 0);
  return encoded;
}
export function text(value: string): number[] { const encoded = new TextEncoder().encode(value); return [...leb(encoded.length), ...encoded]; }
export function binary(names: readonly string[], types: readonly string[], rows: readonly number[][] = []): Uint8Array {
  return Uint8Array.from([...leb(names.length), ...names.flatMap(text), ...types.flatMap(text), ...rows.flat()]);
}
export function float(value: number, size = 8): number[] {
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  if (size === 4) view.setFloat32(0, value, true); else view.setFloat64(0, value, true);
  return [...bytes];
}
