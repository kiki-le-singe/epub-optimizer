import { describe, it, expect } from "vitest";
import { fixXml } from "./fix-xml.js";

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

describe("fixXml", () => {
  it("self-closes bare <br> tags", () => {
    const input = wrap("<p>a<br>b</p>");
    const out = fixXml(input);
    expect(out).toContain("<br/>");
    expect(out).not.toMatch(/<br>/);
  });

  it("removes invalid closing </br> tags", () => {
    const input = wrap("<p>a<br></br>b</p>");
    const out = fixXml(input);
    expect(out).not.toContain("</br>");
  });

  it("strips <script> tags", () => {
    const input = wrap('<script>alert("x")</script><p>ok</p>');
    const out = fixXml(input);
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>ok</p>");
  });

  it("drops <meta> tags that are not direct children of <head>", () => {
    const input = wrap('<div><meta name="bad" content="x"/></div>');
    const out = fixXml(input);
    expect(out).not.toContain('name="bad"');
  });

  it("keeps <meta> tags inside <head>", () => {
    const input = `<?xml version="1.0"?>\n<html><head><meta charset="utf-8"/><title>t</title></head><body/></html>`;
    const out = fixXml(input);
    expect(out).toContain('charset="utf-8"');
  });

  it("is a no-op on already-clean XHTML", () => {
    const input = wrap("<p>clean</p>");
    const out = fixXml(input);
    expect(out).toContain("<p>clean</p>");
  });
});
