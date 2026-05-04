import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createChart } from "lightweight-charts";
import HeaderBar from "../components/HeaderBar";
import { formatChartTime, normalizeTicker } from "../lib/tradingview";

const TIMEFRAME_OPTIONS = [
  { label: "5m", value: "5m" },
  { label: "1h", value: "1h" },
  { label: "1d", value: "1d" },
];

const INDICATOR_TYPES = ["SMA", "EMA", "WMA", "VWAP", "RSI", "MACD", "BBANDS"];
const INDICATOR_PERIOD_PRESETS = {
  SMA: [9, 14, 20, 50, 100, 200],
  EMA: [9, 12, 20, 50, 100, 200],
  WMA: [9, 14, 20, 50, 100],
  VWAP: [14, 20, 50],
  RSI: [7, 14, 21],
  MACD: [8, 12, 21],
  BBANDS: [14, 20, 50],
};

const INDICATOR_COLORS = [
  "#f5a623",
  "#4aa3ff",
  "#63d471",
  "#ff7a59",
  "#bf7cff",
  "#ffcc66",
  "#37c3ff",
  "#e56b8a",
  "#5bc0be",
];

const MIN_BAR_SPACING = 4;
const SCREEN_BUFFER_MULTIPLIER = 3;
const LOAD_EDGE_THRESHOLD_RATIO = 0.35;
const MIN_INITIAL_BARS = 300;
const MAX_INITIAL_BARS = 1200;
const MIN_BATCH_BARS = 150;
const MAX_BATCH_BARS = 800;

const PRICE_PANE_MIN_HEIGHT = 360;
const VOLUME_PANE_HEIGHT = 90;
const RSI_PANE_HEIGHT = 120;
const MACD_PANE_HEIGHT = 130;

const RIGHT_PRICE_SCALE_WIDTH = 82;

function clampPeriod(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(2, Math.min(parsed, 400));
}

function indicatorNeedsPeriod(type) {
  return true;
}

function defaultPeriodForIndicator(type) {
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

function periodPresetsForIndicator(type) {
  return INDICATOR_PERIOD_PRESETS[type] || [defaultPeriodForIndicator(type)];
}

function pickColor(index) {
  return INDICATOR_COLORS[index % INDICATOR_COLORS.length];
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
  return Number(value).toFixed(0);
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

function rsiAutoscaleProvider() {
  return {
    priceRange: {
      minValue: 0,
      maxValue: 100,
    },
  };
}

function createConstantLine(points, value) {
  return points.map((point) => ({
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
        color: "rgba(42, 49, 66, 0)",
        labelVisible: false,
      },
      horzLine: {
        color: "#2a3142",
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
      window.requestAnimationFrame(() => {
        chartSyncingRef.current = false;
      });
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

      chart.timeScale().applyOptions({
        visible: chart === visibleTimeScaleChart,
      });
    });
  }

  function volumeBarsFromCandles(candles) {
    return candles.map((bar) => ({
      time: bar.time,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(34, 171, 148, 0.55)" : "rgba(242, 54, 69, 0.55)",
    }));
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

function indicatorChipLabel(indicator) {
  if (indicator.type === "VWAP") {
    return "VWAP";
  }
  if (indicator.type === "MACD") {
    const fast = indicator.period || 12;
    const slow = Math.max(fast + 1, Math.round(fast * 2.2));
    return `MACD ${fast}/${slow}/9`;
  }
  return `${indicator.type} ${indicator.period}`;
}

function resolveLineColor(indicatorType, label, baseColor, lineIndex) {
  if (indicatorType === "MACD") {
    if (label === "Signal") {
      return "#7da2ff";
    }
    if (label === "Histogram") {
      return "#94a6cc";
    }
    return baseColor;
  }

  if (indicatorType === "BBANDS") {
    if (lineIndex === 0) {
      return "#7da2ff";
    }
    if (lineIndex === 2) {
      return "#f5a623";
    }
  }

  if (indicatorType === "VWAP") {
    if (lineIndex === 1 || lineIndex === 2) {
      return "#7da2ff";
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
  const [showVolume, setShowVolume] = useState(true);
  const [candles, setCandles] = useState([]);
  const [cursorTime, setCursorTime] = useState(null);

  const [indicatorType, setIndicatorType] = useState("SMA");
  const [indicatorPeriodChoice, setIndicatorPeriodChoice] = useState("20");
  const [customPeriodInput, setCustomPeriodInput] = useState("20");

  const [indicators, setIndicators] = useState([
    { id: "sma-20-default", type: "SMA", period: 20, color: pickColor(0), visible: true },
  ]);
  const [indicatorOutputs, setIndicatorOutputs] = useState([]);
  const [paneReady, setPaneReady] = useState({
    volume: false,
    rsi: false,
    macd: false,
  });

  const shellRef = useRef(null);
  const priceContainerRef = useRef(null);
  const volumeContainerRef = useRef(null);
  const rsiContainerRef = useRef(null);
  const macdContainerRef = useRef(null);

  const chartsRef = useRef({
    price: null,
    volume: null,
    rsi: null,
    macd: null,
  });
  const chartSyncingRef = useRef(false);
  const pendingPaneInitRef = useRef(null);
  const sharedCrosshairRef = useRef(null);
  const lastCrosshairTimeRef = useRef(null);
  const preservedLogicalRangeRef = useRef(null);
  const lastLoadedMetaRef = useRef({ ticker: "", timeframe: "" });
  const viewportSnapshotRef = useRef(null);
  const seriesRef = useRef({
    candles: null,
    volume: null,
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
        const baseColor = config?.color || pickColor(outputIndex);
        const visible = config?.visible ?? true;

        const lines = (output.lines || []).map((line, lineIndex) => {
          const color = resolveLineColor(output.type, line.label, baseColor, lineIndex);
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
          lines,
        };
      }),
    [indicatorOutputs, indicatorConfigById],
  );

  const showRsiPane = useMemo(() => hasVisibleIndicator(indicators, "RSI"), [indicators]);

  const showMacdPane = useMemo(() => hasVisibleIndicator(indicators, "MACD"), [indicators]);

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

    const activeIndicatorValues = resolvedIndicators
      .filter((indicator) => indicator.visible)
      .flatMap((indicator) =>
        indicator.lines.map((line) => ({
          id: `${indicator.id}-${line.id}`,
          label: line.label,
          color: line.color,
          value: resolvedTime ? line.valuesByTime.get(resolvedTime) : undefined,
        })),
      );

    return {
      time: resolvedTime,
      candle,
      activeIndicatorValues,
    };
  }, [candles, candleByTime, cursorTime, resolvedIndicators]);

  const candleTone = useMemo(() => getCandleTone(cursorSnapshot.candle), [cursorSnapshot.candle]);

  const activePeriodPresets = useMemo(() => periodPresetsForIndicator(indicatorType), [indicatorType]);
  const needsPeriod = indicatorNeedsPeriod(indicatorType);

  useEffect(() => {
    const firstPreset = String(periodPresetsForIndicator(indicatorType)[0]);
    setIndicatorPeriodChoice(firstPreset);
    setCustomPeriodInput(firstPreset);
  }, [indicatorType]);

  useEffect(() => {
    if (!priceContainerRef.current) {
      return undefined;
    }

    const priceChart = createBaseChart(priceContainerRef.current, {
      timeScaleVisible: !showVolume && !showRsiPane && !showMacdPane,
    });

    const candleSeries = priceChart.addCandlestickSeries({
      upColor: "#22ab94",
      downColor: "#f23645",
      borderUpColor: "#22ab94",
      borderDownColor: "#f23645",
      wickUpColor: "#22ab94",
      wickDownColor: "#f23645",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    chartsRef.current.price = priceChart;
    seriesRef.current.candles = candleSeries;

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

      if (showVolume && volumeContainerRef.current && !chartsRef.current.volume) {
        const volumeChart = createBaseChart(volumeContainerRef.current, {
          timeScaleVisible: false,
        });

        const volumeSeries = volumeChart.addHistogramSeries({
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: {
            type: "custom",
            formatter: formatVolumeScale,
          },
        });

        chartsRef.current.volume = volumeChart;
        seriesRef.current.volume = volumeSeries;

        volumeChart.priceScale("right").applyOptions({
          autoScale: true,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        if (candles.length) {
          volumeSeries.setData(volumeBarsFromCandles(candles));
        }
      }

      if (!showVolume && chartsRef.current.volume) {
        chartsRef.current.volume.remove();
        chartsRef.current.volume = null;
        seriesRef.current.volume = null;
      }

      if (showRsiPane && rsiContainerRef.current && !chartsRef.current.rsi) {
        const rsiChart = createBaseChart(rsiContainerRef.current, {
          timeScaleVisible: false,
        });

        rsiChart.priceScale("right").applyOptions({
          autoScale: true,
          mode: 0,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        chartsRef.current.rsi = rsiChart;
      }

      if (!showRsiPane && chartsRef.current.rsi) {
        chartsRef.current.rsi.remove();
        chartsRef.current.rsi = null;
      }

      if (showMacdPane && macdContainerRef.current && !chartsRef.current.macd) {
        const macdChart = createBaseChart(macdContainerRef.current, {
          timeScaleVisible: false,
        });

        macdChart.priceScale("right").applyOptions({
          autoScale: true,
          minimumWidth: RIGHT_PRICE_SCALE_WIDTH,
          borderColor: "#1c212d",
          visible: true,
        });

        chartsRef.current.macd = macdChart;
      }

      if (!showMacdPane && chartsRef.current.macd) {
        chartsRef.current.macd.remove();
        chartsRef.current.macd = null;
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
    if (!seriesRef.current.volume || !candles.length) {
      return;
    }

    seriesRef.current.volume.setData(volumeBarsFromCandles(candles));
  }, [candles, showVolume]);

  useEffect(() => {
    const activeIds = new Set(
      indicators
        .filter((indicator) => indicator.visible)
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

        const volumeBars = loadedCandles.map((bar) => ({
          time: bar.time,
          value: bar.volume,
          color: bar.close >= bar.open ? "rgba(34, 171, 148, 0.55)" : "rgba(242, 54, 69, 0.55)",
        }));

        seriesRef.current.volume?.setData(volumeBars);

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
          chartSyncingRef.current = true;

          getActiveCharts(chartsRef).forEach((targetChart) => {
            if (targetChart !== sourceChart) {
              targetChart.timeScale().setVisibleLogicalRange(range);
            }
          });

          chartSyncingRef.current = false;
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
  }, [normalizedTicker, timeframe, candles, showVolume, showRsiPane, showMacdPane, paneReady.volume, paneReady.rsi, paneReady.macd]);

  useEffect(() => {
    let canceled = false;

    if (!normalizedTicker || !candles.length) {
      setIndicatorOutputs([]);
      return undefined;
    }

    if (!indicators.length) {
      setIndicatorOutputs([]);
      return undefined;
    }

    const wantsRsi = indicators.some((indicator) => indicator.type === "RSI" && indicator.visible);
    const wantsMacd = indicators.some((indicator) => indicator.type === "MACD" && indicator.visible);

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
        const payload = {
          timeframe,
          limit: candles.length,
          start_time: candles[0].time,
          end_time: candles[candles.length - 1].time,
          warmup_bars: 300,
          indicators: indicators.filter((ind) => ind.visible).map((indicator) => ({
            id: indicator.id,
            type: indicator.type,
            period: indicatorNeedsPeriod(indicator.type) ? indicator.period : null,
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
        if (!canceled) {
          preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);
          setIndicatorOutputs(indicatorPayload.indicators || []);
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

      const createdEntries = indicator.lines.map((line, lineIndex) => {
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
              color: point.value >= 0 ? "rgba(34, 171, 148, 0.42)" : "rgba(242, 54, 69, 0.42)",
            })),
          );
          histogramSeries.applyOptions({ visible: indicator.visible });
          return {
            chart: targetChart,
            series: histogramSeries,
            lineIndex,
          };
        }

        const lineSeries = targetChart.addLineSeries({
          color: line.color,
          lineWidth: 2,
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

        if (indicator.type === "RSI") {
          lineSeries.applyOptions({
            autoscaleInfoProvider: rsiAutoscaleProvider,
          });
        }

        lineSeries.applyOptions({ visible: indicator.visible });
        return {
          chart: targetChart,
          series: lineSeries,
          lineIndex,
        };
      });

      if (indicator.type === "RSI" && indicator.lines.length > 0 && rsiChart) {
        const basePoints = indicator.lines[0].points;

        if (basePoints.length > 0) {
          const rsiZeroAnchor = rsiChart.addLineSeries({
            color: "rgba(0, 0, 0, 0)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          rsiZeroAnchor.setData(createConstantLine(basePoints, 0));
          rsiZeroAnchor.applyOptions({
            visible: indicator.visible,
            autoscaleInfoProvider: rsiAutoscaleProvider,
          });
          createdEntries.push({
            chart: rsiChart,
            series: rsiZeroAnchor,
            lineIndex: 998,
          });

          const rsiHundredAnchor = rsiChart.addLineSeries({
            color: "rgba(0, 0, 0, 0)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          rsiHundredAnchor.setData(createConstantLine(basePoints, 100));
          rsiHundredAnchor.applyOptions({
            visible: indicator.visible,
            autoscaleInfoProvider: rsiAutoscaleProvider,
          });
          createdEntries.push({
            chart: rsiChart,
            series: rsiHundredAnchor,
            lineIndex: 999,
          });

          const oversoldZoneSeries = rsiChart.addHistogramSeries({
            color: "rgba(242, 54, 69, 0.08)",
            base: 0,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          oversoldZoneSeries.setData(createConstantLine(basePoints, 30));
          oversoldZoneSeries.applyOptions({
            visible: indicator.visible,
            autoscaleInfoProvider: rsiAutoscaleProvider,
          });
          createdEntries.push({
            chart: rsiChart,
            series: oversoldZoneSeries,
            lineIndex: 1000,
          });

          const overboughtZoneSeries = rsiChart.addHistogramSeries({
            color: "rgba(34, 171, 148, 0.08)",
            base: 70,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: rsiPriceFormatter,
            },
          });

          overboughtZoneSeries.setData(createConstantLine(basePoints, 100));
          overboughtZoneSeries.applyOptions({
            visible: indicator.visible,
            autoscaleInfoProvider: rsiAutoscaleProvider,
          });
          createdEntries.push({
            chart: rsiChart,
            series: overboughtZoneSeries,
            lineIndex: 1001,
          });

          const oversoldLineSeries = rsiChart.addLineSeries({
            color: "rgba(242, 54, 69, 0.42)",
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
            autoscaleInfoProvider: rsiAutoscaleProvider,
          });
          createdEntries.push({
            chart: rsiChart,
            series: oversoldLineSeries,
            lineIndex: 1002,
          });

          const overboughtLineSeries = rsiChart.addLineSeries({
            color: "rgba(34, 171, 148, 0.42)",
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
            autoscaleInfoProvider: rsiAutoscaleProvider,
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
        volume: volumeContainerRef,
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
        const nextTime = normalizeCrosshairTime(param?.time);

        if (nextTime) {
          setCursorTime(nextTime);
        }

        updateSharedLine(chart, param);
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
    };

    shellRef.current?.addEventListener("mouseleave", onMouseLeave);

    return () => {
      handlers.forEach(({ chart, handler }) => {
        chart.unsubscribeCrosshairMove(handler);
      });

      shellRef.current?.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [showVolume, showRsiPane, showMacdPane, paneReady.volume, paneReady.rsi, paneReady.macd]);

  const addIndicator = () => {
    preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef);

    let period = null;

    if (indicatorNeedsPeriod(indicatorType)) {
      if (indicatorPeriodChoice === "custom") {
        period = clampPeriod(customPeriodInput);
      } else {
        period = clampPeriod(indicatorPeriodChoice);
      }

      if (!period) {
        return;
      }
    }

    setIndicators((current) => {
      const id = `${indicatorType.toLowerCase()}-${period ?? "na"}-${Date.now()}`;
      return [
        ...current,
        {
          id,
          type: indicatorType,
          period,
          color: pickColor(current.length),
          visible: true,
        },
      ];
    });
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

  return (
    <main className="stock-page">
      <HeaderBar onSearch={(nextTicker) => navigate(`/stock/${encodeURIComponent(nextTicker)}`)} searchDefault={normalizedTicker} />

      <section className="chart-stage" aria-label="Stock chart area">
        <div className="chart-titlebar">
          <p>{normalizedTicker || "Unknown symbol"}</p>
          <Link to="/" className="back-link">Back to movers</Link>
        </div>

        <div className="chart-toolbar">
          <div className="toolbar-group">
            <span className="toolbar-label">Interval</span>
            <div className="chart-tools timeframe-tools">
              {TIMEFRAME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`chip ${timeframe === option.value ? "active" : ""}`}
                  type="button"
                  onClick={() => setTimeframe(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Indicators</span>
            <div className="chart-tools indicator-builder">
              <select value={indicatorType} onChange={(event) => setIndicatorType(event.target.value)} aria-label="Indicator type">
                {INDICATOR_TYPES.map((type) => (
                  <option value={type} key={type}>{type}</option>
                ))}
              </select>

              <select
                value={indicatorPeriodChoice}
                onChange={(event) => setIndicatorPeriodChoice(event.target.value)}
                aria-label="Indicator period presets"
                disabled={!needsPeriod}
              >
                {needsPeriod ? activePeriodPresets.map((value) => (
                  <option key={`${indicatorType}-${value}`} value={String(value)}>{value}</option>
                )) : <option value="none">-</option>}
                {needsPeriod && <option value="custom">Custom...</option>}
              </select>

              {needsPeriod && indicatorPeriodChoice === "custom" && (
                <input
                  type="number"
                  min={2}
                  max={400}
                  value={customPeriodInput}
                  onChange={(event) => setCustomPeriodInput(event.target.value)}
                  aria-label="Custom indicator period"
                />
              )}

              <button className="chip active" type="button" onClick={addIndicator}>Add line</button>
              <button className={`chip ${showVolume ? "active" : ""}`} type="button" onClick={() => { preserveCurrentLogicalRange(chartsRef, preservedLogicalRangeRef); setShowVolume((v) => !v); }}>
                Volume
              </button>
            </div>
          </div>
        </div>

        <div className="indicator-list">
          {indicators.map((indicator) => (
            <div key={indicator.id} className={`indicator-pill ${indicator.visible ? "active" : ""}`}>
              <button
                type="button"
                className="indicator-visibility"
                onClick={() => toggleIndicatorVisibility(indicator.id)}
                title="Toggle visibility"
              >
                <span className="indicator-dot" style={{ backgroundColor: indicator.color }} />
                {indicatorChipLabel(indicator)}
              </button>
              <button
                type="button"
                className="indicator-remove"
                onClick={() => removeIndicator(indicator.id)}
                title="Remove indicator"
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div className="chart-infobar">
          <span className="inf-time"><strong>Time</strong> {formatChartTime(cursorSnapshot.time, timeframe)}</span>
          <span className={`inf-kv tone-${candleTone}`}><strong>O</strong> {formatPrice(cursorSnapshot.candle?.open)}</span>
          <span className={`inf-kv tone-${candleTone}`}><strong>H</strong> {formatPrice(cursorSnapshot.candle?.high)}</span>
          <span className={`inf-kv tone-${candleTone}`}><strong>L</strong> {formatPrice(cursorSnapshot.candle?.low)}</span>
          <span className={`inf-kv tone-${candleTone}`}><strong>C</strong> {formatPrice(cursorSnapshot.candle?.close)}</span>
          <span className={`inf-kv tone-${candleTone}`}><strong>V</strong> {formatVolume(cursorSnapshot.candle?.volume)}</span>
          {cursorSnapshot.activeIndicatorValues.length ? (
            cursorSnapshot.activeIndicatorValues.map((indicator) => (
              <span className="inf-indicator" key={indicator.id} style={{ color: indicator.color }}>
                <strong>{indicator.label}:</strong> {formatPrice(indicator.value)}
              </span>
            ))
          ) : (
            <span className="muted"><strong>Indicators:</strong> none active</span>
          )}
        </div>

        {loading && <p className="chart-status">Loading candles...</p>}
        {chartError && <p className="chart-error">{chartError}</p>}
        {indicatorError && <p className="chart-error">{indicatorError}</p>}

        <div
          ref={shellRef}
          className={[
            "chart-shell",
            showVolume ? "has-volume-pane" : "",
            showRsiPane ? "has-rsi-pane" : "",
            showMacdPane ? "has-macd-pane" : "",
          ].join(" ")}
        >
          <div ref={sharedCrosshairRef} className="shared-crosshair-line" />

          <div
            ref={priceContainerRef}
            className="chart-pane chart-pane-price"
            style={{ minHeight: PRICE_PANE_MIN_HEIGHT }}
          />

          {showVolume && (
            <div
              ref={volumeContainerRef}
              className="chart-pane chart-pane-volume"
              style={{ height: VOLUME_PANE_HEIGHT }}
            />
          )}

          {showRsiPane && (
            <div
              ref={rsiContainerRef}
              className="chart-pane chart-pane-rsi"
              style={{ height: RSI_PANE_HEIGHT }}
            />
          )}

          {showMacdPane && (
            <div
              ref={macdContainerRef}
              className="chart-pane chart-pane-macd"
              style={{ height: MACD_PANE_HEIGHT }}
            />
          )}
        </div>
      </section>
    </main>
  );
}
