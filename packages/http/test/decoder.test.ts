import { describe, expect, it } from "vitest";
import { decodeECBDaily, MAX_XML_BYTES } from "../src/index.js";
import { bytes, parser, xml } from "./fixture.js";
const decode = (text: string) => decodeECBDaily(bytes(text), new parser());
describe("ecb-eurofxref/1 synthetic XML", () => {
  it("retains native date/currency/rate strings and optional presentation", () => {
    expect(decode(xml)).toEqual([{ time: "2037-02-03", currency: "AAA", rate: "001.23000" },
      { time: "2037-02-03", currency: "ZZZ", rate: "0.00001" }]);
    expect(decode(xml.replace(/<gesmes:subject>.*<\/gesmes:Sender>/u, ""))).toHaveLength(2);
    expect(decode(xml.replace("2037-02-03", "0000-02-29"))[0]?.time).toBe("0000-02-29");
    expect(decode('<?xml version="1.0" encoding="UTF-8"?>' + xml)).toHaveLength(2);
  });
  const invalid = [
    "", "<bad/>", xml + xml, xml.slice(0, -4),
    `<!DOCTYPE x [<!ENTITY a SYSTEM "file:///synthetic">]>${xml}`,
    `<?other forbidden?>${xml}`, xml.replace("synthetic", "&amp;"), xml.replace("synthetic", "&#65;"),
    '<?xml version="1.0" encoding="ISO-8859-1"?>' + xml,
    xml.replace("http://www.gesmes.org/xml/2002-08-01", "urn:wrong"),
    xml.replace("http://www.ecb.int/vocabulary/2002-08-01/eurofxref", "urn:wrong"),
    xml.replace("<Cube>", '<Cube extra="x">'), xml.replace('currency="AAA"', 'currency="AAA" extra="x"'),
    xml.replace('currency="AAA"', 'currency="AAA" gesmes:extra="x"'),
    xml.replace('currency="AAA"', 'currency="AAA" currency="ZZZ"'),
    xml.replace('xmlns:gesmes=', 'xmlns:gesmes="urn:wrong" xmlns:gesmes='),
    xml.replace("2037-02-03", "2037-02-29"), xml.replace("2037-02-03", "2037-2-03"),
    xml.replace("2037-02-03", "2037-13-03"), xml.replace("2037-02-03", "2037-02-00"),
    xml.replace('time="2037-02-03"', 'time="2037-02-03" rate="1"'),
    ...["EUR", "aaa", "AA", "ZZZ"].map((currency) => xml.replace('currency="AAA"', `currency="${currency}"`)),
    ...["0", "000.000", "-1", "1e2", " 1", ".1", "1.", "NaN"].map((rate) => xml.replace("001.23000", rate)),
    xml.replace('rate="001.23000"', ""), xml.replace("<Cube>", "<Cube>unexpected"),
    xml.replace("<Cube>", "<Cube><unknown/>"), xml.replace('/><Cube currency="ZZZ"', '><Cube/></Cube><Cube currency="ZZZ"'),
    xml.replace("<gesmes:subject>synthetic</gesmes:subject>", "<gesmes:subject/><gesmes:subject/>"),
    xml.replace("<gesmes:name>invented</gesmes:name>", "<gesmes:name/><gesmes:name/>"),
    xml.replace("</gesmes:Sender>", "</gesmes:Sender><gesmes:Sender/>"),
    xml.replace("</gesmes:Envelope>", "<Cube/></gesmes:Envelope>"),
    xml.replace("</Cube></Cube>", '</Cube><Cube time="2037-02-04"/></Cube>'),
    xml.replace(/<Cube currency=.*?<\/Cube>/u, "</Cube>"),
  ];
  it.each(invalid.map((value, index) => ({ value, index })))("refuses malformed/hostile fixture $index", ({ value }) => {
    expect(() => decode(value)).toThrow();
  });
  it("refuses byte limits, invalid UTF-8 and more than 256 quotes", () => {
    expect(() => decodeECBDaily(new Uint8Array(MAX_XML_BYTES + 1), new parser())).toThrow();
    expect(() => decodeECBDaily(new Uint8Array([0xff]), new parser())).toThrow();
    const quotes = Array.from({ length: 257 }, (_, i) => `<Cube currency="A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}" rate="1"/>`).join("");
    expect(() => decode(xml.replace(/<Cube currency=.*?<\/Cube>/u, quotes + "</Cube>"))).toThrow();
  });
});
