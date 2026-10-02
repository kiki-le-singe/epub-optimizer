import { describe, it, expect } from "vitest";
import { isXHTMLContent, normalizeVoidElements } from "./xhtml.js";

describe("normalizeVoidElements", () => {
  it("self-closes a bare <link> with attributes", () => {
    const input = `<link rel="stylesheet" type="text/css" href="style.css">`;
    expect(normalizeVoidElements(input)).toBe(
      `<link rel="stylesheet" type="text/css" href="style.css" />`
    );
  });

  it("self-closes every HTML5 void element", () => {
    const input = `<br><hr><img src="x"><meta charset="utf-8"><input type="text"><wbr>`;
    const out = normalizeVoidElements(input);
    for (const tag of ["br", "hr", "img", "meta", "input", "wbr"]) {
      expect(out).toMatch(new RegExp(`<${tag}[^>]*/>`));
    }
  });

  it("leaves already self-closed tags untouched (idempotent)", () => {
    const input = `<br /><link href="a.css" rel="stylesheet"/><img src="x" />`;
    expect(normalizeVoidElements(input)).toBe(input);
  });

  it("double-application is a no-op", () => {
    const input = `<link rel="stylesheet" href="a.css"><br>`;
    const once = normalizeVoidElements(input);
    const twice = normalizeVoidElements(once);
    expect(twice).toBe(once);
  });

  it("does not touch non-void elements", () => {
    const input = `<p>hi</p><a href="x">link</a><div></div>`;
    expect(normalizeVoidElements(input)).toBe(input);
  });

  it("handles attribute values containing slashes", () => {
    const input = `<img src="images/photo.jpg" alt="ok">`;
    expect(normalizeVoidElements(input)).toBe(`<img src="images/photo.jpg" alt="ok" />`);
  });

  it("does not match tags whose name merely starts with a void name", () => {
    // `<linked>` is not `<link>`; `<break>` is not `<br>`
    const input = `<linked>x</linked><break>y</break><br-widget/><br:custom/>`;
    expect(normalizeVoidElements(input)).toBe(input);
  });

  it("preserves tag-like text and greater-than signs inside quoted attributes", () => {
    const input = `<img src="x.jpg" alt="a > b and <br>" title='a > b'><img alt="a > b"/>`;
    expect(normalizeVoidElements(input)).toBe(
      `<img src="x.jpg" alt="a > b and <br>" title='a > b' /><img alt="a > b"/>`
    );
  });

  it("preserves comments, CDATA, processing instructions and declarations", () => {
    const input = `<?example value="<br>"?><!DOCTYPE html [<!-- ]> <br> --><!ENTITY example "<img>">]><!-- <br> --><![CDATA[<hr>]]><br>`;
    expect(normalizeVoidElements(input)).toBe(input.slice(0, -4) + "<br />");
  });

  it("preserves script and style content while normalizing actual tags after them", () => {
    const input = `<script>const tag = "<br>";</script><style>.x::before { content: "<img>"; }</style><br>`;
    expect(normalizeVoidElements(input)).toBe(input.slice(0, -4) + "<br />");
  });

  it("does not mistake a script closing tag inside CDATA for the actual closing tag", () => {
    const input = `<script><![CDATA[const tag = "</script><br>";]]></script><hr>`;
    expect(normalizeVoidElements(input)).toBe(input.slice(0, -4) + "<hr />");
  });

  it("preserves script content when the XHTML namespace uses a prefix", () => {
    const input = `<h:script><![CDATA[const tag = "<br>";]]></h:script><br>`;
    expect(normalizeVoidElements(input)).toBe(input.slice(0, -4) + "<br />");
  });

  it("preserves incomplete markup rather than guessing its boundaries", () => {
    for (const input of [`<img alt="a > b`, `<!-- <br>`, `<![CDATA[<br>`, `<script>"<br>"`]) {
      expect(normalizeVoidElements(input)).toBe(input);
    }
  });
});

describe("isXHTMLContent", () => {
  it("recognises content with an XML declaration", () => {
    expect(isXHTMLContent(`<?xml version="1.0" encoding="UTF-8"?>\n<html></html>`)).toBe(true);
  });

  it("recognises content with the XHTML namespace", () => {
    expect(isXHTMLContent(`<html xmlns="http://www.w3.org/1999/xhtml"><head></head></html>`)).toBe(
      true
    );
  });

  it("recognises an XHTML PUBLIC DOCTYPE", () => {
    expect(
      isXHTMLContent(
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html></html>`
      )
    ).toBe(true);
  });

  it("returns false for plain HTML5", () => {
    expect(isXHTMLContent(`<!DOCTYPE html>\n<html><head></head><body></body></html>`)).toBe(false);
  });
});
