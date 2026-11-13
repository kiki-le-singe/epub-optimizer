"""Generate original geometric test fonts. Requires fonttools==4.60.2; not used at runtime."""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

ROOT = Path(__file__).resolve().parent
POINTS = list(range(0x20, 0x370)) + list(range(0x370, 0x400)) + list(range(0x600, 0x700)) + list(range(0x900, 0x980)) + [0x2014, 0x2022, 0x4E2D, 0x6587]
NAMES = {cp: f"uni{cp:04X}" for cp in POINTS}
ORDER = [".notdef"] + list(NAMES.values()) + ["fi", "ffi", "lam_alef", "kssa"]
FEATURES = """
languagesystem DFLT dflt;
languagesystem latn dflt;
languagesystem arab dflt;
languagesystem dev2 dflt;
feature kern { pos uni0041 uni0056 -70; } kern;
feature liga { sub uni0066 uni0069 by fi; sub uni0066 uni0066 uni0069 by ffi; } liga;
feature rlig { script arab; sub uni0644 uni0627 by lam_alef; } rlig;
feature akhn { script dev2; sub uni0915 uni094D uni0937 by kssa; } akhn;
"""
for is_ttf in [True, False]:
    builder = FontBuilder(1000, isTTF=is_ttf)
    builder.setupGlyphOrder(ORDER)
    builder.setupCharacterMap(NAMES)
    glyphs, metrics = {}, {}
    for i, name in enumerate(ORDER):
        width = 450 + i % 100
        pen = TTGlyphPen(None) if is_ttf else T2CharStringPen(width, None)
        if name != "uni0020":
            pen.moveTo((40, 0)); pen.lineTo((width - 40, 0)); pen.lineTo((width - 70, 550 + i % 80)); pen.lineTo((70, 600)); pen.closePath()
        glyphs[name] = pen.glyph() if is_ttf else pen.getCharString()
        metrics[name] = (width, 40 if name != "uni0020" else 0)
    if is_ttf:
        builder.setupGlyf(glyphs)
    else:
        builder.setupCFF("EPUBOptimizerFixture", {"FullName": "EPUB Optimizer Fixture", "FamilyName": "EPUB Optimizer Fixture", "Weight": "Regular"}, glyphs, {})
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "EPUB Optimizer Fixture", "styleName": "Regular", "uniqueFontIdentifier": "epub-optimizer-generated-fixture-1", "fullName": "EPUB Optimizer Fixture Regular", "psName": "EPUBOptimizerFixture-Regular", "version": "Version 1.0", "copyright": "Copyright 2026 EPUB Optimizer contributors", "licenseDescription": (ROOT.parents[2] / "LICENSE").read_text(), "licenseInfoURL": "https://github.com/kiki-le-singe/epub-optimizer/blob/main/LICENSE"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, fsType=0)
    builder.setupPost(keepGlyphNames=True)
    addOpenTypeFeaturesFromString(builder.font, FEATURES)
    builder.font.recalcTimestamp = False
    builder.font["head"].created = builder.font["head"].modified = 3849984000
    builder.save(ROOT / ("fixture.ttf" if is_ttf else "fixture.otf"))
