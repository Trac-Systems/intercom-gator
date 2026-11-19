// The price chart. TradingView Lightweight Charts™ (vendored, Apache-2.0) draws it; this module
// owns no arithmetic (see ../lib/chart-format.js, unit-tested) and reads every colour from the
// Key-print tokens so the stylesheet stays the authority. Behaviour: wheel/pinch zoom, drag to pan,
// axis drag, crosshair readout that survives in-chart whitespace, keyboard stepping, theme change
// redrawn in place.
//
// TradingView Lightweight Charts™, Copyright (c) 2026 TradingView, Inc. https://www.tradingview.com/

import {
  createChart, BaselineSeries, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle,
} from '../../vendor/lightweight-charts/lightweight-charts.mjs';
import { priceFormat, tickmarkLabels, timeLabel, crosshairTime } from '../lib/chart-format.js';

const VOLUME_TOP = 0.82;
const PRICE_MARGINS = { top: 0.1, bottom: 0.22 };

/** Resolve any CSS colour (oklch, color-mix, var) to rgba() the library understands. */
function resolver() {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  return {
    /** @param {string} cssVar e.g. '--up' @param {number} [alpha] */
    color(cssVar, alpha = 1) {
      probe.style.color = `var(${cssVar})`;
      const css = getComputedStyle(probe).color;
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = '#000';
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${gg}, ${b}, ${((a / 255) * alpha).toFixed(3)})`;
    },
    done() { probe.remove(); },
  };
}

function palette() {
  const r = resolver();
  const p = {
    up: r.color('--up'), down: r.color('--down'), ink: r.color('--ink'), ink2: r.color('--ink2'), ink3: r.color('--ink3'),
    rule: r.color('--rule'), bg: r.color('--bg'), acc: r.color('--acc'),
    upFill: r.color('--up', 0.26), upFill0: r.color('--up', 0.03), downFill: r.color('--down', 0.26), downFill0: r.color('--down', 0.03),
    upVol: r.color('--up', 0.32), downVol: r.color('--down', 0.32), flatVol: r.color('--ink3', 0.3),
  };
  r.done();
  return p;
}

/**
 * @typedef {{ t: number, o: number, h: number, l: number, c: number, v: number }} Candle
 * @param {HTMLElement} host
 * @param {{ onSelect: (index: number) => void, mono?: string }} opts  index -1 = none (live)
 */
export function createPriceChart(host, opts) {
  let P = palette();
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'ui-monospace, monospace';
  const chart = createChart(host, {
    width: Math.max(1, host.clientWidth),
    height: Math.max(1, host.clientHeight),
    autoSize: false,
    layout: {
      // The card shows a visible TradingView credit link; the injected logo would add an inline stylesheet.
      attributionLogo: false,
      background: { type: ColorType.Solid, color: P.bg },
      fontFamily: mono, fontSize: 10, textColor: P.ink3,
    },
    localization: { locale: 'en-US' },
    grid: { horzLines: { color: P.rule, style: LineStyle.Solid }, vertLines: { visible: false } },
    crosshair: {
      mode: CrosshairMode.Normal,
      horzLine: { color: P.ink3, labelBackgroundColor: P.ink, style: LineStyle.Dashed, width: 1 },
      vertLine: { color: P.ink3, labelBackgroundColor: P.ink, style: LineStyle.Dashed, width: 1 },
    },
    handleScale: { axisDoubleClickReset: { price: true, time: true }, axisPressedMouseMove: { price: true, time: true }, mouseWheel: true, pinch: true },
    // A vertical touch drag belongs to the page so a phone scrolls past the chart.
    handleScroll: { horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true, vertTouchDrag: false },
    kineticScroll: { mouse: false, touch: false },
    leftPriceScale: { visible: false },
    rightPriceScale: { autoScale: true, entireTextOnly: true, borderVisible: false, scaleMargins: { ...PRICE_MARGINS } },
    timeScale: { borderColor: P.rule, rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, secondsVisible: false, timeVisible: true },
  });

  /** @type {any} */ let price = null;
  const volume = chart.addSeries(HistogramSeries, { priceScaleId: '', lastValueVisible: false, priceLineVisible: false, priceFormat: { type: 'volume' } });
  volume.priceScale().applyOptions({ scaleMargins: { top: VOLUME_TOP, bottom: 0 } });

  /** @type {Candle[]} */ let data = [];
  let mode = 'line';
  let bucket = 3600;
  let pointer = false;
  let selected = -1;

  function makeSeries() {
    if (price) chart.removeSeries(price);
    if (mode === 'candle') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: P.up, downColor: P.down, borderUpColor: P.up, borderDownColor: P.down, wickUpColor: P.up, wickDownColor: P.down,
        priceLineColor: P.ink3, priceLineStyle: LineStyle.Dotted,
      });
    } else {
      price = chart.addSeries(BaselineSeries, {
        lineWidth: 2, topLineColor: P.ink2, bottomLineColor: P.ink2,
        topFillColor1: P.upFill, topFillColor2: P.upFill0, bottomFillColor1: P.downFill0, bottomFillColor2: P.downFill,
        priceLineColor: P.ink3, priceLineStyle: LineStyle.Dotted,
        baseLineVisible: true, baseLineColor: P.ink3, baseLineStyle: LineStyle.Dotted, baseLineWidth: 1,
        crosshairMarkerBorderColor: P.bg, crosshairMarkerBackgroundColor: P.ink,
      });
    }
  }

  function write() {
    if (!price) makeSeries();
    const fmt = priceFormat(data);
    price.applyOptions({ priceFormat: fmt });
    chart.applyOptions({ localization: { priceFormatter: fmt.formatter, tickmarksPriceFormatter: tickmarkLabels(fmt.minMove) } });
    if (mode === 'candle') price.setData(data.map((k) => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c })));
    else {
      price.applyOptions({ baseValue: { type: 'price', price: data.length ? data[0].o : 0 } });
      price.setData(data.map((k) => ({ time: k.t, value: k.c })));
    }
    volume.setData(data.map((k) => ({ time: k.t, value: k.v, color: k.c > k.o ? P.upVol : k.c < k.o ? P.downVol : P.flatVol })));
    chart.timeScale().fitContent();
  }

  chart.subscribeCrosshairMove((ev) => {
    const present = ev.point !== undefined;
    pointer = present;
    if (!present) { if (selected !== -1) { selected = -1; opts.onSelect(-1); } return; }
    // The library briefly omits `time` over whitespace and wicks: keep the current reading then.
    if (ev.time === undefined) return;
    const i = data.findIndex((k) => k.t === Number(ev.time));
    if (i >= 0 && i !== selected) { selected = i; opts.onSelect(i); }
  });

  const ro = new ResizeObserver(() => chart.applyOptions({ width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) }));
  ro.observe(host);

  function onTheme() {
    P = palette();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: P.bg }, textColor: P.ink3 },
      grid: { horzLines: { color: P.rule } },
      crosshair: { horzLine: { color: P.ink3, labelBackgroundColor: P.ink }, vertLine: { color: P.ink3, labelBackgroundColor: P.ink } },
      timeScale: { borderColor: P.rule },
    });
    const range = chart.timeScale().getVisibleLogicalRange();
    makeSeries();
    write();
    if (range) chart.timeScale().setVisibleLogicalRange(range);
  }
  document.addEventListener('gator:theme', onTheme);

  return {
    /** @param {Candle[]} candles @param {number} bucketSeconds @param {'line'|'candle'} m */
    set(candles, bucketSeconds, m) {
      const modeChanged = m !== mode || !price;
      data = candles; bucket = bucketSeconds; mode = m; selected = -1;
      chart.applyOptions({
        localization: { timeFormatter: (/** @type {number} */ t) => crosshairTime(Number(t), bucket) },
        timeScale: { timeVisible: bucket < 86400, tickMarkFormatter: (/** @type {number} */ t) => timeLabel(Number(t), bucket) },
      });
      if (modeChanged) makeSeries();
      write();
    },
    /** Keyboard selection: place the crosshair on a candle (only while the pointer is elsewhere). @param {number} i */
    select(i) {
      selected = i;
      if (pointer) return;
      if (i < 0 || !data[i]) { chart.clearCrosshairPosition(); return; }
      chart.setCrosshairPosition(data[i].c, /** @type {any} */ (data[i].t), price);
    },
    destroy() {
      document.removeEventListener('gator:theme', onTheme);
      ro.disconnect();
      chart.remove();
    },
  };
}
