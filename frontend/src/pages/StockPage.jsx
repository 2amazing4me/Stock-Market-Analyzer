import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createChart } from "lightweight-charts";
import HeaderBar from "../components/HeaderBar";
import { formatChartTime, normalizeTicker } from "../lib/tradingview";

const TIMEFRAME_OPTIONS = [
  { label: "5 minutes", shortLabel: "5m", value: "5m", group: "Minutes" },
  { label: "10 minutes", shortLabel: "10m", value: "10m", group: "Minutes" },
  { label: "15 minutes", shortLabel: "15m", value: "15m", group: "Minutes" },
  { label: "30 minutes", shortLabel: "30m", value: "30m", group: "Minutes" },
  { label: "45 minutes", shortLabel: "45m", value: "45m", group: "Minutes" },
  { label: "1 hour", shortLabel: "1h", value: "1h", group: "Hours" },
  { label: "2 hours", shortLabel: "2h", value: "2h", group: "Hours" },
  { label: "3 hours", shortLabel: "3h", value: "3h", group: "Hours" },
  { label: "4 hours", shortLabel: "4h", value: "4h", group: "Hours" },
  { label: "1 day", shortLabel: "1D", value: "1d", group: "Days" },
  { label: "1 week", shortLabel: "1W", value: "1w", group: "Weeks" },
  { label: "1 month", shortLabel: "1M", value: "1mo", group: "Months" },
  { label: "3 months", shortLabel: "3M", value: "3mo", group: "Months" },
  { label: "6 months", shortLabel: "6M", value: "6mo", group: "Months" },
  { label: "12 months", shortLabel: "12M", value: "12mo", group: "Months" },
];

const INDICATOR_TYPES = [
  { type: "VOLUME", name: "Volume", description: "Volume histogram overlaid on the price chart." },
  { type: "SMA", name: "Simple Moving Average", description: "Average close over a period." },
  { type: "EMA", name: "Exponential Moving Average", description: "Moving average weighted toward recent closes." },
  { type: "WMA", name: "Weighted Moving Average", description: "Linearly weighted moving average." },
  { type: "VWAP", name: "Volume Weighted Average Price", description: "Price weighted by traded volume." },
  { type: "RSI", name: "Relative Strength Index", description: "Momentum oscillator in its own pane." },
  { type: "MACD", name: "Moving Average Convergence Divergence", description: "MACD, signal, and histogram pane." },
  { type: "BBANDS", name: "Bollinger Bands", description: "Upper, middle, and lower volatility bands." },
];
const TV_COLORS = {
  aqua: "#00BCD4",
  blue: "#2196F3",
  fuchsia: "#E040FB",
  gray: "#787B86",
  orange: "#FF9800",
  purple: "#9C27B0",
  red: "#F23645",
  silver: "#B2B5BE",
  teal: "#089981",
  yellow: "#FDD835",
};

const DEFAULT_INDICATOR_STYLES = {
  VOLUME: { color: TV_COLORS.gray, upColor: TV_COLORS.teal, downColor: TV_COLORS.red },
  SMA: { color: TV_COLORS.blue },
  EMA: { color: TV_COLORS.orange },
  WMA: { color: TV_COLORS.purple },
  VWAP: { color: TV_COLORS.blue, bandColor: "#00E676", fillColor: "#00E676" },
  RSI: { color: TV_COLORS.purple, maColor: TV_COLORS.yellow },
  MACD: {
    color: TV_COLORS.blue,
    signalColor: TV_COLORS.orange,
    histogramUpColor: TV_COLORS.teal,
    histogramDownColor: TV_COLORS.red,
  },
  BBANDS: {
    color: TV_COLORS.blue,
    upperColor: TV_COLORS.blue,
    middleColor: TV_COLORS.orange,
    lowerColor: TV_COLORS.blue,
  },
};

const FALLBACK_INDICATOR_COLORS = [
  TV_COLORS.blue,
  TV_COLORS.orange,
  TV_COLORS.purple,
  TV_COLORS.aqua,
  TV_COLORS.yellow,
  TV_COLORS.fuchsia,
  TV_COLORS.silver,
  TV_COLORS.teal,
];

const MIN_BAR_SPACING = 4;
const SCREEN_BUFFER_MULTIPLIER = 3;
const LOAD_EDGE_THRESHOLD_RATIO = 0.35;
const MIN_INITIAL_BARS = 300;
const MAX_INITIAL_BARS = 1200;
const MIN_BATCH_BARS = 150;
const MAX_BATCH_BARS = 800;

const PRICE_PANE_MIN_HEIGHT = 240;
const RSI_PANE_MIN_HEIGHT = 90;
const MACD_PANE_MIN_HEIGHT = 100;

const RIGHT_PRICE_SCALE_WIDTH = 82;
const CROSSHAIR_LABEL_BACKGROUND = "#263244";
const LINE_WIDTH_OPTIONS = [1, 2, 3, 4];

function clampPeriod(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(2, Math.min(parsed, 400));
}

function clampPositiveInt(value, fallback = null, min = 1, max = 400) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function clampFloat(value, fallback = null, min = 0.1, max = 10) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function indicatorNeedsPeriod(type) {
  return type !== "VOLUME";
}

function hasIndicator(indicators, type) {
  return indicators.some((indicator) => indicator.type === type);
}

function defaultPeriodForIndicator(type) {
  if (type === "VOLUME") {
    return null;
  }
  if (type === "SMA") {
    return 200;
  }
  if (type === "RSI") {
    return 14;
  }
  if (type === "MACD") {
    return 12;
  }
  if (type === "BBANDS") {
    return 20;
  }
  if (type === "VWAP") {
    return 20;
  }
  return 20;
}

function defaultIndicatorTimeframe(type) {
  if (type === "VOLUME") {
    return "chart";
  }
  return "chart";
}

function defaultColorForIndicator(type, index = 0) {
  return DEFAULT_INDICATOR_STYLES[type]?.color || FALLBACK_INDICATOR_COLORS[index % FALLBACK_INDICATOR_COLORS.length];
}

function pickColor(index) {
  return FALLBACK_INDICATOR_COLORS[index % FALLBACK_INDICATOR_COLORS.length];
}

function effectiveIndicatorColor(type, color, index = 0) {
  if (type === "VWAP" && color === TV_COLORS.aqua) {
    return DEFAULT_INDICATOR_STYLES.VWAP.color;
  }
  return color || defaultColorForIndicator(type, index);
}

function effectiveVwapBandColor(color) {
  if (!color || color === TV_COLORS.silver) {
    return DEFAULT_INDICATOR_STYLES.VWAP.bandColor;
  }
  return color;
}

function timeframeShortLabel(value) {
  return TIMEFRAME_OPTIONS.find((option) => option.value === value)?.shortLabel || value;
}

function groupedTimeframes() {
  return TIMEFRAME_OPTIONS.reduce((groups, option) => {
    const current = groups.get(option.group) || [];
    current.push(option);
    groups.set(option.group, current);
    return groups;
  }, new Map());
}

function formatPrice(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toFixed(2);
}

function formatVolume(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatCandleChange(candle) {
  if (!candle || candle.open === null || candle.open === undefined || candle.close === null || candle.close === undefined) {
    return "-";
  }

  const open = Number(candle.open);
  const close = Number(candle.close);

  if (!Number.isFinite(open) || !Number.isFinite(close)) {
    return "-";
  }

  const diff = close - open;
  const pct = open === 0 ? 0 : (diff / open) * 100;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}

function colorWithAlpha(color, alpha) {
  if (typeof color === "string" && color.startsWith("#")) {
    const hex = color.slice(1);
    const normalized = hex.length === 3
      ? hex.split("").map((char) => `${char}${char}`).join("")
      : hex;

    if (normalized.length === 6) {
      const red = Number.parseInt(normalized.slice(0, 2), 16);
      const green = Number.parseInt(normalized.slice(2, 4), 16);
      const blue = Number.parseInt(normalized.slice(4, 6), 16);
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }
  }

  return color;
}

function normalizeCrosshairTime(rawTime) {
  if (rawTime === null || rawTime === undefined) {
    return null;
  }
  if (typeof rawTime === "number") {
    return rawTime;
  }
  if (typeof rawTime === "object" && "year" in rawTime && "month" in rawTime && "day" in rawTime) {
    return Math.floor(Date.UTC(rawTime.year, rawTime.month - 1, rawTime.day) / 1000);
  }
  return null;
}

function getCandleTone(candle) {
  if (!candle) {
    return "flat";
  }
  return candle.close >= candle.open ? "up" : "down";
}

function findAnchorIndexByTime(candles, targetTime) {
  if (!candles.length) {
    return 0;
  }

  let low = 0;
  let high = candles.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid].time <= targetTime) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer;
}

function utcDateKey(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

function findAnchorIndexAcrossTimeframes(candles, targetTime, fromTimeframe, toTimeframe) {
  if (!candles.length) {
    return 0;
  }

  const targetDateKey = utcDateKey(targetTime);

  // When switching between daily and intraday, anchoring purely by timestamp
  // can be wrong because daily candles are usually timestamped at midnight.
  // In that case, prefer the last candle from the same calendar date.
  if (fromTimeframe === "1d" || toTimeframe === "1d") {
    let sameDayIndex = -1;

    candles.forEach((bar, index) => {
      if (utcDateKey(bar.time) === targetDateKey) {
        sameDayIndex = index;
      }
    });

    if (sameDayIndex !== -1) {
      return sameDayIndex;
    }
  }

  return findAnchorIndexByTime(candles, targetTime);
}

function uniqueSortedCandles(candles) {
  const byTime = new Map();

  candles.forEach((candle) => {
    byTime.set(candle.time, candle);
  });

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function estimateScreenBars(container) {
  const width = container?.clientWidth || 1200;
  return Math.ceil(width / MIN_BAR_SPACING);
}

function estimateInitialLimit(container) {
  const screenBars = estimateScreenBars(container);
  return Math.max(
    MIN_INITIAL_BARS,
    Math.min(MAX_INITIAL_BARS, Math.ceil(screenBars * SCREEN_BUFFER_MULTIPLIER)),
  );
}

function estimateBatchLimit(container) {
  const screenBars = estimateScreenBars(container);
  return Math.max(
    MIN_BATCH_BARS,
    Math.min(MAX_BATCH_BARS, Math.ceil(screenBars)),
  );
}

function rsiPriceFormatter(value) {
  return Number(value).toFixed(2);
}

function macdPriceFormatter(value) {
  const absValue = Math.abs(Number(value));

  if (absValue >= 10) {
    return Number(value).toFixed(2);
  }

  if (absValue >= 1) {
    return Number(value).toFixed(3);
  }

  return Number(value).toFixed(4);
}

function priceFormatter(value) {
  return Number(value).toFixed(2);
}

function createConstantLine(points, value) {
  return points.map((point) => ({
    time: point.time,
    value,
  }));
}

function createPaneAnchorData(candles, value = 0) {
  return candles.map((point) => ({
    time: point.time,
    value,
  }));
}

function hasVisibleIndicator(indicators, type) {
  return indicators.some((indicator) => indicator.type === type && indicator.visible);
}

function createBaseChart(container, options = {}) {
  return createChart(container, {
    autoSize: true,
    layout: {
      background: { color: "#040507" },
      textColor: "#a4adbc",
    },
    grid: {
      vertLines: { color: "#10131a" },
      horzLines: { color: "#10131a" },
    },
    rightPriceScale: {
      borderColor: "#1c212d",
      visible: true,
      autoScale: true,
      minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
    },
    localization: {
      timeFormatter: (time) => formatChartTime(normalizeCrosshairTime(time), options.timeframe),
    },
    timeScale: {
      borderColor: "#1c212d",
      timeVisible: true,
      minBarSpacing: MIN_BAR_SPACING,
      visible: options.timeScaleVisible ?? true,
    },
    handleScale: true,
    handleScroll: true,
    crosshair: {
      mode: 0,
      vertLine: {
        color: "rgba(164, 173, 188, 0)",
        labelVisible: options.timeScaleVisible ?? true,
        labelBackgroundColor: CROSSHAIR_LABEL_BACKGROUND,
      },
      horzLine: {
        color: "#2a3142",
        labelBackgroundColor: CROSSHAIR_LABEL_BACKGROUND,
      },
    },
  });
}

function updatePaneReadyState(chartsRef, setPaneReady) {
  const nextReady = {
    volume: Boolean(chartsRef.current.volume),
    rsi: Boolean(chartsRef.current.rsi),
    macd: Boolean(chartsRef.current.macd),
  };

  setPaneReady((current) => {
    if (
      current.volume === nextReady.volume &&
      current.rsi === nextReady.rsi &&
      current.macd === nextReady.macd
    ) {
      return current;
    }

    return nextReady;
  });
}

function formatVolumeScale(value) {
  const number = Number(value);

  if (Math.abs(number) >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1)}M`;
  }

  if (Math.abs(number) >= 1_000) {
    return `${(number / 1_000).toFixed(0)}K`;
  }

  return number.toFixed(0);
}

function paneElementForChart(sourceChart, chartsRef, refs) {
  if (sourceChart === chartsRef.current.price) {
    return refs.price.current;
  }

  if (sourceChart === chartsRef.current.volume) {
    return refs.volume.current;
  }

  if (sourceChart === chartsRef.current.rsi) {
    return refs.rsi.current;
  }

  if (sourceChart === chartsRef.current.macd) {
    return refs.macd.current;
  }

  return null;
}

function getActiveCharts(chartsRef) {
  return Object.values(chartsRef.current).filter(Boolean);
}

function syncChartsToLogicalRange(chartsRef, sourceChart, range, chartSyncingRef = null) {
  if (!range) {
    return;
  }

  if (chartSyncingRef) {
    chartSyncingRef.current = true;
  }

  getActiveCharts(chartsRef).forEach((targetChart) => {
    if (targetChart !== sourceChart) {
      targetChart.timeScale().setVisibleLogicalRange(range);
    }
  });

  if (chartSyncingRef) {
    chartSyncingRef.current = false;
  }
}

function setAllChartsLogicalRange(chartsRef, range, chartSyncingRef = null) {
  if (!range) {
    return;
  }

  if (chartSyncingRef) {
    chartSyncingRef.current = true;
  }

  getActiveCharts(chartsRef).forEach((chart) => {
    chart.timeScale().setVisibleLogicalRange(range);
  });

  if (chartSyncingRef) {
    chartSyncingRef.current = false;
  }
}

function getPrimaryLogicalRange(chartsRef) {
  const activeCharts = getActiveCharts(chartsRef);

  for (const chart of activeCharts) {
    const range = chart.timeScale().getVisibleLogicalRange();

    if (
      range &&
      Number.isFinite(range.from) &&
      Number.isFinite(range.to)
    ) {
      return range;
    }
  }

  return null;
}

function preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef) {
  const range = getPrimaryLogicalRange(chartsRef);

  if (range) {
    preservedLogicalRangeRef.current = {
      from: range.from,
      to: range.to,
    };
  }

  return preservedLogicalRangeRef.current;
}

function restorePreservedLogicalRange(chartsRef, preservedLogicalRangeRef, chartSyncingRef = null) {
  const range = preservedLogicalRangeRef.current;

  if (!range) {
    return;
  }

  setAllChartsLogicalRange(chartsRef, range, chartSyncingRef);
}

function setAllChartsTimeScaleVisibility(chartsRef) {
  const { price, volume, rsi, macd } = chartsRef.current;

  const visibleTimeScaleChart = macd || rsi || volume || price;

  [price, volume, rsi, macd].forEach((chart) => {
    if (!chart) {
      return;
    }

    const isVisibleTimeScale = chart === visibleTimeScaleChart;

    chart.timeScale().applyOptions({
      visible: isVisibleTimeScale,
    });
    chart.applyOptions({
      crosshair: {
        vertLine: {
          labelVisible: isVisibleTimeScale,
          labelBackgroundColor: CROSSHAIR_LABEL_BACKGROUND,
        },
        horzLine: {
          labelBackgroundColor: CROSSHAIR_LABEL_BACKGROUND,
        },
      },
    });
  });
}

function setAllChartsTimeFormatter(chartsRef, timeframe) {
  getActiveCharts(chartsRef).forEach((chart) => {
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => formatChartTime(normalizeCrosshairTime(time), timeframe),
      },
    });
  });
}

function volumeBarsFromCandles(candles) {
  return candles.map((bar) => ({
    time: bar.time,
    value: bar.volume,
    color: colorWithAlpha(bar.close >= bar.open ? TV_COLORS.teal : TV_COLORS.red, 0.24),
  }));
}

function alignPointsToChartCandles(points, candles) {
  if (!points?.length || !candles.length) {
    return [];
  }

  const sortedPoints = [...points].sort((a, b) => a.time - b.time);
  const aligned = [];
  let pointIndex = 0;
  let currentPoint = null;

  candles.forEach((candle) => {
    while (pointIndex < sortedPoints.length && sortedPoints[pointIndex].time <= candle.time) {
      currentPoint = sortedPoints[pointIndex];
      pointIndex += 1;
    }

    if (currentPoint && Number.isFinite(Number(currentPoint.value))) {
      aligned.push({
        time: candle.time,
        value: currentPoint.value,
      });
    }
  });

  return aligned;
}

function alignIndicatorOutputToChartCandles(output, candles) {
  return {
    ...output,
    lines: (output.lines || []).map((line) => ({
      ...line,
      points: alignPointsToChartCandles(line.points || [], candles),
    })),
  };
}

function pointsByTime(points = []) {
  return new Map(points.map((point) => [point.time, point]));
}

function findIndicatorLine(indicator, matcher) {
  return indicator.lines.find((line) => matcher(line.label));
}

function removeAllIndicatorSeries(seriesRef) {
  const indicatorSeriesMap = seriesRef.current.indicators;

  indicatorSeriesMap.forEach((entries) => {
    entries.forEach((entry) => {
      try {
        entry.chart.removeSeries(entry.series);
      } catch {
        // ignore stale series
      }
    });
  });

  indicatorSeriesMap.clear();
}

function chartKeyForChart(chart, chartsRef) {
  if (chart === chartsRef.current.price) {
    return "price";
  }

  if (chart === chartsRef.current.volume) {
    return "volume";
  }

  if (chart === chartsRef.current.rsi) {
    return "rsi";
  }

  if (chart === chartsRef.current.macd) {
    return "macd";
  }

  return null;
}

function indicatorTypeForChartKey(chartKey) {
  if (chartKey === "rsi") {
    return "RSI";
  }

  if (chartKey === "macd") {
    return "MACD";
  }

  return null;
}

function indicatorCrosshairTarget(chartKey, time, resolvedIndicators, seriesRef) {
  const indicatorType = indicatorTypeForChartKey(chartKey);

  if (!indicatorType) {
    return null;
  }

  for (const indicator of resolvedIndicators) {
    if (!indicator.visible || indicator.type !== indicatorType) {
      continue;
    }

    const entries = seriesRef.current.indicators.get(indicator.id) || [];

    for (let lineIndex = 0; lineIndex < indicator.lines.length; lineIndex += 1) {
      const line = indicator.lines[lineIndex];
      const value = line.valuesByTime.get(time);
      const entry = entries.find((candidate) => candidate.lineIndex === lineIndex);

      if (entry?.series && value !== undefined && Number.isFinite(Number(value))) {
        return {
          series: entry.series,
          value: Number(value),
        };
      }
    }
  }

  return null;
}

function crosshairTargetForChart(chart, time, chartsRef, seriesRef, candleByTime, resolvedIndicators) {
  const chartKey = chartKeyForChart(chart, chartsRef);

  if (!chartKey) {
    return null;
  }

  const candle = candleByTime.get(time);

  if (chartKey === "price" && candle && seriesRef.current.candles) {
    return {
      series: seriesRef.current.candles,
      value: candle.close,
    };
  }

  if (chartKey === "volume" && candle && seriesRef.current.volume) {
    return {
      series: seriesRef.current.volume,
      value: candle.volume,
    };
  }

  return indicatorCrosshairTarget(chartKey, time, resolvedIndicators, seriesRef);
}

function mirrorCrosshairToCharts(sourceChart, rawTime, chartsRef, seriesRef, candleByTime, resolvedIndicators, crosshairSyncingRef) {
  const time = normalizeCrosshairTime(rawTime);

  if (crosshairSyncingRef) {
    crosshairSyncingRef.current = true;
  }

  if (!time) {
    getActiveCharts(chartsRef).forEach((chart) => {
      if (chart !== sourceChart) {
        chart.clearCrosshairPosition();
      }
    });

    if (crosshairSyncingRef) {
      window.requestAnimationFrame(() => {
        crosshairSyncingRef.current = false;
      });
    }
    return;
  }

  getActiveCharts(chartsRef).forEach((targetChart) => {
    if (targetChart === sourceChart) {
      return;
    }

    const target = crosshairTargetForChart(
      targetChart,
      time,
      chartsRef,
      seriesRef,
      candleByTime,
      resolvedIndicators,
    );

    if (target) {
      targetChart.setCrosshairPosition(target.value, time, target.series);
    } else {
      targetChart.clearCrosshairPosition();
    }
  });

  if (crosshairSyncingRef) {
    window.requestAnimationFrame(() => {
      crosshairSyncingRef.current = false;
    });
  }
}

function indicatorChipLabel(indicator) {
  const timeframeSuffix = indicator.timeframeMode === "fixed" && indicator.indicatorTimeframe !== "chart"
    ? ` ${timeframeShortLabel(indicator.indicatorTimeframe)}`
    : "";
  if (indicator.type === "VOLUME") {
    return "Volume";
  }
  if (indicator.type === "VWAP") {
    return `VWAP${timeframeSuffix}`;
  }
  if (indicator.type === "MACD") {
    const fast = indicator.period || 12;
    const slow = indicator.slowPeriod || Math.max(fast + 1, Math.round(fast * 2.2));
    const signal = indicator.signalPeriod || 9;
    return `MACD ${fast}/${slow}/${signal}${timeframeSuffix}`;
  }
  return `${indicator.type} ${indicator.period}${timeframeSuffix}`;
}

function indicatorPlacement(indicator) {
  if (indicator.type === "RSI") {
    return "rsi";
  }
  if (indicator.type === "MACD") {
    return "macd";
  }
  return "price";
}

function createIndicatorDraft(type, index = 0, source = null) {
  const period = source?.period ?? defaultPeriodForIndicator(type);
  const slowPeriod = source?.slowPeriod ?? (type === "MACD" ? Math.max(13, Math.round((period || 12) * 2.2)) : "");
  const style = DEFAULT_INDICATOR_STYLES[type] || {};
  const selectedTimeframe = source?.timeframeMode === "fixed"
    ? source?.indicatorTimeframe || "1d"
    : defaultIndicatorTimeframe(type);
  return {
    id: source?.id ?? null,
    type,
    period: period === null ? "" : String(period),
    color: effectiveIndicatorColor(type, source?.color || style.color, index),
    maPeriod: String(source?.maPeriod ?? (type === "RSI" ? period : "")),
    maColor: source?.maColor || style.maColor || TV_COLORS.yellow,
    slowPeriod: slowPeriod === "" ? "" : String(slowPeriod),
    signalPeriod: String(source?.signalPeriod ?? (type === "MACD" ? 9 : "")),
    signalColor: source?.signalColor || style.signalColor || TV_COLORS.orange,
    histogramUpColor: source?.histogramUpColor || style.histogramUpColor || TV_COLORS.teal,
    histogramDownColor: source?.histogramDownColor || style.histogramDownColor || TV_COLORS.red,
    stdDev: String(source?.stdDev ?? (type === "BBANDS" ? 2 : "")),
    upperColor: source?.upperColor || style.upperColor || TV_COLORS.blue,
    middleColor: source?.middleColor || style.middleColor || source?.color || defaultColorForIndicator(type, index),
    lowerColor: source?.lowerColor || style.lowerColor || TV_COLORS.blue,
    bandColor: type === "VWAP" ? effectiveVwapBandColor(source?.bandColor || style.bandColor) : source?.bandColor || style.bandColor || TV_COLORS.silver,
    indicatorTimeframe: selectedTimeframe,
    lineWidth: String(source?.lineWidth || 1),
  };
}

function indicatorTypeMeta(type) {
  return INDICATOR_TYPES.find((indicator) => indicator.type === type);
}

function EyeIcon({ open }) {
  if (!open) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 3l14 14" />
        <path d="M8.1 5.4A7.8 7.8 0 0 1 10 5c4 0 7 4 7 5a8.7 8.7 0 0 1-2.2 2.8" />
        <path d="M11.7 11.7A2.4 2.4 0 0 1 6.6 8.6" />
        <path d="M5.8 7.1C4.1 8.2 3 9.5 3 10c0 1 3 5 7 5 1 0 2-.2 2.9-.6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 10c0-1 3-5 7-5s7 4 7 5-3 5-7 5-7-4-7-5Z" />
      <circle cx="10" cy="10" r="2.3" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="2.7" />
      <path d="M10 2.7v2M10 15.3v2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M2.7 10h2M15.3 10h2M4.8 15.2l1.4-1.4M13.8 6.2l1.4-1.4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  );
}

function resolveLineColor(indicatorType, label, baseColor, lineIndex, config = {}) {
  if (indicatorType === "MACD") {
    if (label === "Signal") {
      return config.signalColor || DEFAULT_INDICATOR_STYLES.MACD.signalColor;
    }
    if (label === "Histogram") {
      return TV_COLORS.silver;
    }
    return baseColor;
  }

  if (indicatorType === "RSI" && lineIndex === 1) {
    return config.maColor || DEFAULT_INDICATOR_STYLES.RSI.maColor;
  }

  if (indicatorType === "BBANDS") {
    if (lineIndex === 0) {
      return config.upperColor || DEFAULT_INDICATOR_STYLES.BBANDS.upperColor;
    }
    if (lineIndex === 1) {
      return config.middleColor || baseColor;
    }
    if (lineIndex === 2) {
      return config.lowerColor || DEFAULT_INDICATOR_STYLES.BBANDS.lowerColor;
    }
  }

  if (indicatorType === "VWAP") {
    if (lineIndex === 1 || lineIndex === 2) {
      return effectiveVwapBandColor(config.bandColor);
    }
  }

  return baseColor;
}

export default function StockPage() {
  const navigate = useNavigate();
  const { ticker: routeTicker } = useParams();
  const ticker = normalizeTicker(decodeURIComponent(routeTicker || ""));

  const [timeframe, setTimeframe] = useState("1d");
  const [chartError, setChartError] = useState("");
  const [indicatorError, setIndicatorError] = useState("");
  const [loading, setLoading] = useState(false);
  const [candles, setCandles] = useState([]);
  const [cursorTime, setCursorTime] = useState(null);

  const [timeframeMenuOpen, setTimeframeMenuOpen] = useState(false);
  const [indicatorPickerOpen, setIndicatorPickerOpen] = useState(false);
  const [indicatorSettingsOpen, setIndicatorSettingsOpen] = useState(false);
  const [indicatorDraft, setIndicatorDraft] = useState(() => createIndicatorDraft("SMA", 0));
  const [paneHeights, setPaneHeights] = useState({ rsi: 140, macd: 150 });

  const [indicators, setIndicators] = useState([
    { id: "volume-default", type: "VOLUME", period: null, color: DEFAULT_INDICATOR_STYLES.VOLUME.color, lineWidth: 1, visible: true, timeframeMode: "chart", indicatorTimeframe: "chart" },
    { id: "sma-200-default", type: "SMA", period: 200, color: DEFAULT_INDICATOR_STYLES.SMA.color, lineWidth: 1, visible: true, timeframeMode: "chart", indicatorTimeframe: "chart" },
  ]);
  const [indicatorOutputs, setIndicatorOutputs] = useState([]);
  const [paneReady, setPaneReady] = useState({
    volume: false,
    rsi: false,
    macd: false,
  });

  const shellRef = useRef(null);
  const priceContainerRef = useRef(null);
  const vwapFillCanvasRef = useRef(null);
  const rsiContainerRef = useRef(null);
  const macdContainerRef = useRef(null);

  const chartsRef = useRef({
    price: null,
    volume: null,
    rsi: null,
    macd: null,
  });
  const chartSyncingRef = useRef(false);
  const crosshairSyncingRef = useRef(false);
  const pendingPaneInitRef = useRef(null);
  const sharedCrosshairRef = useRef(null);
  const lastCrosshairTimeRef = useRef(null);
  const lastCrosshairSourceRef = useRef(null);
  const lastCrosshairPointRef = useRef(null);
  const preservedLogicalRangeRef = useRef(null);
  const lastLoadedMetaRef = useRef({ ticker: "", timeframe: "" });
  const viewportSnapshotRef = useRef(null);
  const seriesRef = useRef({
    candles: null,
    volume: null,
    paneAnchors: {
      rsi: null,
      macd: null,
    },
    indicators: new Map(),
  });
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadedBoundsRef = useRef({ first: null, last: null });

  const normalizedTicker = useMemo(() => normalizeTicker(ticker), [ticker]);

  const indicatorConfigById = useMemo(
    () => new Map(indicators.map((indicator) => [indicator.id, indicator])),
    [indicators],
  );

  const resolvedIndicators = useMemo(
    () =>
      indicatorOutputs.map((output, outputIndex) => {
        const config = indicatorConfigById.get(output.id);
        const baseColor = effectiveIndicatorColor(output.type, config?.color, outputIndex);
        const lineWidth = config?.lineWidth || 1;
        const visible = config?.visible ?? true;

        const lines = (output.lines || []).map((line, lineIndex) => {
          const color = resolveLineColor(output.type, line.label, baseColor, lineIndex, config);
          const valuesByTime = new Map((line.points || []).map((point) => [point.time, point.value]));
          return {
            ...line,
            color,
            valuesByTime,
          };
        });

        return {
          ...output,
          visible,
          baseColor,
          lineWidth,
          histogramUpColor: config?.histogramUpColor || DEFAULT_INDICATOR_STYLES.MACD.histogramUpColor,
          histogramDownColor: config?.histogramDownColor || DEFAULT_INDICATOR_STYLES.MACD.histogramDownColor,
          lines,
        };
      }),
    [indicatorOutputs, indicatorConfigById],
  );

  const showRsiPane = useMemo(() => hasIndicator(indicators, "RSI"), [indicators]);

  const showMacdPane = useMemo(() => hasIndicator(indicators, "MACD"), [indicators]);

  const showVolume = useMemo(() => hasVisibleIndicator(indicators, "VOLUME"), [indicators]);

  const candleByTime = useMemo(() => {
    const map = new Map();
    candles.forEach((bar) => {
      map.set(bar.time, bar);
    });
    return map;
  }, [candles]);

  const cursorSnapshot = useMemo(() => {
    const fallbackTime = candles.length ? candles[candles.length - 1].time : null;
    const resolvedTime = cursorTime && candleByTime.has(cursorTime) ? cursorTime : fallbackTime;
    const candle = resolvedTime ? candleByTime.get(resolvedTime) : null;

    return {
      time: resolvedTime,
      candle,
    };
  }, [candles, candleByTime, cursorTime]);

  const indicatorSummaries = useMemo(
    () =>
      indicators.map((indicator) => {
        if (indicator.type === "VOLUME") {
          return {
            ...indicator,
            placement: "price",
            values: indicator.visible && cursorSnapshot.candle
              ? [{ id: `${indicator.id}-volume`, value: formatVolume(cursorSnapshot.candle.volume), color: cursorSnapshot.candle.close >= cursorSnapshot.candle.open ? TV_COLORS.teal : TV_COLORS.red }]
              : [],
          };
        }

        const resolved = resolvedIndicators.find((candidate) => candidate.id === indicator.id);
        const values = resolved?.lines
          .map((line) => {
            const value = cursorSnapshot.time ? line.valuesByTime.get(cursorSnapshot.time) : undefined;
            return {
              id: `${indicator.id}-${line.id}`,
              value: formatPrice(value),
              color: line.color,
            };
          }) || [];

        return {
          ...indicator,
          placement: indicatorPlacement(indicator),
          values: indicator.visible ? values : [],
        };
      }),
    [indicators, cursorSnapshot, resolvedIndicators],
  );

  const indicatorSummariesByPane = useMemo(
    () => ({
      price: indicatorSummaries.filter((indicator) => indicator.placement === "price"),
      rsi: indicatorSummaries.filter((indicator) => indicator.placement === "rsi"),
      macd: indicatorSummaries.filter((indicator) => indicator.placement === "macd"),
    }),
    [indicatorSummaries],
  );

  const candleTone = useMemo(() => getCandleTone(cursorSnapshot.candle), [cursorSnapshot.candle]);

  const timeframeGroups = useMemo(() => Array.from(groupedTimeframes().entries()), []);

  const activeIndicatorMeta = useMemo(
    () => indicatorTypeMeta(indicatorDraft.type),
    [indicatorDraft.type],
  );

  useEffect(() => {
    if (!priceContainerRef.current) {
      return undefined;
    }

    const priceChart = createBaseChart(priceContainerRef.current, {
      timeScaleVisible: !showRsiPane && !showMacdPane,
      timeframe,
    });

    const candleSeries = priceChart.addCandlestickSeries({
      upColor: TV_COLORS.teal,
      downColor: TV_COLORS.red,
      borderUpColor: TV_COLORS.teal,
      borderDownColor: TV_COLORS.red,
      wickUpColor: TV_COLORS.teal,
      wickDownColor: TV_COLORS.red,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    const volumeSeries = priceChart.addHistogramSeries({
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: "custom",
        formatter: formatVolumeScale,
      },
    });

    priceChart.priceScale("volume").applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
      visible: false,
    });

    chartsRef.current.price = priceChart;
    seriesRef.current.candles = candleSeries;
    seriesRef.current.volume = volumeSeries;

    return () => {
      priceChart.remove();

      chartsRef.current = {
        price: null,
        volume: null,
        rsi: null,
        macd: null,
      };

      seriesRef.current = {
        candles: null,
        volume: null,
        paneAnchors: {
          rsi: null,
          macd: null,
        },
        indicators: new Map(),
      };
    };
  }, []);

  useEffect(() => {
    if (pendingPaneInitRef.current) {
      window.cancelAnimationFrame(pendingPaneInitRef.current);
    }

    pendingPaneInitRef.current = window.requestAnimationFrame(() => {
      const existingRange =
        preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef) ||
        chartsRef.current.price?.timeScale().getVisibleLogicalRange();

      seriesRef.current.volume?.applyOptions({ visible: showVolume });

      if (showRsiPane && rsiContainerRef.current && !chartsRef.current.rsi) {
        const rsiChart = createBaseChart(rsiContainerRef.current, {
          timeScaleVisible: false,
          timeframe,
        });

        const rsiAnchorSeries = rsiChart.addLineSeries({
          color: "rgba(0, 0, 0, 0)",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: {
            type: "custom",
            formatter: rsiPriceFormatter,
          },
        });
        rsiAnchorSeries.setData(createPaneAnchorData(candles, 50));

        rsiChart.priceScale("right").applyOptions({
          autoScale: true,
          mode: 0,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        chartsRef.current.rsi = rsiChart;
        seriesRef.current.paneAnchors.rsi = rsiAnchorSeries;
      }

      if (!showRsiPane && chartsRef.current.rsi) {
        chartsRef.current.rsi.remove();
        chartsRef.current.rsi = null;
        seriesRef.current.paneAnchors.rsi = null;
      }

      if (showMacdPane && macdContainerRef.current && !chartsRef.current.macd) {
        const macdChart = createBaseChart(macdContainerRef.current, {
          timeScaleVisible: false,
          timeframe,
        });

        const macdAnchorSeries = macdChart.addLineSeries({
          color: "rgba(0, 0, 0, 0)",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: {
            type: "custom",
            formatter: macdPriceFormatter,
          },
        });
        macdAnchorSeries.setData(createPaneAnchorData(candles, 0));

        macdChart.priceScale("right").applyOptions({
          autoScale: true,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        chartsRef.current.macd = macdChart;
        seriesRef.current.paneAnchors.macd = macdAnchorSeries;
      }

      if (!showMacdPane && chartsRef.current.macd) {
        chartsRef.current.macd.remove();
        chartsRef.current.macd = null;
        seriesRef.current.paneAnchors.macd = null;
      }

      setAllChartsTimeScaleVisibility(chartsRef);

      if (existingRange) {
        preservedLogicalRangeRef.current = existingRange;
        setAllChartsLogicalRange(chartsRef, existingRange, chartSyncingRef);
      }

      window.requestAnimationFrame(() => {
        restorePreservedLogicalRange(chartsRef, preservedLogicalRangeRef, chartSyncingRef);
        updatePaneReadyState(chartsRef, setPaneReady);

        window.requestAnimationFrame(() => {
          restorePreservedLogicalRange(chartsRef, preservedLogicalRangeRef, chartSyncingRef);
        });
      });
    });

    return () => {
      if (pendingPaneInitRef.current) {
        window.cancelAnimationFrame(pendingPaneInitRef.current);
        pendingPaneInitRef.current = null;
      }
    };
  }, [showVolume, showRsiPane, showMacdPane]);

  useEffect(() => {
    if (!candles.length) {
      return;
    }

    seriesRef.current.volume?.setData(volumeBarsFromCandles(candles));
    seriesRef.current.volume?.applyOptions({ visible: showVolume });
    seriesRef.current.paneAnchors.rsi?.setData(createPaneAnchorData(candles, 50));
    seriesRef.current.paneAnchors.macd?.setData(createPaneAnchorData(candles, 0));
  }, [candles, showVolume, showRsiPane, showMacdPane]);

  useEffect(() => {
    setAllChartsTimeFormatter(chartsRef, timeframe);
  }, [timeframe, paneReady.volume, paneReady.rsi, paneReady.macd]);

  useEffect(() => {
    const activeIds = new Set(
      indicators
        .filter((indicator) => indicator.visible)
        .filter((indicator) => indicator.type !== "VOLUME")
        .map((indicator) => indicator.id),
    );

    setIndicatorOutputs((current) =>
      current.filter((indicator) => activeIds.has(indicator.id)),
    );
  }, [indicators]);

  useEffect(() => {
    let canceled = false;

    if (!normalizedTicker) {
      setChartError("Missing ticker symbol.");
      return undefined;
    }

    if (!seriesRef.current.candles || !chartsRef.current.price) {
      return undefined;
    }

    const previousMeta = lastLoadedMetaRef.current;
    const isTimeframeSwitch = previousMeta.ticker === normalizedTicker && previousMeta.timeframe && previousMeta.timeframe !== timeframe;

    if (isTimeframeSwitch && candles.length && chartsRef.current.price) {
      const logicalRange = chartsRef.current.price.timeScale().getVisibleLogicalRange();

      if (
        logicalRange &&
        Number.isFinite(logicalRange.from) &&
        Number.isFinite(logicalRange.to)
      ) {
        const rightIndex = Math.max(
          0,
          Math.min(candles.length - 1, Math.floor(logicalRange.to)),
        );

        const rightAnchorTime = candles[rightIndex]?.time || candles[candles.length - 1].time;

        const visibleBars = Math.max(20, logicalRange.to - logicalRange.from);

        viewportSnapshotRef.current = {
          rightAnchorTime,
          visibleBars,
          fromTimeframe: previousMeta.timeframe,
        };
      }
    }

    setLoading(true);
    setChartError("");
    setIndicatorError("");
    setIndicatorOutputs([]);

    // remove any existing indicator series from previous ticker/timeframe
    removeAllIndicatorSeries(seriesRef);
    seriesRef.current.candles?.setData([]);
    seriesRef.current.volume?.setData([]);

    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    loadedBoundsRef.current = { first: null, last: null };

    async function loadInitialCandles() {
      try {
        const requestedLimit = estimateInitialLimit(shellRef.current);

        const response = await fetch(
          `/api/stocks/${encodeURIComponent(normalizedTicker)}/candles?timeframe=${encodeURIComponent(timeframe)}&limit=${requestedLimit}`,
        );

        if (!response.ok) {
          throw new Error(`Failed to load candles (${response.status})`);
        }

        const payload = await response.json();
        const loadedCandles = payload.candles || [];
        if (!loadedCandles.length) {
          throw new Error("No candle data returned");
        }

        if (canceled) {
          return;
        }

        setCandles(loadedCandles);
        setCursorTime(loadedCandles[loadedCandles.length - 1].time);
        seriesRef.current.candles?.setData(loadedCandles);
        seriesRef.current.paneAnchors.rsi?.setData(createPaneAnchorData(loadedCandles, 50));
        seriesRef.current.paneAnchors.macd?.setData(createPaneAnchorData(loadedCandles, 0));

        seriesRef.current.volume?.setData(volumeBarsFromCandles(loadedCandles));
        seriesRef.current.volume?.applyOptions({ visible: showVolume });

        loadedBoundsRef.current = {
          first: loadedCandles[0].time,
          last: loadedCandles[loadedCandles.length - 1].time,
        };

        const snapshot = viewportSnapshotRef.current;

        if (snapshot) {
          const anchorIndex = findAnchorIndexAcrossTimeframes(
            loadedCandles,
            snapshot.rightAnchorTime,
            snapshot.fromTimeframe,
            timeframe,
          );

          const visibleBars = snapshot.visibleBars;

          const to = anchorIndex;
          const from = to - visibleBars;

          setAllChartsLogicalRange(chartsRef, { from, to }, chartSyncingRef);
          viewportSnapshotRef.current = null;
        } else {
          const logicalTo = loadedCandles.length - 1;
          const screenBars = estimateScreenBars(shellRef.current);
          const logicalFrom = Math.max(0, logicalTo - screenBars);

          setAllChartsLogicalRange(chartsRef, {
            from: logicalFrom,
            to: logicalTo,
          }, chartSyncingRef);
        }

        lastLoadedMetaRef.current = {
          ticker: normalizedTicker,
          timeframe,
        };
      } catch (error) {
        if (!canceled) {
          setCandles([]);
          setCursorTime(null);
          loadedBoundsRef.current = { first: null, last: null };
          setChartError(error instanceof Error ? error.message : "Failed to load chart data");
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }

    loadInitialCandles();

    return () => {
      canceled = true;
    };
  }, [normalizedTicker, timeframe]);

  useEffect(() => {
    const charts = getActiveCharts(chartsRef);

    if (!charts.length) {
      return undefined;
    }

    let debounceId = null;

    async function loadMore(direction) {
      if (!normalizedTicker || !candles.length) {
        return;
      }

      const bounds = loadedBoundsRef.current;
      const batchLimit = estimateBatchLimit(shellRef.current);

      if (direction === "older") {
        if (loadingOlderRef.current || !bounds.first) {
          return;
        }

        loadingOlderRef.current = true;

        try {
          const anchorChart = chartsRef.current.price;
          const previousRange = anchorChart?.timeScale().getVisibleLogicalRange();

          const response = await fetch(
            `/api/stocks/${encodeURIComponent(normalizedTicker)}/candles?timeframe=${encodeURIComponent(timeframe)}&limit=${batchLimit}&before=${bounds.first}`,
          );

          if (!response.ok) {
            return;
          }

          const payload = await response.json();
          const olderCandles = payload.candles || [];

          if (!olderCandles.length) {
            return;
          }

          setCandles((current) => {
            const merged = uniqueSortedCandles([...olderCandles, ...current]);
            const addedBars = merged.length - current.length;

            seriesRef.current.candles?.setData(merged);
            seriesRef.current.volume?.setData(volumeBarsFromCandles(merged));
            seriesRef.current.paneAnchors.rsi?.setData(createPaneAnchorData(merged, 50));
            seriesRef.current.paneAnchors.macd?.setData(createPaneAnchorData(merged, 0));

            loadedBoundsRef.current = {
              first: merged[0]?.time ?? null,
              last: merged[merged.length - 1]?.time ?? null,
            };

            if (previousRange) {
              const shiftedRange = {
                from: previousRange.from + addedBars,
                to: previousRange.to + addedBars,
              };

              setAllChartsLogicalRange(chartsRef, shiftedRange, chartSyncingRef);
            }

            return merged;
          });
        } finally {
          loadingOlderRef.current = false;
        }

        return;
      }

      if (direction === "newer") {
        if (loadingNewerRef.current || !bounds.last) {
          return;
        }

        loadingNewerRef.current = true;

        try {
          const response = await fetch(
            `/api/stocks/${encodeURIComponent(normalizedTicker)}/candles?timeframe=${encodeURIComponent(timeframe)}&limit=${batchLimit}&after=${bounds.last}`,
          );

          if (!response.ok) {
            return;
          }

          const payload = await response.json();
          const newerCandles = payload.candles || [];

          if (!newerCandles.length) {
            return;
          }

          setCandles((current) => {
            const merged = uniqueSortedCandles([...current, ...newerCandles]);

            seriesRef.current.candles?.setData(merged);
            seriesRef.current.volume?.setData(volumeBarsFromCandles(merged));
            seriesRef.current.paneAnchors.rsi?.setData(createPaneAnchorData(merged, 50));
            seriesRef.current.paneAnchors.macd?.setData(createPaneAnchorData(merged, 0));

            loadedBoundsRef.current = {
              first: merged[0]?.time ?? null,
              last: merged[merged.length - 1]?.time ?? null,
            };

            return merged;
          });
        } finally {
          loadingNewerRef.current = false;
        }
      }
    }

    const handlers = charts.map((sourceChart) => {
      const handler = (range) => {
        if (!range || !candles.length) {
          return;
        }

        if (!chartSyncingRef.current) {
          syncChartsToLogicalRange(chartsRef, sourceChart, range, chartSyncingRef);
        }

        const lastPoint = lastCrosshairPointRef.current;
        if (lastPoint && lastCrosshairSourceRef.current === sourceChart) {
          const nextRawTime = sourceChart.timeScale().coordinateToTime(lastPoint.x);
          const nextTime = normalizeCrosshairTime(nextRawTime);

          if (nextTime) {
            setCursorTime(nextTime);
          }

          mirrorCrosshairToCharts(
            sourceChart,
            nextRawTime,
            chartsRef,
            seriesRef,
            candleByTime,
            resolvedIndicators,
            crosshairSyncingRef,
          );
        }

        if (debounceId) {
          window.clearTimeout(debounceId);
        }

        debounceId = window.setTimeout(() => {
          const loadedCount = candles.length;
          const visibleBars = Math.max(20, range.to - range.from);
          const threshold = Math.max(30, visibleBars * LOAD_EDGE_THRESHOLD_RATIO);

          if (range.from < threshold) {
            loadMore("older");
          }

          if (range.to > loadedCount - 1 - threshold) {
            loadMore("newer");
          }
        }, 150);
      };

      sourceChart.timeScale().subscribeVisibleLogicalRangeChange(handler);

      return {
        chart: sourceChart,
        handler,
      };
    });

    return () => {
      if (debounceId) {
        window.clearTimeout(debounceId);
      }

      handlers.forEach(({ chart, handler }) => {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      });
    };
  }, [
    normalizedTicker,
    timeframe,
    candles,
    showVolume,
    showRsiPane,
    showMacdPane,
    paneReady.volume,
    paneReady.rsi,
    paneReady.macd,
    candleByTime,
    resolvedIndicators,
  ]);

  useEffect(() => {
    let canceled = false;

    if (!normalizedTicker || !candles.length) {
      setIndicatorOutputs([]);
      return undefined;
    }

    const calculationIndicators = indicators.filter((indicator) => indicator.visible && indicator.type !== "VOLUME");

    if (!calculationIndicators.length) {
      setIndicatorOutputs([]);
      return undefined;
    }

    const wantsRsi = calculationIndicators.some((indicator) => indicator.type === "RSI");
    const wantsMacd = calculationIndicators.some((indicator) => indicator.type === "MACD");

    if (wantsRsi && !paneReady.rsi) {
      return undefined;
    }

    if (wantsRsi && (!chartsRef.current.rsi || !rsiContainerRef.current)) {
      return undefined;
    }

    if (wantsMacd && !paneReady.macd) {
      return undefined;
    }

    if (wantsMacd && (!chartsRef.current.macd || !macdContainerRef.current)) {
      return undefined;
    }

    setIndicatorError("");

    async function loadIndicators() {
      try {
        const groupedByTimeframe = calculationIndicators.reduce((groups, indicator) => {
          const effectiveTimeframe = indicator.timeframeMode === "fixed" && indicator.indicatorTimeframe !== "chart"
            ? indicator.indicatorTimeframe
            : timeframe;
          const current = groups.get(effectiveTimeframe) || [];
          current.push(indicator);
          groups.set(effectiveTimeframe, current);
          return groups;
        }, new Map());

        const indicatorPayloads = await Promise.all(
          Array.from(groupedByTimeframe.entries()).map(async ([indicatorTimeframe, groupedIndicators]) => {
            const payload = {
              timeframe: indicatorTimeframe,
              limit: indicatorTimeframe === timeframe ? candles.length : Math.min(5000, Math.max(1200, candles.length * 3)),
              start_time: indicatorTimeframe === timeframe ? candles[0].time : null,
              end_time: candles[candles.length - 1].time,
              warmup_bars: 300,
              indicators: groupedIndicators.map((indicator) => ({
                id: indicator.id,
                type: indicator.type,
                period: indicatorNeedsPeriod(indicator.type) ? indicator.period : null,
                ma_period: indicator.type === "RSI" ? indicator.maPeriod : null,
                slow_period: indicator.type === "MACD" ? indicator.slowPeriod : null,
                signal_period: indicator.type === "MACD" ? indicator.signalPeriod : null,
                std_dev: indicator.type === "BBANDS" ? indicator.stdDev : null,
                band_period: indicator.type === "VWAP" ? indicator.period : null,
              })),
            };

            const response = await fetch(`/api/stocks/${encodeURIComponent(normalizedTicker)}/indicators`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            });

            if (!response.ok) {
              throw new Error(`Failed to load indicators (${response.status})`);
            }

            const indicatorPayload = await response.json();
            const outputs = indicatorPayload.indicators || [];
            return indicatorTimeframe === timeframe
              ? outputs
              : outputs.map((output) => alignIndicatorOutputToChartCandles(output, candles));
          }),
        );

        if (!canceled) {
          preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);
          setIndicatorOutputs(indicatorPayloads.flat());
        }
      } catch (error) {
        if (!canceled) {
          setIndicatorError(error instanceof Error ? error.message : "Failed to load indicators");
          setIndicatorOutputs([]);
        }
      }
    }

    loadIndicators();

    return () => {
      canceled = true;
    };
  }, [normalizedTicker, timeframe, indicators, candles, paneReady.rsi, paneReady.macd]);

  // volume visibility is handled by creating/removing the volume chart

  useEffect(() => {
    const priceChart = chartsRef.current.price;
    const rsiChart = chartsRef.current.rsi;
    const macdChart = chartsRef.current.macd;

    const rangeBeforeRender =
      preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef) ||
      priceChart?.timeScale().getVisibleLogicalRange();

    if (!priceChart) {
      return;
    }

    const needsRsiChart = resolvedIndicators.some((indicator) => indicator.type === "RSI");
    const needsMacdChart = resolvedIndicators.some((indicator) => indicator.type === "MACD");

    if (needsRsiChart && (!paneReady.rsi || !rsiChart)) {
      return;
    }

    if (needsMacdChart && (!paneReady.macd || !macdChart)) {
      return;
    }

    const indicatorSeriesMap = seriesRef.current.indicators;
    const currentIds = new Set(resolvedIndicators.map((indicator) => indicator.id));

    indicatorSeriesMap.forEach((entries, indicatorId) => {
      if (!currentIds.has(indicatorId)) {
        entries.forEach((entry) => {
          try {
            entry.chart.removeSeries(entry.series);
          } catch {
            // series may already be gone because its pane was removed
          }
        });
        indicatorSeriesMap.delete(indicatorId);
      }
    });

    resolvedIndicators.forEach((indicator) => {
      const existing = indicatorSeriesMap.get(indicator.id);

      if (existing) {
        existing.forEach((entry) => {
          try {
            entry.chart.removeSeries(entry.series);
          } catch {
            // ignore stale series
          }
        });
      }

      const targetChart =
        indicator.type === "RSI"
          ? rsiChart
          : indicator.type === "MACD"
            ? macdChart
            : priceChart;

      if (!targetChart) {
        indicatorSeriesMap.set(indicator.id, []);
        return;
      }

      const createdEntries = [];

      if (indicator.type === "RSI" && indicator.lines.length > 0 && rsiChart) {
        const basePoints = indicator.lines[0].points;

        if (basePoints.length > 0) {
          const oversoldZoneSeries = rsiChart.addHistogramSeries({
            color: colorWithAlpha(TV_COLORS.red, 0.08),
            base: 30,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          oversoldZoneSeries.setData(createConstantLine(basePoints, 0));
          oversoldZoneSeries.applyOptions({ visible: indicator.visible });
          createdEntries.push({
            chart: rsiChart,
            series: oversoldZoneSeries,
            lineIndex: 1000,
          });

          const overboughtZoneSeries = rsiChart.addHistogramSeries({
            color: colorWithAlpha(TV_COLORS.teal, 0.08),
            base: 70,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          overboughtZoneSeries.setData(createConstantLine(basePoints, 100));
          overboughtZoneSeries.applyOptions({ visible: indicator.visible });
          createdEntries.push({
            chart: rsiChart,
            series: overboughtZoneSeries,
            lineIndex: 1001,
          });
        }
      }

      indicator.lines.forEach((line, lineIndex) => {
        const isMacdHistogram = indicator.type === "MACD" && line.label === "Histogram";

        if (isMacdHistogram) {
          const histogramSeries = targetChart.addHistogramSeries({
            priceLineVisible: false,
            lastValueVisible: true,
            color: line.color,
            priceFormat: {
              type: "custom",
              formatter: macdPriceFormatter,
            },
          });

          histogramSeries.setData(
            line.points.map((point) => ({
              time: point.time,
              value: point.value,
              color: point.value >= 0
                ? colorWithAlpha(indicator.histogramUpColor, 0.42)
                : colorWithAlpha(indicator.histogramDownColor, 0.42),
            })),
          );
          histogramSeries.applyOptions({ visible: indicator.visible });
          createdEntries.push({
            chart: targetChart,
            series: histogramSeries,
            lineIndex,
          });
          return;
        }

        const lineSeries = targetChart.addLineSeries({
          color: line.color,
          lineWidth: indicator.lineWidth,
          priceLineVisible: false,
          lastValueVisible: indicator.type === "RSI" || indicator.type === "MACD",
          priceFormat:
            indicator.type === "RSI"
              ? {
                  type: "custom",
                  formatter: rsiPriceFormatter,
                }
              : indicator.type === "MACD"
                ? {
                    type: "custom",
                    formatter: macdPriceFormatter,
                  }
                : {
                    type: "custom",
                    formatter: priceFormatter,
                  },
        });

        lineSeries.setData(line.points);

        lineSeries.applyOptions({ visible: indicator.visible });
        createdEntries.push({
          chart: targetChart,
          series: lineSeries,
          lineIndex,
        });
      });

      if (indicator.type === "RSI" && indicator.lines.length > 0 && rsiChart) {
        const basePoints = indicator.lines[0].points;

        if (basePoints.length > 0) {
          const oversoldLineSeries = rsiChart.addLineSeries({
            color: colorWithAlpha(TV_COLORS.red, 0.42),
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          oversoldLineSeries.setData(createConstantLine(basePoints, 30));
          oversoldLineSeries.applyOptions({
            visible: indicator.visible,
          });
          createdEntries.push({
            chart: rsiChart,
            series: oversoldLineSeries,
            lineIndex: 1002,
          });

          const overboughtLineSeries = rsiChart.addLineSeries({
            color: colorWithAlpha(TV_COLORS.teal, 0.42),
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          overboughtLineSeries.setData(createConstantLine(basePoints, 70));
          overboughtLineSeries.applyOptions({
            visible: indicator.visible,
          });
          createdEntries.push({
            chart: rsiChart,
            series: overboughtLineSeries,
            lineIndex: 1003,
          });
        }
      }

      indicatorSeriesMap.set(indicator.id, createdEntries);
    });

    if (rangeBeforeRender) {
      preservedLogicalRangeRef.current = rangeBeforeRender;

      window.requestAnimationFrame(() => {
        restorePreservedLogicalRange(chartsRef, preservedLogicalRangeRef, chartSyncingRef);
      });
    }
  }, [resolvedIndicators, showRsiPane, showMacdPane, showVolume, paneReady.rsi, paneReady.macd]);

  useEffect(() => {
    const canvas = vwapFillCanvasRef.current;
    const container = priceContainerRef.current;
    const priceChart = chartsRef.current.price;
    const priceSeries = seriesRef.current.candles;

    if (!canvas || !container || !priceChart || !priceSeries) {
      return undefined;
    }

    let animationFrame = null;
    const vwapIndicator = resolvedIndicators.find((indicator) => indicator.visible && indicator.type === "VWAP");
    const upperLine = vwapIndicator ? findIndicatorLine(vwapIndicator, (label) => label.includes("+1")) : null;
    const lowerLine = vwapIndicator ? findIndicatorLine(vwapIndicator, (label) => label.includes("-1")) : null;
    const lowerByTime = pointsByTime(lowerLine?.points || []);
    const bandPoints = (upperLine?.points || [])
      .map((upperPoint) => {
        const lowerPoint = lowerByTime.get(upperPoint.time);
        if (!lowerPoint) {
          return null;
        }
        return {
          time: upperPoint.time,
          upper: upperPoint.value,
          lower: lowerPoint.value,
        };
      })
      .filter(Boolean);

    const clear = () => {
      const context = canvas.getContext("2d");
      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
    };

    const draw = () => {
      animationFrame = null;
      clear();

      if (bandPoints.length < 2) {
        return;
      }

      const context = canvas.getContext("2d");
      const upperCoords = [];
      const lowerCoords = [];

      bandPoints.forEach((point) => {
        const x = priceChart.timeScale().timeToCoordinate(point.time);
        const upperY = priceSeries.priceToCoordinate(point.upper);
        const lowerY = priceSeries.priceToCoordinate(point.lower);

        if (
          Number.isFinite(x) &&
          Number.isFinite(upperY) &&
          Number.isFinite(lowerY)
        ) {
          upperCoords.push({ x, y: upperY });
          lowerCoords.push({ x, y: lowerY });
        }
      });

      if (upperCoords.length < 2 || lowerCoords.length < 2) {
        return;
      }

      context.beginPath();
      context.moveTo(upperCoords[0].x, upperCoords[0].y);
      upperCoords.slice(1).forEach((point) => {
        context.lineTo(point.x, point.y);
      });
      lowerCoords.slice().reverse().forEach((point) => {
        context.lineTo(point.x, point.y);
      });
      context.closePath();
      context.fillStyle = colorWithAlpha(DEFAULT_INDICATOR_STYLES.VWAP.fillColor, 0.08);
      context.fill();
    };

    const scheduleDraw = () => {
      if (animationFrame) {
        return;
      }
      animationFrame = window.requestAnimationFrame(draw);
    };

    const resizeObserver = new ResizeObserver(scheduleDraw);
    resizeObserver.observe(container);
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(scheduleDraw);
    scheduleDraw();

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver.disconnect();
      priceChart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleDraw);
      clear();
    };
  }, [resolvedIndicators, paneReady.rsi, paneReady.macd]);

  useEffect(() => {
    const charts = getActiveCharts(chartsRef);

    if (!charts.length) {
      return undefined;
    }

    const updateSharedLine = (sourceChart, param) => {
      const line = sharedCrosshairRef.current;
      const shell = shellRef.current;

      if (!line || !shell || !param?.point || param.time === undefined) {
        if (line) {
          line.style.display = "none";
        }
        return;
      }

      const sourcePane = paneElementForChart(sourceChart, chartsRef, {
        price: priceContainerRef,
        volume: priceContainerRef,
        rsi: rsiContainerRef,
        macd: macdContainerRef,
      });

      if (!sourcePane) {
        line.style.display = "none";
        return;
      }

      const paneRect = sourcePane.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const x = paneRect.left - shellRect.left + param.point.x;

      line.style.transform = `translateX(${x}px)`;
      line.style.display = "block";

      lastCrosshairTimeRef.current = normalizeCrosshairTime(param.time);
    };

    const handlers = charts.map((chart) => {
      const handler = (param) => {
        if (crosshairSyncingRef.current) {
          return;
        }

        const nextTime = normalizeCrosshairTime(param?.time);

        if (nextTime) {
          setCursorTime(nextTime);
        }

        if (param?.point && param.time !== undefined) {
          lastCrosshairSourceRef.current = chart;
          lastCrosshairPointRef.current = {
            x: param.point.x,
            y: param.point.y,
          };
        }

        updateSharedLine(chart, param);
        mirrorCrosshairToCharts(
          chart,
          param?.time,
          chartsRef,
          seriesRef,
          candleByTime,
          resolvedIndicators,
          crosshairSyncingRef,
        );
      };

      chart.subscribeCrosshairMove(handler);

      return {
        chart,
        handler,
      };
    });

    const onMouseLeave = () => {
      if (sharedCrosshairRef.current) {
        sharedCrosshairRef.current.style.display = "none";
      }

      getActiveCharts(chartsRef).forEach((chart) => {
        chart.clearCrosshairPosition();
      });

      lastCrosshairSourceRef.current = null;
      lastCrosshairPointRef.current = null;
    };

    shellRef.current?.addEventListener("mouseleave", onMouseLeave);

    return () => {
      handlers.forEach(({ chart, handler }) => {
        chart.unsubscribeCrosshairMove(handler);
      });

      shellRef.current?.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [
    showVolume,
    showRsiPane,
    showMacdPane,
    paneReady.volume,
    paneReady.rsi,
    paneReady.macd,
    candleByTime,
    resolvedIndicators,
  ]);

  const openIndicatorPicker = () => {
    setIndicatorPickerOpen(true);
    setIndicatorSettingsOpen(false);
  };

  const openNewIndicatorSettings = (type) => {
    const existing = indicators.find((indicator) => indicator.type === type);
    setIndicatorDraft(createIndicatorDraft(type, indicators.length, existing || null));
    setIndicatorPickerOpen(false);
    setIndicatorSettingsOpen(true);
  };

  const openEditIndicatorSettings = (indicator) => {
    setIndicatorDraft(createIndicatorDraft(indicator.type, indicators.length, indicator));
    setIndicatorPickerOpen(false);
    setIndicatorSettingsOpen(true);
  };

  const saveIndicatorSettings = () => {
    preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);

    const period = indicatorNeedsPeriod(indicatorDraft.type) ? clampPeriod(indicatorDraft.period) : null;
    const lineWidth = Math.max(1, Math.min(Number.parseInt(indicatorDraft.lineWidth, 10) || 1, 4));

    if (indicatorNeedsPeriod(indicatorDraft.type) && !period) {
      return;
    }

    const existingSameType = !indicatorDraft.id && indicatorDraft.type === "VOLUME"
      ? indicators.find((indicator) => indicator.type === indicatorDraft.type)
      : null;
    const targetId = indicatorDraft.id || existingSameType?.id;
    const timeframeMode = indicatorDraft.indicatorTimeframe === "chart" ? "chart" : "fixed";
    const settings = {
      period,
      color: indicatorDraft.color,
      lineWidth,
      visible: true,
      maPeriod: indicatorDraft.type === "RSI" ? clampPositiveInt(indicatorDraft.maPeriod, period, 2, 400) : null,
      maColor: indicatorDraft.maColor,
      slowPeriod: indicatorDraft.type === "MACD" ? Math.max((period || 12) + 1, clampPositiveInt(indicatorDraft.slowPeriod, 26, 2, 400)) : null,
      signalPeriod: indicatorDraft.type === "MACD" ? clampPositiveInt(indicatorDraft.signalPeriod, 9, 1, 200) : null,
      signalColor: indicatorDraft.signalColor,
      histogramUpColor: indicatorDraft.histogramUpColor,
      histogramDownColor: indicatorDraft.histogramDownColor,
      stdDev: indicatorDraft.type === "BBANDS" ? clampFloat(indicatorDraft.stdDev, 2, 0.1, 10) : null,
      upperColor: indicatorDraft.upperColor,
      middleColor: indicatorDraft.middleColor,
      lowerColor: indicatorDraft.lowerColor,
      bandColor: indicatorDraft.bandColor,
      timeframeMode,
      indicatorTimeframe: indicatorDraft.indicatorTimeframe,
    };

    if (targetId) {
      setIndicators((current) =>
        current.map((indicator) =>
          indicator.id === targetId
            ? {
                ...indicator,
                ...settings,
              }
            : indicator,
        ),
      );
    } else {
      setIndicators((current) => {
        const id = `${indicatorDraft.type.toLowerCase()}-${period}-${Date.now()}`;
        return [
          ...current,
          {
            id,
            type: indicatorDraft.type,
            ...settings,
          },
        ];
      });
    }

    setIndicatorSettingsOpen(false);
  };

  const toggleIndicatorVisibility = (indicatorId) => {
    preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);

    setIndicators((current) =>
      current.map((indicator) =>
        indicator.id === indicatorId
          ? {
              ...indicator,
              visible: !indicator.visible,
            }
          : indicator,
      ),
    );
  };

  const removeIndicator = (indicatorId) => {
    preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);

    setIndicators((current) => current.filter((indicator) => indicator.id !== indicatorId));
  };

  const startPaneResize = (boundary, event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeights = { ...paneHeights };
    const shellHeight = shellRef.current?.getBoundingClientRect().height || 0;
    const resizeCursor = document.body.style.cursor;

    document.body.style.cursor = "ns-resize";

    const onPointerMove = (moveEvent) => {
      const deltaY = moveEvent.clientY - startY;

      setPaneHeights((current) => {
        if (boundary === "rsi-macd") {
          const combinedHeight = startHeights.rsi + startHeights.macd;
          const nextRsi = Math.max(
            RSI_PANE_MIN_HEIGHT,
            Math.min(startHeights.rsi + deltaY, combinedHeight - MACD_PANE_MIN_HEIGHT),
          );

          return {
            ...current,
            rsi: nextRsi,
            macd: combinedHeight - nextRsi,
          };
        }

        const pane = boundary === "price-rsi" ? "rsi" : "macd";
        const minimum = pane === "rsi" ? RSI_PANE_MIN_HEIGHT : MACD_PANE_MIN_HEIGHT;
        const siblingHeight =
          pane === "rsi" && showMacdPane
            ? startHeights.macd
            : pane === "macd" && showRsiPane
              ? startHeights.rsi
              : 0;
        const maximum = shellHeight
          ? Math.max(minimum, shellHeight - PRICE_PANE_MIN_HEIGHT - siblingHeight)
          : Number.POSITIVE_INFINITY;
        const nextHeight = Math.max(minimum, Math.min(startHeights[pane] - deltaY, maximum));

        return {
          ...current,
          [pane]: nextHeight,
        };
      });
    };

    const onPointerUp = () => {
      document.body.style.cursor = resizeCursor;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const renderIndicatorStack = (summaries) => (
    <div className="chart-indicator-stack">
      {summaries.map((indicator) => (
        <div className={`chart-indicator-row ${indicator.visible ? "active" : ""}`} key={indicator.id}>
          <span className="indicator-dot" style={{ backgroundColor: indicator.color }} />
          <span className="indicator-name">{indicatorChipLabel(indicator)}</span>
          <span className="indicator-values">
            {indicator.values.length ? (
              indicator.values.map((item) => (
                <span key={item.id} style={{ color: item.color }}>{item.value}</span>
              ))
            ) : (
              <span className="indicator-value-muted">hidden</span>
            )}
          </span>
          <div className="chart-indicator-actions">
            <button type="button" onClick={() => toggleIndicatorVisibility(indicator.id)} title={indicator.visible ? "Hide indicator" : "Show indicator"}>
              <EyeIcon open={indicator.visible} />
            </button>
            <button type="button" onClick={() => openEditIndicatorSettings(indicator)} title="Indicator settings">
              <CogIcon />
            </button>
            <button type="button" onClick={() => removeIndicator(indicator.id)} title="Remove indicator">
              <CloseIcon />
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <main className="stock-page">
      <HeaderBar onSearch={(nextTicker) => navigate(`/stock/${encodeURIComponent(nextTicker)}`)} searchDefault={normalizedTicker} />

      <section className="chart-stage" aria-label="Stock chart area">
        <div className="chart-titlebar">
          <p>{normalizedTicker || "Unknown symbol"}</p>
          <div className="titlebar-tools">
            <div className="menu-anchor">
              <button
                className="tv-tool-button active interval-button"
                type="button"
                onClick={() => setTimeframeMenuOpen((open) => !open)}
                aria-expanded={timeframeMenuOpen}
              >
                <strong>{timeframeShortLabel(timeframe)}</strong>
              </button>

              {timeframeMenuOpen && (
                <div className="tv-dropdown timeframe-dropdown">
                  {timeframeGroups.map(([group, options]) => (
                    <div className="dropdown-group" key={group}>
                      <p>{group}</p>
                      <div className="dropdown-grid">
                        {options.map((option) => (
                          <button
                            key={option.value}
                            className={timeframe === option.value ? "selected" : ""}
                            type="button"
                            onClick={() => {
                              preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);
                              setTimeframe(option.value);
                              setTimeframeMenuOpen(false);
                            }}
                          >
                            <span>{option.shortLabel}</span>
                            <small>{option.label}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="tv-tool-button" type="button" onClick={openIndicatorPicker}>
              <strong>Indicators</strong>
            </button>
          </div>
          <Link to="/" className="back-link">Back to movers</Link>
        </div>

        {indicatorPickerOpen && (
          <div className="modal-backdrop" onMouseDown={() => setIndicatorPickerOpen(false)}>
            <div className="indicator-modal" role="dialog" aria-modal="true" aria-label="Indicators" onMouseDown={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h2>Indicators</h2>
                  <p>Add studies to the chart</p>
                </div>
                <button type="button" className="modal-close" onClick={() => setIndicatorPickerOpen(false)}>x</button>
              </div>

              <div className="indicator-catalog">
                {INDICATOR_TYPES.map((indicator) => (
                  <button type="button" key={indicator.type} onClick={() => openNewIndicatorSettings(indicator.type)}>
                    <strong>{indicator.type}</strong>
                    <span>{indicator.name}</span>
                    <small>{indicator.description}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {indicatorSettingsOpen && (
          <div className="modal-backdrop" onMouseDown={() => setIndicatorSettingsOpen(false)}>
            <div className="indicator-settings-modal" role="dialog" aria-modal="true" aria-label="Indicator settings" onMouseDown={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h2>{indicatorDraft.id ? "Edit" : "Add"} {indicatorDraft.type}</h2>
                  <p>{activeIndicatorMeta?.name}</p>
                </div>
                <button type="button" className="modal-close" onClick={() => setIndicatorSettingsOpen(false)}>x</button>
              </div>

              <div className="settings-grid">
                {indicatorDraft.type === "VOLUME" && (
                  <p className="settings-note">Volume bars use each candle's direction for their red/green color.</p>
                )}

                {indicatorDraft.type !== "VOLUME" && (
                  <label>
                    Timeframe
                    <select
                      value={indicatorDraft.indicatorTimeframe}
                      onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, indicatorTimeframe: event.target.value }))}
                    >
                      <option value="chart">Follow chart</option>
                      {TIMEFRAME_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}

                {indicatorNeedsPeriod(indicatorDraft.type) && (
                  <label>
                    {indicatorDraft.type === "MACD" ? "Fast length" : indicatorDraft.type === "RSI" ? "RSI length" : "Period"}
                    <input
                      type="number"
                      min={2}
                      max={400}
                      value={indicatorDraft.period}
                      onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, period: event.target.value }))}
                    />
                  </label>
                )}

                {indicatorDraft.type === "RSI" && (
                  <>
                    <label>
                      RSI MA length
                      <input
                        type="number"
                        min={2}
                        max={400}
                        value={indicatorDraft.maPeriod}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, maPeriod: event.target.value }))}
                      />
                    </label>
                    <label>
                      RSI MA color
                      <input
                        type="color"
                        value={indicatorDraft.maColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, maColor: event.target.value }))}
                      />
                    </label>
                  </>
                )}

                {indicatorDraft.type === "MACD" && (
                  <>
                    <label>
                      Slow length
                      <input
                        type="number"
                        min={3}
                        max={400}
                        value={indicatorDraft.slowPeriod}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, slowPeriod: event.target.value }))}
                      />
                    </label>
                    <label>
                      Signal length
                      <input
                        type="number"
                        min={1}
                        max={200}
                        value={indicatorDraft.signalPeriod}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, signalPeriod: event.target.value }))}
                      />
                    </label>
                    <label>
                      Signal color
                      <input
                        type="color"
                        value={indicatorDraft.signalColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, signalColor: event.target.value }))}
                      />
                    </label>
                    <label>
                      Histogram up
                      <input
                        type="color"
                        value={indicatorDraft.histogramUpColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, histogramUpColor: event.target.value }))}
                      />
                    </label>
                    <label>
                      Histogram down
                      <input
                        type="color"
                        value={indicatorDraft.histogramDownColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, histogramDownColor: event.target.value }))}
                      />
                    </label>
                  </>
                )}

                {indicatorDraft.type === "BBANDS" && (
                  <>
                    <label>
                      Standard deviations
                      <input
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={indicatorDraft.stdDev}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, stdDev: event.target.value }))}
                      />
                    </label>
                    <label>
                      Upper color
                      <input
                        type="color"
                        value={indicatorDraft.upperColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, upperColor: event.target.value }))}
                      />
                    </label>
                    <label>
                      Middle color
                      <input
                        type="color"
                        value={indicatorDraft.middleColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, middleColor: event.target.value }))}
                      />
                    </label>
                    <label>
                      Lower color
                      <input
                        type="color"
                        value={indicatorDraft.lowerColor}
                        onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, lowerColor: event.target.value }))}
                      />
                    </label>
                  </>
                )}

                {indicatorDraft.type === "VWAP" && (
                  <label>
                    Band color
                    <input
                      type="color"
                      value={indicatorDraft.bandColor}
                      onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, bandColor: event.target.value }))}
                    />
                  </label>
                )}

                {indicatorDraft.type !== "VOLUME" && (
                  <label>
                    Line color
                    <input
                      type="color"
                      value={indicatorDraft.color}
                      onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, color: event.target.value }))}
                    />
                  </label>
                )}

                {indicatorDraft.type !== "VOLUME" && (
                  <label>
                    Thickness
                    <select
                      value={indicatorDraft.lineWidth}
                      onChange={(event) => setIndicatorDraft((draft) => ({ ...draft, lineWidth: event.target.value }))}
                    >
                      {LINE_WIDTH_OPTIONS.map((width) => (
                        <option key={width} value={String(width)}>{width}px</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="modal-actions">
                <button type="button" className="tv-tool-button" onClick={() => setIndicatorSettingsOpen(false)}>Cancel</button>
                <button type="button" className="tv-tool-button active" onClick={saveIndicatorSettings}>
                  {indicatorDraft.id ? "Save" : "Add indicator"}
                </button>
              </div>
            </div>
          </div>
        )}

        {loading && <p className="chart-status">Loading candles...</p>}
        {chartError && <p className="chart-error">{chartError}</p>}
        {indicatorError && <p className="chart-error">{indicatorError}</p>}

        <div
          ref={shellRef}
          className={[
            "chart-shell",
            showRsiPane ? "has-rsi-pane" : "",
            showMacdPane ? "has-macd-pane" : "",
          ].join(" ")}
        >
          <div ref={sharedCrosshairRef} className="shared-crosshair-line" />

          <div
            ref={priceContainerRef}
            className="chart-pane chart-pane-price"
            style={{ minHeight: PRICE_PANE_MIN_HEIGHT }}
          >
            <canvas ref={vwapFillCanvasRef} className="vwap-fill-canvas" aria-hidden="true" />
            {renderIndicatorStack(indicatorSummariesByPane.price)}

            <div className="chart-readout" aria-live="polite">
              <span className={`inf-kv tone-${candleTone}`}><strong>O</strong> {formatPrice(cursorSnapshot.candle?.open)}</span>
              <span className={`inf-kv tone-${candleTone}`}><strong>H</strong> {formatPrice(cursorSnapshot.candle?.high)}</span>
              <span className={`inf-kv tone-${candleTone}`}><strong>L</strong> {formatPrice(cursorSnapshot.candle?.low)}</span>
              <span className={`inf-kv tone-${candleTone}`}><strong>C</strong> {formatPrice(cursorSnapshot.candle?.close)}</span>
              <span className={`inf-kv tone-${candleTone}`}><strong>Chg</strong> {formatCandleChange(cursorSnapshot.candle)}</span>
            </div>
          </div>

          {showRsiPane && (
            <div
              ref={rsiContainerRef}
              className="chart-pane chart-pane-rsi"
              style={{ height: paneHeights.rsi }}
            >
              <div
                className="pane-resize-handle"
                role="separator"
                aria-label="Resize between price and RSI panes"
                tabIndex={0}
                onPointerDown={(event) => startPaneResize("price-rsi", event)}
              />
              {renderIndicatorStack(indicatorSummariesByPane.rsi)}
            </div>
          )}

          {showMacdPane && (
            <div
              ref={macdContainerRef}
              className="chart-pane chart-pane-macd"
              style={{ height: paneHeights.macd }}
            >
              <div
                className="pane-resize-handle"
                role="separator"
                aria-label={showRsiPane ? "Resize between RSI and MACD panes" : "Resize between price and MACD panes"}
                tabIndex={0}
                onPointerDown={(event) => startPaneResize(showRsiPane ? "rsi-macd" : "price-macd", event)}
              />
              {renderIndicatorStack(indicatorSummariesByPane.macd)}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
