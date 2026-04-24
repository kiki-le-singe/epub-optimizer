import { describe, it, expect } from "vitest";
import { setCoverLinear } from "./update-cover-linear.js";

const opfWith = (spine: string) =>
  `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/></manifest><spine>${spine}</spine></package>`;

describe("setCoverLinear", () => {
  it('adds linear="yes" to the cover itemref', () => {
    const input = opfWith('<itemref idref="cover"/><itemref idref="chap1"/>');
    const { xml, updated } = setCoverLinear(input);
    expect(updated).toBe(true);
    expect(xml).toContain('<itemref idref="cover" linear="yes"/>');
  });

  it("is a no-op when no cover itemref exists", () => {
    const input = opfWith('<itemref idref="chap1"/>');
    const { xml, updated } = setCoverLinear(input);
    expect(updated).toBe(false);
    expect(xml).toBe(input);
  });

  it('overwrites linear="no" if already present', () => {
    const input = opfWith('<itemref idref="cover" linear="no"/>');
    const { xml, updated } = setCoverLinear(input);
    expect(updated).toBe(true);
    expect(xml).toContain('linear="yes"');
    expect(xml).not.toContain('linear="no"');
  });
});
