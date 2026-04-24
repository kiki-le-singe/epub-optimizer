import { describe, it, expect } from "vitest";
import { removeEmptyStyles } from "./remove-empty-styles.js";

describe("removeEmptyStyles", () => {
  it('strips empty style="" attributes and reports the count', () => {
    const input = `<?xml version="1.0"?><root><p style="">one</p><p style="">two</p></root>`;
    const { xml, removed } = removeEmptyStyles(input);
    expect(removed).toBe(2);
    expect(xml).not.toContain('style=""');
    expect(xml).toContain("<p>one</p>");
    expect(xml).toContain("<p>two</p>");
  });

  it("leaves non-empty style attributes untouched", () => {
    const input = `<?xml version="1.0"?><root><p style="color:red">a</p></root>`;
    const { xml, removed } = removeEmptyStyles(input);
    expect(removed).toBe(0);
    expect(xml).toContain('style="color:red"');
  });

  it("returns removed=0 when nothing to strip", () => {
    const input = `<?xml version="1.0"?><root><p>no style</p></root>`;
    const { removed } = removeEmptyStyles(input);
    expect(removed).toBe(0);
  });
});
