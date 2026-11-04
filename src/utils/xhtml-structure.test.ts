import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { xhtmlStructure } from "./xhtml-structure.js";

const fingerprint = (content: string) =>
  xhtmlStructure(cheerio.load(content, { xml: { decodeEntities: false } }));

describe("XHTML structure preservation", () => {
  it.each([
    ["<p>A<meta/>B</p>", "<p>A</p><meta/>B<p/>"],
    ["<div><span>A</span></div>", "<div/><span>A</span>"],
    ["<p><b>A</b></p>", "<p>A</p>"],
    ["<p>A</p>", "<p>A</p><p/>"],
    ['<p id="a"/><p id="b"/>', '<p id="b"/><p id="a"/>'],
    ["<svg><linearGradient/></svg>", "<svg><lineargradient/></svg>"],
    ['<svg xmlns="http://www.w3.org/2000/svg"/>', "<svg/>"],
    ['<p id="anchor"/>', '<p id="different"/>'],
    ["<p>A<span>B</span>C</p>", "<p>AB<span/>C</p>"],
    ["<p>A <b>B</b></p>", "<p>A<b> B</b></p>"],
    ["<style><unexpected/></style>", "<style/>"],
  ])("detects changed structure or content: %s", (before, after) => {
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it.each([
    ["<p>A<!-- comment -->B</p>", "<p>AB</p>"],
    ["<p><![CDATA[a & b]]></p>", "<p>a &amp; b</p>"],
    ["<p><![CDATA[&amp;]]></p>", "<p>&amp;amp;</p>"],
    ["<p>été &#xe9;</p>", "<p>été é</p>"],
    ['<p id="x" class="a">x</p>', '<p class="a" id="x">x</p>'],
    ['<p title="a &amp; b"/>', "<p title='a &#38; b'></p>"],
    ["<p>A\r\nB</p>", "<p>A\nB</p>"],
    [
      '<p style="color: red;" onclick="go( 1 );">x</p>',
      '<p style="color:red" onclick="go(1);">x</p>',
    ],
    [
      '<style media="screen and (max-width: 600px)">p { color: red; }</style>',
      '<style media="screen and (max-width:600px)">p{color:red}</style>',
    ],
    ["<script>var total = 1 + 2;</script>", "<script>var total=3;</script>"],
    ['<img srcset="a.jpg 1x, b.jpg 2x"/>', '<img srcset="a.jpg, b.jpg 2x"/>'],
  ])(
    "allows equivalent XML serialization or intentional CSS/JS minification: %s",
    (before, after) => {
      expect(fingerprint(before)).toBe(fingerprint(after));
    }
  );
});
