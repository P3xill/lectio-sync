# Lectio Sync store asset pack

Final exports are in `exports/` and can be regenerated with:

```sh
node scripts/render-store-assets.mjs
```

`exports/manifest.json` records the exact dimensions and SHA-256 digest of every delivered asset.

## Export map

| File | Size | Intended use |
| --- | ---: | --- |
| `browser-store-screenshot-1280x800.png` | 1280×800 | Chrome Web Store and Firefox listing screenshot |
| `mac-app-store-screenshot-1280x800.png` | 1280×800 | Mac App Store screenshot |
| `chrome-small-promo-440x280.png` | 440×280 | Chrome Web Store small promotional tile |
| `chrome-marquee-1400x560.png` | 1400×560 | Chrome Web Store marquee tile |
| `social-preview-1200x630.png` | 1200×630 | Product-page social preview |
| `store-icon-128.png` | 128×128 | Browser-store icon |

## Provenance

- Product UI: captured from the locally signed Lectio Sync 0.2.0 Safari extension on 2026-08-15, then cropped to remove all Lectio account and timetable information.
- Logo: repository asset `public/icons/icon-128.png`.
- Copy and composition: deterministic HTML/CSS in `render/index.html`.
- No student identifiers, timetable entries, OAuth data, cookies, or account details are present in the final exports.
