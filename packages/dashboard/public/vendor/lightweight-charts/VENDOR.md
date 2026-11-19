# Vendored: TradingView Lightweight Charts™ 5.2.1

- Source: https://registry.npmjs.org/lightweight-charts/-/lightweight-charts-5.2.1.tgz, file
  `dist/lightweight-charts.standalone.production.mjs` (self-contained ESM) as `lightweight-charts.mjs`,
  sha256 `1bb1ee79f9d4dd17261b53d930f7a8995748276f80e7ba0e24412b5068062f5f`.
- Byte-identical to the npm tarball file above. The `.d.mts` typings are not copied (the dashboard is plain JavaScript).
- Licence: Apache 2.0 (`LICENSE`), attribution notice in `NOTICE`. Attribution required: "TradingView Lightweight
  Charts™, Copyright (c) 2026 TradingView, Inc." with a link to https://www.tradingview.com/ on the page that shows
  the chart. The chart card carries a visible credit line with that link (`js/chart/price-chart.js`); the library's
  injected logo is off because it adds an inline stylesheet, which a strict CSP rejects.
- Loaded only on the token page (dynamic `import()`), so the other screens never download it.
