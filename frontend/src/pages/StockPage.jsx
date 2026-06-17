import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createChart } from "lightweight-charts";
import HeaderBar from "../components/HeaderBar";
import {
  AFTER_MARKET_BACKGROUND,
  PRE_MARKET_BACKGROUND,
  chartQueryString,
  marketSession,
  resolveChartTimeZone,
  systemTimeZone,
  timezoneLabel,
  timezoneOptions,
} from "../lib/chartSettings";
import {
  DEFAULT_INDICATOR_STYLES,
  INDICATOR_TYPES,
  LINE_WIDTH_OPTIONS,
  TIMEFRAME_OPTIONS,
  TV_COLORS,
  defaultColorForIndicator,
  defaultIndicatorTimeframe,
  defaultPeriodForIndicator,
  effectiveIndicatorColor,
  effectiveVwapBandColor,
  groupedTimeframes,
  pickColor,
  timeframeRequiresApi,
  timeframeSeconds,
  timeframeShortLabel,
} from "../lib/chartConfig";
import {
  colorWithAlpha,
  formatCandleChange,
  formatPrice,
  formatVolume,
  formatVolumeScale,
  macdPriceFormatter,
  priceFormatter,
  rsiPriceFormatter,
} from "../lib/chartFormatters";
import { formatChartTickTime, formatChartTime, normalizeTicker } from "../lib/tradingview";

const MIN_BAR_SPACING = 4;
const INITIAL_LOAD_SCREENS = 1;
const BUFFER_LOAD_SCREENS = 1;
const BUFFER_LOAD_ROUNDS = 2;
const MIN_INITIAL_BARS = 50;
const MAX_INITIAL_BARS = 5000;

const PRICE_PANE_MIN_HEIGHT = 240;
const RSI_PANE_MIN_HEIGHT = 90;
const MACD_PANE_MIN_HEIGHT = 100;

const RIGHT_PRICE_SCALE_WIDTH = 82;
const CROSSHAIR_LABEL_BACKGROUND = "#263244";

const DEFAULT_SOURCE_INFO = {
  source_mode: "local",
  source_provider: "TwelveData",
  delayed: false,
  delay_minutes: null,
};

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

/** Builds the computed-data identity for matching equivalent indicator configs. */
function indicatorConfigKey(indicator) {
  const effectiveTimeframe = indicator.timeframeMode === "fixed" && indicator.indicatorTimeframe !== "chart"
    ? indicator.indicatorTimeframe
    : "chart";
  const parts = [indicator.type, effectiveTimeframe];

  if (indicatorNeedsPeriod(indicator.type)) {
    parts.push(indicator.period ?? "");
  }
  if (indicator.type === "RSI") {
    parts.push(indicator.maPeriod ?? "");
  }
  if (indicator.type === "MACD") {
    parts.push(indicator.slowPeriod ?? "", indicator.signalPeriod ?? "");
  }
  if (indicator.type === "BBANDS") {
    parts.push(indicator.stdDev ?? "");
  }

  return parts.join("|");
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

function uniqueSortedCandles(candles) {
  const byTime = new Map();

  candles.forEach((candle) => {
    if (isValidCandle(candle)) {
      byTime.set(candle.time, candle);
    }
  });

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function isValidCandle(candle) {
  if (!candle) {
    return false;
  }
  const values = [candle.open, candle.high, candle.low, candle.close].map(Number);
  const [open, high, low, close] = values;
  return values.every((value) => Number.isFinite(value) && value > 0) &&
    Number.isFinite(Number(candle.time)) &&
    high >= low &&
    high >= Math.max(open, close) &&
    low <= Math.min(open, close);
}

function candlesEqual(left, right) {
  return Boolean(left && right) &&
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume;
}

function sourceInfoFromPayload(payload) {
  return {
    source_mode: payload.source_mode || DEFAULT_SOURCE_INFO.source_mode,
    source_provider: payload.source_provider || DEFAULT_SOURCE_INFO.source_provider,
    delayed: Boolean(payload.delayed),
    delay_minutes: payload.delay_minutes ?? null,
    stream_error: payload.stream_error || "",
  };
}

function sourceModeLabel(mode) {
  if (mode === "streaming") {
    return "Streaming data";
  }
  if (mode === "api_snapshot") {
    return "API snapshot";
  }
  return "Local data";
}

function streamBucketForLatestCandle(current, eventTime, intervalSeconds) {
  if (!current.length) {
    return {
      index: -1,
      bucketTime: Math.floor(eventTime / intervalSeconds) * intervalSeconds,
    };
  }

  const lastIndex = current.length - 1;
  const lastCandle = current[lastIndex];
  if (eventTime < lastCandle.time) {
    return { index: null, bucketTime: null };
  }

  const lastCandleEnd = lastCandle.time + intervalSeconds;
  if (eventTime < lastCandleEnd) {
    return { index: lastIndex, bucketTime: lastCandle.time };
  }

  const stepsFromLast = Math.max(1, Math.floor((eventTime - lastCandle.time) / intervalSeconds));
  return {
    index: -1,
    bucketTime: lastCandle.time + stepsFromLast * intervalSeconds,
  };
}

function mergeStreamEventIntoCandles(current, event, activeTimeframe, settings) {
  const intervalSeconds = timeframeSeconds(activeTimeframe);
  if (!intervalSeconds || !event.time) {
    return current;
  }
  if (event.type === "aggregate" && !isValidCandle({
    time: event.time,
    open: event.open,
    high: event.high,
    low: event.low,
    close: event.close,
    volume: event.volume || 0,
  })) {
    return current;
  }
  if (!settings.includeExtendedHours && marketSession(event.time) !== "regular") {
    return current;
  }

  const { index, bucketTime } = streamBucketForLatestCandle(current, event.time, intervalSeconds);
  if (bucketTime === null) {
    return current;
  }
  const next = [...current];

  if (event.type === "aggregate") {
    const eventIntervalSeconds = event.event_interval_seconds || 1;
    const aggregateCandle = {
      time: bucketTime,
      open: event.open,
      high: event.high,
      low: event.low,
      close: event.close,
      volume: event.volume || 0,
    };

    if (index !== null && index >= 0) {
      const candle = next[index];
      const updatedCandle = eventIntervalSeconds >= intervalSeconds
        ? aggregateCandle
        : {
          ...candle,
          high: Math.max(candle.high, event.high),
          low: Math.min(candle.low, event.low),
          close: event.close,
          volume: Math.max(candle.volume || 0, event.volume || 0),
        };

      if (candlesEqual(candle, updatedCandle)) {
        return current;
      }
      next[index] = updatedCandle;
    } else {
      if (eventIntervalSeconds < intervalSeconds && current.length) {
        const lastCandle = current[current.length - 1];
        if (bucketTime < lastCandle.time) {
          return current;
        }
        next.push({
          time: bucketTime,
          open: lastCandle.close,
          high: Math.max(lastCandle.close, event.high),
          low: Math.min(lastCandle.close, event.low),
          close: event.close,
          volume: event.volume || 0,
        });
      } else {
        next.push(aggregateCandle);
      }
    }
  } else if (event.type === "trade") {
    const price = event.price;
    if (!Number.isFinite(price)) {
      return current;
    }

    if (index !== null && index >= 0) {
      const candle = next[index];
      const updatedCandle = {
        ...candle,
        high: Math.max(candle.high, price),
        low: Math.min(candle.low, price),
        close: price,
        volume: (candle.volume || 0) + (event.volume || 0),
      };
      if (candlesEqual(candle, updatedCandle)) {
        return current;
      }
      next[index] = updatedCandle;
    } else {
      next.push({
        time: bucketTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: event.volume || 0,
      });
    }
  }

  return uniqueSortedCandles(next).slice(-5000);
}

function estimateScreenBars(container) {
  const width = container?.clientWidth || 1200;
  return Math.ceil(width / MIN_BAR_SPACING);
}

function estimateInitialLimit(container) {
  const screenBars = estimateScreenBars(container);
  return Math.max(
    MIN_INITIAL_BARS,
    Math.min(MAX_INITIAL_BARS, Math.ceil(screenBars * INITIAL_LOAD_SCREENS)),
  );
}

function createConstantLine(points, value) {
  return points.map((point) => ({
    time: point.time,
    value,
  }));
}

function createPaneGuideData(candles, value = 0) {
  return candles.map((point) => ({
    time: point.time,
    value,
  }));
}

function hasVisibleIndicator(indicators, type) {
  return indicators.some((indicator) => indicator.type === type && indicator.visible);
}

function createBaseChart(container, options = {}) {
  const chartTimeZone = options.chartTimeZone || systemTimeZone();
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
      timeFormatter: (time) => formatChartTime(normalizeCrosshairTime(time), options.timeframe, chartTimeZone),
    },
    timeScale: {
      borderColor: "#1c212d",
      timeVisible: true,
      minBarSpacing: MIN_BAR_SPACING,
      visible: options.timeScaleVisible ?? true,
      tickMarkFormatter: (time) => formatChartTickTime(normalizeCrosshairTime(time), options.timeframe, chartTimeZone),
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

function placeAllChartsAtLatest(chartsRef, candleCount, visibleBars, chartSyncingRef = null) {
  if (!candleCount) {
    return;
  }

  const logicalTo = candleCount - 1;
  const logicalFrom = Math.max(0, logicalTo - Math.max(20, visibleBars || 0));
  const range = {
    from: logicalFrom,
    to: logicalTo,
  };

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

function setAllChartsVisibleRange(chartsRef, range, chartSyncingRef = null) {
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

function setAllChartsTimeFormatter(chartsRef, timeframe, chartTimeZone) {
  getActiveCharts(chartsRef).forEach((chart) => {
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => formatChartTime(normalizeCrosshairTime(time), timeframe, chartTimeZone),
      },
      timeScale: {
        tickMarkFormatter: (time) => formatChartTickTime(normalizeCrosshairTime(time), timeframe, chartTimeZone),
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

function valueAtOrBefore(line, time) {
  if (!line || time === null || time === undefined) {
    return undefined;
  }

  const exact = line.valuesByTime?.get(time);
  if (exact !== undefined) {
    return exact;
  }

  const points = line.points || [];
  let low = 0;
  let high = points.length - 1;
  let answer = undefined;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].time <= time) {
      answer = points[mid].value;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer;
}

function nearestCandleTimeForCoordinate(chart, candles, x) {
  if (!chart || !candles.length || !Number.isFinite(x)) {
    return null;
  }

  let nearest = null;
  let nearestDistance = Infinity;

  candles.forEach((candle) => {
    const coordinate = chart.timeScale().timeToCoordinate(candle.time);
    if (!Number.isFinite(coordinate)) {
      return;
    }

    const distance = Math.abs(coordinate - x);
    if (distance < nearestDistance) {
      nearest = candle.time;
      nearestDistance = distance;
    }
  });

  return nearest;
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
      const value = valueAtOrBefore(line, time);
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

function priceAtSourcePoint(sourceChart, chartsRef, seriesRef, sourcePoint) {
  if (sourceChart !== chartsRef.current.price || !sourcePoint || !seriesRef.current.candles) {
    return null;
  }

  const price = seriesRef.current.candles.coordinateToPrice(sourcePoint.y);
  return Number.isFinite(price) ? price : null;
}

function crosshairTargetForChart(chart, time, chartsRef, seriesRef, candleByTime, resolvedIndicators, sourceChart, sourcePoint) {
  const chartKey = chartKeyForChart(chart, chartsRef);

  if (!chartKey) {
    return null;
  }

  const candle = candleByTime.get(time);

  if (chartKey === "price" && candle && seriesRef.current.candles) {
    const mousePrice = priceAtSourcePoint(sourceChart, chartsRef, seriesRef, sourcePoint);
    if (mousePrice === null) {
      return null;
    }
    return {
      series: seriesRef.current.candles,
      value: mousePrice,
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

function mirrorCrosshairToCharts(sourceChart, rawTime, chartsRef, seriesRef, candleByTime, resolvedIndicators, crosshairSyncingRef, sourcePoint = null) {
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
    if (targetChart === sourceChart && sourceChart !== chartsRef.current.price) {
      return;
    }

    const target = crosshairTargetForChart(
      targetChart,
      time,
      chartsRef,
      seriesRef,
      candleByTime,
      resolvedIndicators,
      sourceChart,
      sourcePoint,
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

function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v5" />
      <path d="M10 6.2h.01" />
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
  const [requestedTimeframe, setRequestedTimeframe] = useState("1d");
  const [chartError, setChartError] = useState("");
  const [indicatorError, setIndicatorError] = useState("");
  const [loading, setLoading] = useState(false);
  const [candles, setCandles] = useState([]);
  const [cursorTime, setCursorTime] = useState(null);
  const [apiHealth, setApiHealth] = useState(null);
  const [dataSourceInfo, setDataSourceInfo] = useState(DEFAULT_SOURCE_INFO);
  const [sourceInfoOpen, setSourceInfoOpen] = useState(false);

  const [timeframeMenuOpen, setTimeframeMenuOpen] = useState(false);
  const [indicatorPickerOpen, setIndicatorPickerOpen] = useState(false);
  const [indicatorSettingsOpen, setIndicatorSettingsOpen] = useState(false);
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  const [chartSettings, setChartSettings] = useState(() => ({
    timezoneMode: "system",
    customTimezone: systemTimeZone(),
    includeExtendedHours: true,
    adjustDataForDividends: true,
  }));
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
  const sessionBackgroundCanvasRef = useRef(null);
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
  const lastLoadedMetaRef = useRef({ ticker: "", timeframe: "" });
  const streamSocketRef = useRef(null);
  const streamTimeframeRef = useRef(timeframe);
  const streamSettingsRef = useRef(chartSettings);
  const chartReloadingRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const seriesRef = useRef({
    candles: null,
    volume: null,
    paneGuides: {
      rsi: null,
      macd: null,
    },
    indicators: new Map(),
  });
  const loadedBoundsRef = useRef({ first: null, last: null });

  const normalizedTicker = useMemo(() => normalizeTicker(ticker), [ticker]);
  const chartTimeZone = useMemo(() => resolveChartTimeZone(chartSettings), [chartSettings]);
  const supportedTimezones = useMemo(() => timezoneOptions(), []);
  const apiAvailable = apiHealth?.api_available === true;
  const hasCandles = candles.length > 0;
  const streamEnabled = useMemo(() => {
    const seconds = timeframeSeconds(timeframe);
    return Boolean(seconds);
  }, [timeframe]);

  useEffect(() => {
    streamTimeframeRef.current = timeframe;
  }, [timeframe]);

  useEffect(() => {
    streamSettingsRef.current = chartSettings;
  }, [chartSettings]);

  const indicatorConfigById = useMemo(
    () => new Map(indicators.map((indicator) => [indicator.id, indicator])),
    [indicators],
  );

  useEffect(() => {
    let canceled = false;

    async function loadApiHealth() {
      try {
        const response = await fetch("/api/market-data/health");
        if (!response.ok) {
          throw new Error(`Health check failed (${response.status})`);
        }
        const payload = await response.json();
        if (!canceled) {
          setApiHealth(payload);
        }
      } catch (error) {
        if (!canceled) {
          setApiHealth({
            api_available: false,
            provider: "Massive/Polygon.io",
            local_provider: "TwelveData",
            reason: error instanceof Error ? error.message : "API health check failed",
            delayed: true,
            delay_minutes: 15,
          });
        }
      }
    }

    loadApiHealth();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (apiHealth && !apiAvailable && timeframeRequiresApi(requestedTimeframe)) {
      setRequestedTimeframe("5m");
    }
  }, [apiHealth, apiAvailable, requestedTimeframe]);

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
            const value = valueAtOrBefore(line, cursorSnapshot.time);
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
      chartTimeZone,
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
        paneGuides: {
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
      seriesRef.current.volume?.applyOptions({ visible: showVolume });

      if (showRsiPane && rsiContainerRef.current && !chartsRef.current.rsi) {
        const rsiChart = createBaseChart(rsiContainerRef.current, {
          timeScaleVisible: false,
          timeframe,
          chartTimeZone,
        });

        const rsiGuideSeries = rsiChart.addLineSeries({
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
        rsiGuideSeries.setData(createPaneGuideData(candles, 50));

        rsiChart.priceScale("right").applyOptions({
          autoScale: true,
          mode: 0,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        chartsRef.current.rsi = rsiChart;
        seriesRef.current.paneGuides.rsi = rsiGuideSeries;
      }

      if (!showRsiPane && chartsRef.current.rsi) {
        chartsRef.current.rsi.remove();
        chartsRef.current.rsi = null;
        seriesRef.current.paneGuides.rsi = null;
      }

      if (showMacdPane && macdContainerRef.current && !chartsRef.current.macd) {
        const macdChart = createBaseChart(macdContainerRef.current, {
          timeScaleVisible: false,
          timeframe,
          chartTimeZone,
        });

        const macdGuideSeries = macdChart.addLineSeries({
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
        macdGuideSeries.setData(createPaneGuideData(candles, 0));

        macdChart.priceScale("right").applyOptions({
          autoScale: true,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        chartsRef.current.macd = macdChart;
        seriesRef.current.paneGuides.macd = macdGuideSeries;
      }

      if (!showMacdPane && chartsRef.current.macd) {
        chartsRef.current.macd.remove();
        chartsRef.current.macd = null;
        seriesRef.current.paneGuides.macd = null;
      }

      setAllChartsTimeScaleVisibility(chartsRef);

      window.requestAnimationFrame(() => {
        const priceRange = chartsRef.current.price?.timeScale().getVisibleLogicalRange();
        syncChartsToLogicalRange(chartsRef, chartsRef.current.price, priceRange, chartSyncingRef);
        updatePaneReadyState(chartsRef, setPaneReady);
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
    seriesRef.current.paneGuides.rsi?.setData(createPaneGuideData(candles, 50));
    seriesRef.current.paneGuides.macd?.setData(createPaneGuideData(candles, 0));
  }, [candles, showVolume, showRsiPane, showMacdPane]);

  useEffect(() => {
    setAllChartsTimeFormatter(chartsRef, timeframe, chartTimeZone);
  }, [timeframe, chartTimeZone, paneReady.volume, paneReady.rsi, paneReady.macd]);

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

    setLoading(true);
    chartReloadingRef.current = true;
    setChartError("");
    setIndicatorError("");

    loadedBoundsRef.current = { first: null, last: null };
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;

    const loadTimeframe = requestedTimeframe;
    const loadSettings = chartSettings;
    const screenBars = estimateScreenBars(shellRef.current);
    const visibleLimit = estimateInitialLimit(shellRef.current);
    const bufferLimit = Math.max(50, Math.min(MAX_INITIAL_BARS, Math.ceil(screenBars * BUFFER_LOAD_SCREENS)));

    async function fetchCandles(bounds = {}, limit = visibleLimit) {
      const query = chartQueryString(loadTimeframe, limit, loadSettings, bounds);
      const response = await fetch(
        `/api/stocks/${encodeURIComponent(normalizedTicker)}/candles?${query}`,
      );

      if (!response.ok) {
        throw new Error(`Failed to load candles (${response.status})`);
      }

      return response.json();
    }

    function applyCandles(nextCandles, payload, options = {}) {
      const previousRange = chartsRef.current.price?.timeScale().getVisibleLogicalRange();
      setCandles(nextCandles);
      setDataSourceInfo(sourceInfoFromPayload(payload));
      seriesRef.current.candles?.setData(nextCandles);
      seriesRef.current.paneGuides.rsi?.setData(createPaneGuideData(nextCandles, 50));
      seriesRef.current.paneGuides.macd?.setData(createPaneGuideData(nextCandles, 0));
      seriesRef.current.volume?.setData(volumeBarsFromCandles(nextCandles));
      seriesRef.current.volume?.applyOptions({ visible: showVolume });

      loadedBoundsRef.current = {
        first: nextCandles[0]?.time ?? null,
        last: nextCandles[nextCandles.length - 1]?.time ?? null,
      };

      if (options.shiftOlderBy && previousRange) {
        setAllChartsVisibleRange(
          chartsRef,
          {
            from: previousRange.from + options.shiftOlderBy,
            to: previousRange.to + options.shiftOlderBy,
          },
          chartSyncingRef,
        );
      }
    }

    async function loadBufferRound(direction, currentCandles) {
      if (!currentCandles.length) {
        return currentCandles;
      }

      const bounds = direction === "older"
        ? { before: currentCandles[0].time }
        : { after: currentCandles[currentCandles.length - 1].time };

      try {
        const payload = await fetchCandles(bounds, bufferLimit);
        if (canceled) {
          return currentCandles;
        }

        const fetchedCandles = uniqueSortedCandles(payload.candles || []);
        if (!fetchedCandles.length) {
          return currentCandles;
        }

        const mergedCandles = uniqueSortedCandles(
          direction === "older"
            ? [...fetchedCandles, ...currentCandles]
            : [...currentCandles, ...fetchedCandles],
        );
        const addedBars = mergedCandles.length - currentCandles.length;
        if (addedBars <= 0) {
          return currentCandles;
        }

        applyCandles(mergedCandles, payload, {
          shiftOlderBy: direction === "older" ? addedBars : 0,
        });
        return mergedCandles;
      } catch (error) {
        return currentCandles;
      }
    }

    async function loadInitialCandles() {
      try {
        const payload = await fetchCandles({}, visibleLimit);
        const loadedCandles = uniqueSortedCandles(payload.candles || []);
        if (!loadedCandles.length) {
          throw new Error("No candle data returned");
        }

        if (canceled) {
          return;
        }

        setIndicatorOutputs([]);
        removeAllIndicatorSeries(seriesRef);
        setCursorTime(loadedCandles[loadedCandles.length - 1].time);
        setTimeframe(loadTimeframe);
        setAllChartsTimeFormatter(chartsRef, loadTimeframe, chartTimeZone);
        applyCandles(loadedCandles, payload);

        placeAllChartsAtLatest(
          chartsRef,
          loadedCandles.length,
          screenBars,
          chartSyncingRef,
        );

        setLoading(false);
        chartReloadingRef.current = false;

        lastLoadedMetaRef.current = {
          ticker: normalizedTicker,
          timeframe: loadTimeframe,
          chartSettings: loadSettings,
        };

        let stagedCandles = loadedCandles;
        for (let round = 0; round < BUFFER_LOAD_ROUNDS && !canceled; round += 1) {
          stagedCandles = await loadBufferRound("older", stagedCandles);
          stagedCandles = await loadBufferRound("newer", stagedCandles);
        }
      } catch (error) {
        if (!canceled) {
          loadedBoundsRef.current = { first: null, last: null };
          setChartError(error instanceof Error ? error.message : "Failed to load chart data");
        }
      } finally {
        if (!canceled) {
          setLoading(false);
          chartReloadingRef.current = false;
        }
      }
    }

    loadInitialCandles();

    return () => {
      canceled = true;
      chartReloadingRef.current = false;
    };
  }, [normalizedTicker, requestedTimeframe, chartSettings, chartTimeZone]);

  useEffect(() => {
    if (!normalizedTicker || !hasCandles || !streamEnabled) {
      return undefined;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const websocket = new WebSocket(`${protocol}://${window.location.host}/api/stocks/${encodeURIComponent(normalizedTicker)}/stream`);
    streamSocketRef.current = websocket;

    websocket.onmessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "status") {
        setDataSourceInfo(sourceInfoFromPayload(payload));
        return;
      }

      if (payload.type === "error") {
        setDataSourceInfo((current) => ({ ...current, stream_error: payload.message }));
        return;
      }

      if (payload.type !== "trade" && payload.type !== "aggregate") {
        return;
      }
      if (chartReloadingRef.current) {
        return;
      }

      setDataSourceInfo(sourceInfoFromPayload(payload));
      setCandles((current) => {
        const merged = mergeStreamEventIntoCandles(
          current,
          payload,
          streamTimeframeRef.current,
          streamSettingsRef.current,
        );
        if (merged === current) {
          return current;
        }

        seriesRef.current.candles?.setData(merged);
        seriesRef.current.volume?.setData(volumeBarsFromCandles(merged));
        seriesRef.current.paneGuides.rsi?.setData(createPaneGuideData(merged, 50));
        seriesRef.current.paneGuides.macd?.setData(createPaneGuideData(merged, 0));

        loadedBoundsRef.current = {
          first: merged[0]?.time ?? null,
          last: merged[merged.length - 1]?.time ?? null,
        };

        return merged;
      });
    };

    websocket.onerror = () => {
      setDataSourceInfo((current) => ({ ...current, stream_error: "Streaming connection failed" }));
    };

    return () => {
      if (streamSocketRef.current === websocket) {
        streamSocketRef.current = null;
      }
      websocket.close();
    };
  }, [normalizedTicker, hasCandles, streamEnabled]);

  useEffect(() => {
    const charts = getActiveCharts(chartsRef);

    if (!charts.length) {
      return undefined;
    }

    let debounceId = null;
    const batchLimit = Math.max(50, Math.min(MAX_INITIAL_BARS, estimateScreenBars(shellRef.current)));

    async function loadMore(direction) {
      if (!normalizedTicker || !candles.length || chartReloadingRef.current) {
        return;
      }

      const bounds = loadedBoundsRef.current;
      if (direction === "older") {
        if (loadingOlderRef.current || !bounds.first) {
          return;
        }
        loadingOlderRef.current = true;
      } else {
        if (loadingNewerRef.current || !bounds.last) {
          return;
        }
        loadingNewerRef.current = true;
      }

      try {
        const query = chartQueryString(
          timeframe,
          batchLimit,
          chartSettings,
          direction === "older" ? { before: bounds.first } : { after: bounds.last },
        );
        const response = await fetch(`/api/stocks/${encodeURIComponent(normalizedTicker)}/candles?${query}`);
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        const fetchedCandles = uniqueSortedCandles(payload.candles || []);
        if (!fetchedCandles.length) {
          return;
        }

        const previousRange = chartsRef.current.price?.timeScale().getVisibleLogicalRange();
        const mergedCandles = uniqueSortedCandles(
          direction === "older"
            ? [...fetchedCandles, ...candles]
            : [...candles, ...fetchedCandles],
        );
        const addedBars = mergedCandles.length - candles.length;
        if (addedBars <= 0) {
          return;
        }

        setCandles(mergedCandles);
        setDataSourceInfo(sourceInfoFromPayload(payload));
        seriesRef.current.candles?.setData(mergedCandles);
        seriesRef.current.volume?.setData(volumeBarsFromCandles(mergedCandles));
        seriesRef.current.volume?.applyOptions({ visible: showVolume });
        seriesRef.current.paneGuides.rsi?.setData(createPaneGuideData(mergedCandles, 50));
        seriesRef.current.paneGuides.macd?.setData(createPaneGuideData(mergedCandles, 0));
        loadedBoundsRef.current = {
          first: mergedCandles[0]?.time ?? null,
          last: mergedCandles[mergedCandles.length - 1]?.time ?? null,
        };

        if (direction === "older" && previousRange) {
          setAllChartsVisibleRange(
            chartsRef,
            {
              from: previousRange.from + addedBars,
              to: previousRange.to + addedBars,
            },
            chartSyncingRef,
          );
        }
      } finally {
        if (direction === "older") {
          loadingOlderRef.current = false;
        } else {
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
          const nextTime = nearestCandleTimeForCoordinate(sourceChart, candles, lastPoint.x);

          if (nextTime) {
            setCursorTime(nextTime);
          }

          mirrorCrosshairToCharts(
            sourceChart,
            nextTime,
            chartsRef,
            seriesRef,
            candleByTime,
            resolvedIndicators,
            crosshairSyncingRef,
            lastPoint,
          );
        }

        if (debounceId) {
          window.clearTimeout(debounceId);
        }

        debounceId = window.setTimeout(() => {
          const visibleBars = Math.max(20, range.to - range.from);
          const threshold = Math.max(20, visibleBars);

          if (range.from < threshold) {
            loadMore("older");
          }

          if (range.to > candles.length - 1 - threshold) {
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
    chartSettings,
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
              include_extended_hours: chartSettings.includeExtendedHours,
              adjusted: chartSettings.adjustDataForDividends,
              candles: indicatorTimeframe === timeframe ? candles : null,
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
  }, [normalizedTicker, timeframe, indicators, candles, paneReady.rsi, paneReady.macd, chartSettings]);

  // volume visibility is handled by creating/removing the volume chart

  useEffect(() => {
    const priceChart = chartsRef.current.price;
    const rsiChart = chartsRef.current.rsi;
    const macdChart = chartsRef.current.macd;

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

  }, [resolvedIndicators, showRsiPane, showMacdPane, showVolume, paneReady.rsi, paneReady.macd]);

  useEffect(() => {
    const canvas = sessionBackgroundCanvasRef.current;
    const container = priceContainerRef.current;
    const priceChart = chartsRef.current.price;

    if (!canvas || !container || !priceChart) {
      return undefined;
    }

    let animationFrame = null;

    const resizeCanvas = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const nextWidth = Math.max(1, Math.floor(width * dpr));
      const nextHeight = Math.max(1, Math.floor(height * dpr));

      if (canvas.width !== nextWidth) {
        canvas.width = nextWidth;
      }
      if (canvas.height !== nextHeight) {
        canvas.height = nextHeight;
      }
    };

    const clear = () => {
      const context = canvas.getContext("2d");
      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
    };

    const draw = () => {
      animationFrame = null;
      clear();

      if (!chartSettings.includeExtendedHours || !candles.length || timeframe.endsWith("d") || timeframe.endsWith("w") || timeframe.endsWith("mo")) {
        return;
      }

      const context = canvas.getContext("2d");
      const width = container.clientWidth;
      const height = container.clientHeight;
      const halfBarWidth = Math.max(
        1,
        (priceChart.timeScale().options().barSpacing || MIN_BAR_SPACING) / 2,
      );

      let activeSpan = null;

      const flushSpan = () => {
        if (!activeSpan) {
          return;
        }
        context.fillStyle = activeSpan.session === "pre" ? PRE_MARKET_BACKGROUND : AFTER_MARKET_BACKGROUND;
        context.fillRect(activeSpan.left, 0, Math.max(1, activeSpan.right - activeSpan.left), height);
        activeSpan = null;
      };

      const visiblePoints = candles
        .map((candle) => ({
          candle,
          x: priceChart.timeScale().timeToCoordinate(candle.time),
        }))
        .filter((point) => Number.isFinite(point.x) && point.x >= -width && point.x <= width * 2)
        .sort((left, right) => left.x - right.x);

      visiblePoints.forEach((point) => {
        const { candle, x } = point;
        const session = marketSession(candle.time);
        if (session === "regular") {
          flushSpan();
          return;
        }

        const left = Math.max(0, x - halfBarWidth);
        const right = Math.min(width, x + halfBarWidth);

        if (right <= 0 || left >= width || right <= left) {
          flushSpan();
          return;
        }

        if (!activeSpan || activeSpan.session !== session || left > activeSpan.right + 1) {
          flushSpan();
          activeSpan = { session, left, right };
          return;
        }

        activeSpan.right = Math.max(activeSpan.right, right);
      });

      flushSpan();
    };

    const scheduleDraw = () => {
      if (animationFrame) {
        return;
      }
      animationFrame = window.requestAnimationFrame(draw);
    };

    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
      scheduleDraw();
    });
    resizeObserver.observe(container);
    resizeCanvas();
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
  }, [candles, timeframe, chartSettings.includeExtendedHours]);

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

    const updateSharedLine = (sourceChart, candleTime) => {
      const line = sharedCrosshairRef.current;
      const shell = shellRef.current;

      if (!line || !shell || !candleTime) {
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
      const candleX = sourceChart.timeScale().timeToCoordinate(candleTime);

      if (!Number.isFinite(candleX)) {
        line.style.display = "none";
        return;
      }

      const x = paneRect.left - shellRect.left + candleX;

      line.style.transform = `translateX(${x}px)`;
      line.style.display = "block";

      lastCrosshairTimeRef.current = candleTime;
    };

    const handlers = charts.map((chart) => {
      const handler = (param) => {
        if (crosshairSyncingRef.current) {
          return;
        }

        const nextTime = param?.point
          ? nearestCandleTimeForCoordinate(chart, candles, param.point.x)
          : normalizeCrosshairTime(param?.time);

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

        updateSharedLine(chart, nextTime);
        mirrorCrosshairToCharts(
          chart,
          nextTime,
          chartsRef,
          seriesRef,
          candleByTime,
          resolvedIndicators,
          crosshairSyncingRef,
          param?.point || null,
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

  /** Opens the indicator catalog modal. */
  const openIndicatorPicker = () => {
    setIndicatorPickerOpen(true);
    setIndicatorSettingsOpen(false);
  };

  /** Opens settings for a new indicator while preserving singleton volume behavior. */
  const openNewIndicatorSettings = (type) => {
    const source = type === "VOLUME"
      ? indicators.find((indicator) => indicator.type === type) || null
      : null;
    setIndicatorDraft(createIndicatorDraft(type, indicators.length, source));
    setIndicatorPickerOpen(false);
    setIndicatorSettingsOpen(true);
  };

  /** Opens settings for an existing indicator instance. */
  const openEditIndicatorSettings = (indicator) => {
    setIndicatorDraft(createIndicatorDraft(indicator.type, indicators.length, indicator));
    setIndicatorPickerOpen(false);
    setIndicatorSettingsOpen(true);
  };

  /** Saves the active indicator draft as a new or existing indicator config. */
  const saveIndicatorSettings = () => {
    const period = indicatorNeedsPeriod(indicatorDraft.type) ? clampPeriod(indicatorDraft.period) : null;
    const lineWidth = Math.max(1, Math.min(Number.parseInt(indicatorDraft.lineWidth, 10) || 1, 4));

    if (indicatorNeedsPeriod(indicatorDraft.type) && !period) {
      return;
    }

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
    const matchingConfig = !indicatorDraft.id
      ? indicators.find((indicator) => indicatorConfigKey(indicator) === indicatorConfigKey({
          type: indicatorDraft.type,
          ...settings,
        }))
      : null;
    const existingSameType = !indicatorDraft.id && indicatorDraft.type === "VOLUME"
      ? indicators.find((indicator) => indicator.type === indicatorDraft.type)
      : null;
    const targetId = indicatorDraft.id || matchingConfig?.id || existingSameType?.id;

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
            ) : indicator.visible ? (
              <span className="indicator-value-muted">...</span>
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
            <div className="menu-popover">
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
                        {options.map((option) => {
                          const disabled = option.requiresApi && !apiAvailable;
                          return (
                            <button
                              key={option.value}
                              className={requestedTimeframe === option.value ? "selected" : ""}
                              type="button"
                              disabled={disabled}
                              title={disabled ? "API is currently unavailable for this timeframe." : option.label}
                              onClick={() => {
                                if (disabled) {
                                  return;
                                }
                                setRequestedTimeframe(option.value);
                                setTimeframeMenuOpen(false);
                              }}
                            >
                              <span>{option.shortLabel}</span>
                              <small>{option.label}</small>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="tv-tool-button" type="button" onClick={openIndicatorPicker}>
              <strong>Indicators</strong>
            </button>

            <div className="menu-popover">
              <button
                className="tv-tool-button source-info-button"
                type="button"
                title="Data source"
                onClick={() => setSourceInfoOpen((open) => !open)}
                aria-expanded={sourceInfoOpen}
              >
                <InfoIcon />
              </button>
              {sourceInfoOpen && (
                <div className="tv-dropdown source-info-popover">
                  <strong>{sourceModeLabel(dataSourceInfo.source_mode)}</strong>
                  <span>Source: {dataSourceInfo.source_provider}</span>
                  {dataSourceInfo.delayed && (
                    <span>{dataSourceInfo.delay_minutes || 15}-minute delayed</span>
                  )}
                  {dataSourceInfo.stream_error && (
                    <small>Streaming unavailable: {dataSourceInfo.stream_error}</small>
                  )}
                  {!apiAvailable && apiHealth?.reason && (
                    <small>API unavailable: {apiHealth.reason}</small>
                  )}
                </div>
              )}
            </div>
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
                        <option key={option.value} value={option.value} disabled={option.requiresApi && !apiAvailable}>
                          {option.label}{option.requiresApi && !apiAvailable ? " (API unavailable)" : ""}
                        </option>
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

        {chartSettingsOpen && (
          <div className="modal-backdrop" onMouseDown={() => setChartSettingsOpen(false)}>
            <div className="indicator-settings-modal chart-settings-modal" role="dialog" aria-modal="true" aria-label="Chart settings" onMouseDown={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h2>Chart settings</h2>
                  <p>{timezoneLabel(chartTimeZone)}</p>
                </div>
                <button type="button" className="modal-close" onClick={() => setChartSettingsOpen(false)}>x</button>
              </div>

              <div className="settings-grid">
                <label>
                  Timezone
                  <select
                    value={chartSettings.timezoneMode}
                    onChange={(event) => setChartSettings((settings) => ({ ...settings, timezoneMode: event.target.value }))}
                  >
                    <option value="system">System</option>
                    <option value="exchange">Exchange</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>

                {chartSettings.timezoneMode === "custom" && (
                  <label>
                    Location
                    <select
                      value={chartSettings.customTimezone}
                      onChange={(event) => setChartSettings((settings) => ({ ...settings, customTimezone: event.target.value }))}
                    >
                      {supportedTimezones.map((timeZone) => (
                        <option key={timeZone} value={timeZone}>{timezoneLabel(timeZone)}</option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={chartSettings.includeExtendedHours}
                    onChange={(event) => setChartSettings((settings) => ({ ...settings, includeExtendedHours: event.target.checked }))}
                  />
                  <span>Include market data outside regular trading hours</span>
                </label>

                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={chartSettings.adjustDataForDividends}
                    onChange={(event) => setChartSettings((settings) => ({ ...settings, adjustDataForDividends: event.target.checked }))}
                  />
                  <span>Adjust data for dividends</span>
                </label>
              </div>

              <div className="modal-actions">
                <button type="button" className="tv-tool-button active" onClick={() => setChartSettingsOpen(false)}>Done</button>
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
            loading ? "is-loading" : "",
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
            <canvas ref={sessionBackgroundCanvasRef} className="session-background-canvas" aria-hidden="true" />
            <canvas ref={vwapFillCanvasRef} className="vwap-fill-canvas" aria-hidden="true" />
            {renderIndicatorStack(indicatorSummariesByPane.price)}
            <button
              type="button"
              className="chart-settings-button"
              title="Chart settings"
              aria-label="Chart settings"
              onClick={() => setChartSettingsOpen(true)}
            >
              <CogIcon />
            </button>

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
