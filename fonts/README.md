# Bundled fonts

These fonts are bundled so the fit engine (`src/core/fit`) can measure and
render text deterministically without depending on whatever fonts happen to
be installed on the host OS.

- `NotoSans-Regular.ttf`
- `NotoSans-Bold.ttf`
- `NotoSansSC-Regular.otf`

All three are distributed under the SIL Open Font License, Version 1.1.
The full license text is available at <https://openfontlicense.org/> and is
also included with the upstream Noto releases.
You may use, modify, and redistribute these fonts under the terms of the
OFL; see the license text for the complete terms and conditions.

Sources:

- `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf` -
  <https://github.com/notofonts/NotoSans/raw/main/fonts/ttf/unhinted/instance_ttf/NotoSans-Regular.ttf>
  and
  <https://github.com/notofonts/NotoSans/raw/main/fonts/ttf/unhinted/instance_ttf/NotoSans-Bold.ttf>
  (the `notofonts/latin-greek-cyrillic` path referenced in earlier planning
  docs has moved; `notofonts/NotoSans` is the current per-family repo).
- `NotoSansSC-Regular.otf` -
  <https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf>
