/** Named, closed decoder contract. Values retain the provider's native strings. */
export const ECB_DECODER = "ecb-eurofxref/1";
export const MAX_XML_BYTES = 2 * 1024 * 1024;
export interface ECBQuote { readonly time: string; readonly currency: string; readonly rate: string }
export type XMLParser = Pick<DOMParser, "parseFromString">;
const gesmes = "http://www.gesmes.org/xml/2002-08-01";
const ecb = "http://www.ecb.int/vocabulary/2002-08-01/eurofxref";
const xmlns = "http://www.w3.org/2000/xmlns/";

function fail(): never { throw new TypeError("invalid ecb-eurofxref/1 XML"); }
function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

export function decodeECBDaily(bytes: Uint8Array, parser?: XMLParser): readonly ECBQuote[] {
  if (bytes.byteLength > MAX_XML_BYTES) fail();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Refuse DTDs before parsing, and all entity references, including numeric ones.
  if (text.includes("&") || /<!DOCTYPE/iu.test(text)) fail();
  const declaration = /^<\?xml\s+([^?]*)\?>/u.exec(text)?.[1];
  const encoding = declaration === undefined ? undefined : /encoding\s*=\s*["']([^"']+)["']/u.exec(declaration)?.[1];
  if (encoding !== undefined && encoding.toLowerCase() !== "utf-8") fail();
  const document = (parser ?? new DOMParser()).parseFromString(text, "application/xml");
  const rows: ECBQuote[] = [];
  const currencies = new Set<string>();
  let referenceDate = "";
  const counts = new Map<string, number>();
  function walk(node: Node, path: readonly string[]): void {
    if (node.nodeType === 8) return; // Comments carry no semantic fields.
    if (node.nodeType === 3 || node.nodeType === 4) {
      if ((node.nodeValue ?? "").trim() !== "" && !["subject", "name"].includes(path.at(-1) ?? "")) fail();
      return;
    }
    if (node.nodeType !== 1 || path.length >= 4) fail();
    const element = node as Element;
    const name = element.localName;
    const location = [...path, name].join("/");
    const expected = new Map([
      ["Envelope", gesmes], ["Envelope/subject", gesmes], ["Envelope/Sender", gesmes],
      ["Envelope/Sender/name", gesmes], ["Envelope/Cube", ecb],
      ["Envelope/Cube/Cube", ecb], ["Envelope/Cube/Cube/Cube", ecb],
    ]);
    if (expected.get(location) !== element.namespaceURI) fail();
    const count = (counts.get(location) ?? 0) + 1;
    counts.set(location, count);
    if (location !== "Envelope/Cube/Cube/Cube" && count > 1) fail();
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI === xmlns) continue;
      if (attribute.namespaceURI !== null || Object.hasOwn(attributes, attribute.localName)) fail();
      attributes[attribute.localName] = attribute.value;
    }
    if (location === "Envelope/Cube/Cube") {
      if (Object.keys(attributes).length !== 1 || !date(attributes.time ?? "")) fail();
      referenceDate = attributes.time ?? "";
    } else if (location === "Envelope/Cube/Cube/Cube") {
      const currency = attributes.currency ?? "";
      const rate = attributes.rate ?? "";
      if (Object.keys(attributes).length !== 2 || !/^[A-Z]{3}$/u.test(currency)
        || currency === "EUR" || currencies.has(currency)
        || !/^\d+(?:\.\d+)?$/u.test(rate) || rate.replaceAll(/[0.]/gu, "") === ""
        || rows.length >= 256) fail();
      currencies.add(currency);
      rows.push({ time: referenceDate, currency, rate });
    } else if (Object.keys(attributes).length !== 0) fail();
    for (const child of Array.from(element.childNodes)) walk(child, [...path, name]);
  }
  for (const node of Array.from(document.childNodes)) walk(node, []);
  if (counts.get("Envelope") !== 1 || counts.get("Envelope/Cube") !== 1
    || counts.get("Envelope/Cube/Cube") !== 1 || rows.length === 0) fail();
  return rows;
}
