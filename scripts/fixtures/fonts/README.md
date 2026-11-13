# Generated font fixtures

`fixture.ttf` and `fixture.otf` contain original geometric glyphs and minimal Latin,
Arabic and Devanagari substitution rules, created specifically for these tests.
They are covered by the project's MIT license; no system or third-party font is
redistributed. They exercise the actual HarfBuzz engine, not a font mock.

Regenerate using `generate.py` with Python and `fonttools==4.60.2`. FontTools is
only a fixture-authoring tool; normal builds and tests require neither Python nor
FontTools. WOFF/WOFF2 test inputs are generated from these fixtures in memory.

These are deliberately simple fonts. Their substitution tests do not certify the
typographic quality of arbitrary real-world fonts or all reading systems.
