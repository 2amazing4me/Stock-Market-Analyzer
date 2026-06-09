import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../components/HeaderBar";
import { logoPresentationStyle } from "../lib/logoPresentation";
import { normalizeTicker } from "../lib/tradingview";

const OPERATORS = [
  { value: "above", label: "Above" },
  { value: "under", label: "Under" },
  { value: "between", label: "Between" },
  { value: "outside", label: "Outside" },
];
const BASE_FILTERS = [
  { id: "price", label: "Price", min: 0, max: 1_000_000, step: "0.01", compact: "currency", detail: "Live last trade or latest snapshot price." },
  { id: "market_cap", label: "Market Cap", min: 0, max: 100_000_000_000_000, step: "1000000", compact: "currency", detail: "Latest available closing/reference company market capitalization." },
  { id: "industry", label: "Industry", type: "category", options: [], detail: "Local company industry classification." },
  { id: "beta", label: "Beta", min: -20, max: 20, step: "0.01", periods: ["1y", "3y", "5y"], defaultPeriod: "5y", detail: "Daily-return beta versus SPY over the selected long-term window." },
  { id: "change", label: "Change", min: -10_000, max: 10_000, step: "0.01", compact: "currency", detail: "Current session absolute change from previous close." },
  { id: "change_pct", label: "Change %", min: -1_000, max: 1_000, step: "0.01", suffix: "%", detail: "Current session percentage change from previous close." },
  { id: "volume", label: "Volume", min: 0, max: 10_000_000_000, step: "1000", compact: "number", detail: "Current session cumulative volume." },
  { id: "dollar_volume", label: "Dollar Volume", min: 0, max: 100_000_000_000_000, step: "1000000", compact: "currency", detail: "Current session price multiplied by volume." },
  { id: "vwap", label: "VWAP", min: 0, max: 1_000_000, step: "0.01", compact: "currency", timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"], defaultTimeframe: "1d", detail: "Volume-weighted average price for the selected candle timeframe." },
  { id: "relative_volume", label: "Relative Volume", min: 0, max: 1_000, step: "0.1", suffix: "x", periods: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"], defaultPeriod: "1d", detail: "Current volume compared with the selected period's historical average. Intraday periods use latest snapshot minute volume estimates." },
  { id: "avg_volume", label: "Average Volume", min: 0, max: 10_000_000_000, step: "1000", compact: "number", periods: [10, 30, 60, 90], defaultPeriod: 30, detail: "Average daily volume over the selected trading-day window." },
  { id: "avg_dollar_volume", label: "Avg Dollar Volume", min: 0, max: 100_000_000_000_000, step: "1000000", compact: "currency", periods: [10, 30, 60, 90], defaultPeriod: 30, detail: "Average daily close multiplied by volume over the selected window." },
  { id: "rsi", label: "RSI", min: 0, max: 100, step: "0.1", timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"], ranges: [7, 14, 21, 30], defaultTimeframe: "1d", defaultRange: 14, detail: "RSI using the selected candle timeframe and range." },
  { id: "atr", label: "ATR", min: 0, max: 10_000, step: "0.1", compact: "number", timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"], ranges: [7, 14, 21, 30], defaultTimeframe: "1d", defaultRange: 14, detail: "ATR using the selected candle timeframe and range." },
  { id: "atr_pct", label: "ATR %", min: 0, max: 1_000, step: "0.1", suffix: "%", timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"], ranges: [7, 14, 21, 30], defaultTimeframe: "1d", defaultRange: 14, detail: "ATR divided by latest price, using the selected candle timeframe and range." },
];
const FILTER_CATEGORY_ORDER = ["fundamental", "technical", "ratios", "market"];
const FILTER_CATEGORY_LABELS = {
  fundamental: "Fundamental",
  technical: "Technical",
  ratios: "Ratios",
  market: "Market",
};
const FILTER_CATEGORY_BY_ID = {
  industry: "fundamental",
  market_cap: "fundamental",
  atr: "technical",
  atr_pct: "technical",
  rsi: "technical",
  vwap: "technical",
  beta: "ratios",
};
const EMPTY_FILTER = { operator: "above", values: ["", ""], selectedValues: [] };
const COMPACT_SUFFIXES = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000,
};
const POPOVER_WIDTH = 260;
const ADD_COLUMN_POPOVER_WIDTH = 300;
const POPOVER_VIEWPORT_PADDING = 16;
const COLUMN_CONTEXT_MENU_WIDTH = 234;
const COLUMN_CONTEXT_MENU_MAX_HEIGHT = 440;
const INITIAL_RENDERED_ROWS = 160;
const RENDERED_ROWS_INCREMENT = 160;
const SCANNER_COLUMNS = [
  { key: "symbol", label: "Symbols", type: "text" },
  { key: "price", label: "Price", type: "number" },
  { key: "change", label: "Change", type: "number" },
  { key: "change_pct", label: "Change %", type: "number" },
  { key: "volume", label: "Volume", type: "number" },
  { key: "dollar_volume", label: "Dollar Vol", type: "number" },
  { key: "vwap", label: "VWAP", type: "number", periodKey: "vwap" },
  { key: "market_cap", label: "Market Cap", type: "number" },
  { key: "relative_volume", label: "Rel Vol", type: "number", periodKey: "relative_volume" },
  { key: "avg_volume", label: "Avg Vol", type: "number", periodKey: "avg_volume" },
  { key: "avg_dollar_volume", label: "Avg Dollar Vol", type: "number", periodKey: "avg_dollar_volume" },
  { key: "beta", label: "Beta", type: "number", periodKey: "beta" },
  { key: "rsi", label: "RSI", type: "number", periodKey: "rsi" },
  { key: "atr", label: "ATR", type: "number", periodKey: "atr" },
  { key: "atr_pct", label: "ATR %", type: "number", periodKey: "atr_pct" },
  { key: "industry", label: "Industry", type: "text" },
];
const DEFAULT_COLUMN_ORDER = SCANNER_COLUMNS.map((column) => column.key);
const HISTORICAL_COLUMN_KEYS = new Set(["relative_volume", "avg_volume", "avg_dollar_volume", "beta", "rsi", "atr", "atr_pct", "vwap"]);
const DEFAULT_METRIC_PERIODS = {
  avg_volume: 30,
  avg_dollar_volume: 30,
  relative_volume: "1d",
  vwap: "1d",
  beta: "5y",
  rsi: { timeframe: "1d", range: 14 },
  atr: { timeframe: "1d", range: 14 },
  atr_pct: { timeframe: "1d", range: 14 },
};
const PERIOD_LABELS = {
  "1m": "1 min",
  "5m": "5 min",
  "15m": "15 min",
  "30m": "30 min",
  "1h": "1 hour",
  "2h": "2 hours",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
  "1mo": "1 month",
  "1y": "1 year",
  "3y": "3 years",
  "5y": "5 years",
};
const PREDEFINED_FILTERS = {
  premarket: [
    { label: "Avg Vol", summary: "Above 1M (30D)" },
    { label: "ATR", summary: "Above 0.5 (1 day, 14)" },
    { label: "PM Change", summary: "Above $1" },
    { label: "PM Volume", summary: "Above 50K" },
  ],
  intraday: [
    { label: "Avg Vol", summary: "Above 1M (30D)" },
    { label: "ATR", summary: "Above 0.5 (1 day, 14)" },
    { label: "Rel Vol", summary: "Above 1.5x (1 day)" },
    { label: "Change", summary: "Above $1" },
  ],
};

/** Formats large scanner values compactly for buttons and result cells. */
function formatCompact(value, mode) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const prefix = mode === "currency" ? "$" : "";
  if (absolute >= 1_000_000_000_000) {
    return `${sign}${prefix}${(absolute / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (absolute >= 1_000_000_000) {
    return `${sign}${prefix}${(absolute / 1_000_000_000).toFixed(2)}B`;
  }
  if (absolute >= 1_000_000) {
    return `${sign}${prefix}${(absolute / 1_000_000).toFixed(2)}M`;
  }
  if (absolute >= 1_000) {
    return `${sign}${prefix}${(absolute / 1_000).toFixed(1)}K`;
  }
  return `${sign}${prefix}${absolute.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Formats scanner prices without compact shorthand. */
function formatExactPrice(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Returns how many values the selected operator needs. */
function valueCountForOperator(operator) {
  return operator === "between" || operator === "outside" ? 2 : 1;
}

/** Returns the visual scanner filter category for a filter config. */
function filterCategory(config) {
  return FILTER_CATEGORY_BY_ID[config.id] || "market";
}

/** Sorts scanner filters by category, then by visible label. */
function sortFilterConfigs(configs) {
  return [...configs].sort((first, second) => {
    const firstCategory = filterCategory(first);
    const secondCategory = filterCategory(second);
    const categoryDifference = FILTER_CATEGORY_ORDER.indexOf(firstCategory) - FILTER_CATEGORY_ORDER.indexOf(secondCategory);
    if (categoryDifference !== 0) {
      return categoryDifference;
    }
    return first.label.localeCompare(second.label);
  });
}

/** Groups sorted scanner filters for visual category rendering. */
function groupedFilterConfigs(configs) {
  return sortFilterConfigs(configs).reduce((groups, config) => {
    const category = filterCategory(config);
    const currentGroup = groups.find((group) => group.category === category);
    if (currentGroup) {
      currentGroup.filters.push(config);
    } else {
      groups.push({ category, filters: [config] });
    }
    return groups;
  }, []);
}

/** Moves selected result columns to the end of the table order. */
function appendColumnsToEnd(columnOrder, columnKeys) {
  const appendedColumns = columnKeys.filter((key) => key !== "symbol");
  if (!appendedColumns.length) {
    return columnOrder;
  }

  const appendedSet = new Set(appendedColumns);
  return [...columnOrder.filter((key) => !appendedSet.has(key)), ...appendedColumns];
}

/** Moves newly calculated non-default result columns to the end of the table order. */
function appendCalculatedColumns(columnOrder, calculatedMetrics) {
  return appendColumnsToEnd(columnOrder, calculatedMetrics.filter((key) => HISTORICAL_COLUMN_KEYS.has(key)));
}

/** Returns a numeric value when an input string is valid. */
function parseFilterValue(value) {
  const normalized = String(value).trim().replaceAll(",", "").replace(/^\$/, "");
  if (normalized === "") {
    return null;
  }

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([kmbt])?$/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]) * (COMPACT_SUFFIXES[match[2]?.toLowerCase()] || 1);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns parsed filter values for the operator's active inputs. */
function parsedFilterValues(filter) {
  return filter.values.slice(0, valueCountForOperator(filter.operator)).map(parseFilterValue);
}

/** Checks whether a filter has valid values within configured limits. */
function isFilterValid(config, filter) {
  if (config.type === "category") {
    return (filter.selectedValues || []).length > 0;
  }

  const values = parsedFilterValues(filter);
  return values.every((value) => value !== null && value >= config.min && value <= config.max);
}

/** Returns whether the user has typed anything into the active filter fields. */
function hasFilterDraftValue(filter) {
  if (filter.selectedValues?.length) {
    return true;
  }
  return filter.values.slice(0, valueCountForOperator(filter.operator)).some((value) => String(value).trim() !== "");
}

/** Converts valid filter state to an API request payload item. */
function payloadFilter(config, filter) {
  if (config.type === "category") {
    return {
      field: config.id,
      operator: "above",
      selected_values: filter.selectedValues || [],
    };
  }

  const payload = {
    field: config.id,
    operator: filter.operator,
    values: parsedFilterValues(filter),
  };
  if (config.periods) {
    payload.period = filter.period || config.defaultPeriod;
  }
  if (config.timeframes) {
    payload.timeframe = filter.timeframe || config.defaultTimeframe;
    if (config.ranges) {
      payload.range = Number(filter.range || config.defaultRange);
    }
  }
  return payload;
}

/** Builds the compact selected filter button label. */
function filterSummary(config, filter) {
  if (!isFilterValid(config, filter)) {
    return "";
  }

  if (config.type === "category") {
    const selected = filter.selectedValues || [];
    if (selected.length <= 2) {
      return selected.join(", ");
    }
    return `${selected.slice(0, 2).join(", ")} +${selected.length - 2}`;
  }

  const values = payloadFilter(config, filter).values.map((value) => `${formatCompact(value, config.compact)}${config.suffix || ""}`);
  const operator = OPERATORS.find((item) => item.value === filter.operator)?.label || filter.operator;
  const selectedPeriod = filter.period || config.defaultPeriod;
  const period = config.periods ? ` (${PERIOD_LABELS[selectedPeriod] || `${selectedPeriod}D`})` : "";
  const taPeriod = config.timeframes
    ? ` (${PERIOD_LABELS[filter.timeframe || config.defaultTimeframe]}${config.ranges ? `, ${filter.range || config.defaultRange}` : ""})`
    : "";
  return `${operator} ${values.join(" and ")}${period}${taPeriod}`;
}

/** Returns a concise validation message for a filter draft. */
function filterValidationMessage(config, filter) {
  if (config.type === "category") {
    return "";
  }

  if (!hasFilterDraftValue(filter) || isFilterValid(config, filter)) {
    return "";
  }

  const limit = `${formatCompact(config.min, config.compact)} to ${formatCompact(config.max, config.compact)}${config.suffix || ""}`;
  return `Use values from ${limit}. Compact notation like 1M, 1B, or 1T is accepted.`;
}

/** Formats signed change values for the result table. */
function formatSigned(value, suffix = "", mode = "number") {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCompact(value, mode)}${suffix}`;
}

/** Returns a column label with period details when relevant. */
function columnLabel(column, metricPeriods) {
  const period = column.periodKey ? metricPeriods[column.periodKey] : null;
  if (period && typeof period === "object") {
    return `${column.label} ${PERIOD_LABELS[period.timeframe] || period.timeframe} ${period.range}`;
  }
  return period ? `${column.label} ${PERIOD_LABELS[period] || `${period}D`}` : column.label;
}

/** Returns the filter config matching a result column when one exists. */
function columnFilterConfig(columnKey, filterConfigs) {
  return filterConfigs.find((config) => config.id === columnKey);
}

/** Builds default column metric settings from the matching filter config. */
function defaultColumnMetricDraft(config, metricPeriods) {
  if (!config) {
    return {};
  }
  const current = metricPeriods[config.id];
  return {
    period: config.periods ? current || config.defaultPeriod : undefined,
    timeframe: config.timeframes ? current?.timeframe || current || config.defaultTimeframe : undefined,
    range: config.ranges ? current?.range || config.defaultRange : undefined,
  };
}

/** Returns whether adding a column requires period or timeframe choices. */
function isConfigurableColumn(config) {
  return Boolean(config?.periods || config?.timeframes || config?.ranges);
}

/** Returns the sort direction glyph for the active column. */
function sortArrow(column, sortConfig) {
  if (column.key !== sortConfig.key) {
    return "";
  }
  return sortConfig.direction === "asc" ? "↑" : "↓";
}

/** Returns compact fallback initials for a scanner logo. */
function logoFallback(symbol) {
  return String(symbol || "?").slice(0, 2).toUpperCase();
}

/** Renders one scanner symbol identity cell. */
function ScannerSymbolCell({ row }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [logoStyle, setLogoStyle] = useState({});
  const showLogo = row.logo_url && !logoFailed;

  return (
    <div className="scanner-symbol-cell">
      <div className="scanner-symbol-logo" aria-hidden="true" style={showLogo ? logoStyle : undefined}>
        {showLogo ? (
          <img
            src={row.logo_url}
            alt=""
            loading="lazy"
            onLoad={(event) => setLogoStyle(logoPresentationStyle(event.currentTarget))}
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span>{logoFallback(row.symbol)}</span>
        )}
      </div>
      <span className="scanner-symbol-pill">{row.symbol}</span>
      <span className="scanner-company-name" title={row.name || ""}>{row.name || ""}</span>
    </div>
  );
}

/** Renders one scanner table cell according to the column definition. */
function ScannerTableCell({ column, row, loading }) {
  if (loading && column.key !== "symbol") {
    return <span className="scanner-cell-loading" aria-hidden="true" />;
  }

  if (column.key === "symbol") {
    return <ScannerSymbolCell row={row} />;
  }
  if (column.key === "industry") {
    return row.industry || "--";
  }
  if (column.key === "price") {
    return formatExactPrice(row.price);
  }
  if (column.key === "vwap") {
    return formatExactPrice(row.vwap);
  }
  if (column.key === "market_cap") {
    return formatCompact(row.market_cap, "currency");
  }
  if (column.key === "change") {
    return formatSigned(row.change, "", "currency");
  }
  if (column.key === "change_pct") {
    return formatSigned(row.change_pct, "%");
  }
  if (column.key === "volume" || column.key === "avg_volume") {
    return formatCompact(row[column.key], "number");
  }
  if (column.key === "dollar_volume" || column.key === "avg_dollar_volume") {
    return formatCompact(row[column.key], "currency");
  }
  if (column.key === "relative_volume") {
    return Number.isFinite(row.relative_volume) ? `${row.relative_volume.toFixed(2)}x` : "--";
  }
  if (column.key === "beta") {
    return Number.isFinite(row.beta) ? row.beta.toFixed(2) : "--";
  }
  if (column.key === "rsi") {
    return Number.isFinite(row.rsi) ? row.rsi.toFixed(1) : "--";
  }
  if (column.key === "atr") {
    return formatCompact(row.atr, "number");
  }
  if (column.key === "atr_pct") {
    return Number.isFinite(row.atr_pct) ? `${row.atr_pct.toFixed(2)}%` : "--";
  }
  return row[column.key] ?? "--";
}

/** Returns the scanner table cell CSS class for value polarity. */
function scannerCellClass(column, row) {
  if (column.key === "change") {
    return row.change >= 0 ? "up" : "down";
  }
  if (column.key === "change_pct") {
    return row.change_pct >= 0 ? "up" : "down";
  }
  return "";
}

/** Renders the data-source information icon. */
function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v5" />
      <path d="M10 6.2h.01" />
    </svg>
  );
}

/** Renders a small trash icon for column menus. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 8v7" />
      <path d="M10 8v7" />
      <path d="M13 8v7" />
      <path d="M4 5h12" />
      <path d="M8 5V3h4v2" />
      <path d="M5 5l1 13h8l1-13" />
    </svg>
  );
}

/** Renders a refresh icon for rerunning scanner requests. */
function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16 7a6 6 0 0 0-10.2-2.8L4 6" />
      <path d="M4 3v3h3" />
      <path d="M4 13a6 6 0 0 0 10.2 2.8L16 14" />
      <path d="M16 17v-3h-3" />
    </svg>
  );
}

/** Renders one custom filter configuration popover. */
function FilterPopover({ config, filter, onChange, onApply, offset }) {
  const valueCount = valueCountForOperator(filter.operator);
  const validationMessage = filterValidationMessage(config, filter);
  const inputRefs = useRef([]);

  /** Toggles one categorical option in the filter draft. */
  const toggleSelectedValue = (value) => {
    const selected = new Set(filter.selectedValues || []);
    if (selected.has(value)) {
      selected.delete(value);
    } else {
      selected.add(value);
    }
    onChange({ ...filter, selectedValues: [...selected].sort() });
  };

  /** Updates the operator and clears values that are no longer used. */
  const updateOperator = (operator) => {
    const values = operator === filter.operator ? filter.values : ["", ""];
    onChange({ ...filter, operator, values });
  };

  /** Updates one numeric value in the filter draft. */
  const updateValue = (index, value) => {
    const values = [...filter.values];
    values[index] = value;
    onChange({ ...filter, values });
  };

  /** Moves Enter to the next required value or applies a valid filter draft. */
  const handleValueKeyDown = (event, index) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const nextIndex = index + 1;
    if (nextIndex < valueCount && !String(filter.values[nextIndex] || "").trim()) {
      inputRefs.current[nextIndex]?.focus();
      return;
    }
    if (isFilterValid(config, filter)) {
      onApply();
    }
  };

  /** Updates the period for period-aware filters. */
  const updatePeriod = (period) => {
    onChange({ ...filter, period: typeof config.defaultPeriod === "number" ? Number(period) : period });
  };

  /** Updates the timeframe for timeframe-aware TA filters. */
  const updateTimeframe = (timeframe) => {
    onChange({ ...filter, timeframe });
  };

  /** Updates the range for timeframe-aware TA filters. */
  const updateRange = (range) => {
    onChange({ ...filter, range: Number(range) });
  };

  return (
    <div className="scanner-filter-popover" style={{ transform: `translateX(${offset}px)` }}>
      {config.type === "category" && (
        <>
          <div className="scanner-checkbox-list">
            {config.options.map((option) => (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={(filter.selectedValues || []).includes(option)}
                  onChange={() => toggleSelectedValue(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
          <small>{config.detail}</small>
        </>
      )}
      {config.type !== "category" && (
        <>
      {config.periods && (
        <label className="scanner-period-field">
          <span>Period</span>
          <select value={filter.period || config.defaultPeriod} onChange={(event) => updatePeriod(event.target.value)}>
            {config.periods.map((period) => (
              <option value={period} key={period}>{PERIOD_LABELS[period] || `${period} trading days`}</option>
            ))}
          </select>
        </label>
      )}
      {config.timeframes && (
        <>
          <label className="scanner-period-field">
            <span>Timeframe</span>
            <select value={filter.timeframe || config.defaultTimeframe} onChange={(event) => updateTimeframe(event.target.value)}>
              {config.timeframes.map((timeframe) => (
                <option value={timeframe} key={timeframe}>{PERIOD_LABELS[timeframe] || timeframe}</option>
              ))}
            </select>
          </label>
          {config.ranges && (
            <label className="scanner-period-field">
              <span>Range</span>
              <select value={filter.range || config.defaultRange} onChange={(event) => updateRange(event.target.value)}>
                {config.ranges.map((range) => (
                  <option value={range} key={range}>{range}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <select value={filter.operator} onChange={(event) => updateOperator(event.target.value)}>
        {OPERATORS.map((operator) => (
          <option value={operator.value} key={operator.value}>{operator.label}</option>
        ))}
      </select>
      <div className="scanner-value-grid">
        {Array.from({ length: valueCount }).map((_, index) => (
          <input
            key={index}
            ref={(node) => {
              inputRefs.current[index] = node;
            }}
            className={validationMessage ? "invalid" : ""}
            type="text"
            inputMode="decimal"
            value={filter.values[index]}
            placeholder={index === 0 ? "Value" : "Second value"}
            onChange={(event) => updateValue(index, event.target.value)}
            onKeyDown={(event) => handleValueKeyDown(event, index)}
          />
        ))}
      </div>
      <small className={validationMessage ? "invalid" : ""}>
        {validationMessage || `${formatCompact(config.min, config.compact)} to ${formatCompact(config.max, config.compact)}${config.suffix || ""}`}
      </small>
      <small>{config.detail}</small>
        </>
      )}
    </div>
  );
}

/** Renders scanner controls, custom filters, and result rows. */
export default function ScannerPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("");
  const [filters, setFilters] = useState({});
  const [draftFilters, setDraftFilters] = useState({});
  const [industryOptions, setIndustryOptions] = useState([]);
  const [openFilter, setOpenFilter] = useState("");
  const [results, setResults] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [metricPeriods, setMetricPeriods] = useState(DEFAULT_METRIC_PERIODS);
  const [calculatedMetrics, setCalculatedMetrics] = useState([]);
  const [scannerName, setScannerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [asOf, setAsOf] = useState("");
  const [popoverOffset, setPopoverOffset] = useState(0);
  const [sourceInfoOpen, setSourceInfoOpen] = useState(false);
  const [columnAddOpen, setColumnAddOpen] = useState(false);
  const [columnAddOffset, setColumnAddOffset] = useState(0);
  const [selectedAddColumn, setSelectedAddColumn] = useState("");
  const [columnAddDrafts, setColumnAddDrafts] = useState({});
  const [columnContextMenu, setColumnContextMenu] = useState(null);
  const [columnDropTarget, setColumnDropTarget] = useState(null);
  const [columnOrder, setColumnOrder] = useState(DEFAULT_COLUMN_ORDER);
  const [hiddenColumns, setHiddenColumns] = useState(new Set());
  const [forcedColumns, setForcedColumns] = useState(new Set());
  const [enrichingColumns, setEnrichingColumns] = useState(new Set());
  const [sortConfig, setSortConfig] = useState({ key: "symbol", direction: "asc" });
  const [scanVersion, setScanVersion] = useState(0);
  const [renderedRowCount, setRenderedRowCount] = useState(INITIAL_RENDERED_ROWS);
  const draggedColumnRef = useRef("");
  const filterPanelRef = useRef(null);
  const resultsRef = useRef(null);
  const addColumnTriggerRef = useRef(null);
  const requestRef = useRef(null);
  const requestSeqRef = useRef(0);

  const filterConfigs = useMemo(() => (
    sortFilterConfigs(BASE_FILTERS.map((config) => (config.id === "industry" ? { ...config, options: industryOptions } : config)))
  ), [industryOptions]);

  const filterGroups = useMemo(() => groupedFilterConfigs(filterConfigs), [filterConfigs]);

  const activeFilters = useMemo(() => (
    filterConfigs
      .map((config) => ({ config, filter: filters[config.id] || EMPTY_FILTER }))
      .filter(({ config, filter }) => isFilterValid(config, filter))
      .map(({ config, filter }) => payloadFilter(config, filter))
  ), [filterConfigs, filters]);

  const columnByKey = useMemo(() => new Map(SCANNER_COLUMNS.map((column) => [column.key, column])), []);

  const orderedColumns = useMemo(() => (
    columnOrder.map((key) => columnByKey.get(key)).filter(Boolean)
  ), [columnByKey, columnOrder]);

  const visibleColumns = useMemo(() => (
    orderedColumns.filter((column) => (
      !hiddenColumns.has(column.key)
      && (!HISTORICAL_COLUMN_KEYS.has(column.key) || calculatedMetrics.includes(column.key) || forcedColumns.has(column.key))
    ))
  ), [calculatedMetrics, forcedColumns, hiddenColumns, orderedColumns]);

  const sortedResults = useMemo(() => {
    const column = visibleColumns.find((item) => item.key === sortConfig.key) || visibleColumns[0];
    const direction = sortConfig.direction === "asc" ? 1 : -1;
    return [...results].sort((first, second) => {
      if (column.type === "text") {
        return String(first[column.key] || "").localeCompare(String(second[column.key] || "")) * direction;
      }

      const firstValue = Number(first[column.key]);
      const secondValue = Number(second[column.key]);
      const firstValid = Number.isFinite(firstValue);
      const secondValid = Number.isFinite(secondValue);
      if (!firstValid && !secondValid) {
        return first.symbol.localeCompare(second.symbol);
      }
      if (!firstValid) {
        return 1;
      }
      if (!secondValid) {
        return -1;
      }
      if (firstValue === secondValue) {
        return first.symbol.localeCompare(second.symbol);
      }
      return (firstValue - secondValue) * direction;
    });
  }, [results, sortConfig, visibleColumns]);

  const renderedResults = useMemo(() => (
    sortedResults.slice(0, renderedRowCount)
  ), [renderedRowCount, sortedResults]);

  /** Returns whether the current scanner mode has enough input to run. */
  const canRunScanner = mode === "predefined" || (mode === "custom" && activeFilters.length > 0);

  /** Reruns the scanner with the currently applied filter set. */
  const rerunScanner = () => {
    if (!canRunScanner) {
      return;
    }
    setScanVersion((current) => current + 1);
  };

  /** Toggles result table sorting for one column. */
  const sortByColumn = (key) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  /** Returns whether a table column is currently visible. */
  const isColumnVisible = (key) => (
    !hiddenColumns.has(key)
    && (!HISTORICAL_COLUMN_KEYS.has(key) || calculatedMetrics.includes(key) || forcedColumns.has(key))
  );

  const hiddenOrUnavailableColumns = useMemo(() => (
    orderedColumns.filter((column) => column.key !== "symbol" && !isColumnVisible(column.key))
  ), [calculatedMetrics, forcedColumns, hiddenColumns, orderedColumns]);

  /** Moves one scanner result column in the user-selected order. */
  const moveColumn = (key, direction) => {
    setColumnOrder((current) => {
      const index = current.indexOf(key);
      const nextIndex = index + direction;
      if (key === "symbol" || index < 0 || nextIndex < 1 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  /** Moves one scanner result column to an absolute position. */
  const moveColumnToIndex = (key, targetIndex) => {
    setColumnOrder((current) => {
      const index = current.indexOf(key);
      const boundedTarget = Math.max(1, Math.min(targetIndex, current.length - 1));
      if (key === "symbol" || index < 0 || index === boundedTarget) {
        return current;
      }

      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(boundedTarget, 0, item);
      return next;
    });
  };

  /** Stores the active drag insertion target for a column header. */
  const updateColumnDropTarget = (event, targetKey) => {
    if (!draggedColumnRef.current || draggedColumnRef.current === targetKey) {
      setColumnDropTarget(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const side = targetKey === "symbol" || event.clientX >= rect.left + rect.width / 2 ? "right" : "left";
    setColumnDropTarget({ key: targetKey, side });
  };

  /** Moves one scanner result column to the active drag insertion target. */
  const dropColumnOn = () => {
    const draggedKey = draggedColumnRef.current;
    const target = columnDropTarget;
    draggedColumnRef.current = "";
    setColumnDropTarget(null);
    if (!draggedKey || !target || draggedKey === target.key || draggedKey === "symbol") {
      return;
    }
    const targetIndex = columnOrder.indexOf(target.key);
    const insertIndex = target.side === "right" ? targetIndex + 1 : targetIndex;
    moveColumnToIndex(draggedKey, insertIndex);
  };

  /** Shows or hides a scanner result column. */
  const toggleColumn = (key) => {
    if (key === "symbol") {
      return;
    }

    if (isColumnVisible(key)) {
      setHiddenColumns((current) => new Set([...current, key]));
      setForcedColumns((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }

    showColumn(key);
  };

  /** Shows a scanner column and calculates missing values when needed. */
  const showColumn = (key, metricDraft = {}) => {
    const nextMetricPeriods = metricPeriodsFromDraft(key, metricDraft);

    setHiddenColumns((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setMetricPeriods(nextMetricPeriods);
    setColumnOrder((current) => appendColumnsToEnd(current, [key]));
    if (HISTORICAL_COLUMN_KEYS.has(key) && !calculatedMetrics.includes(key)) {
      setForcedColumns((current) => new Set([...current, key]));
      enrichColumn(key, nextMetricPeriods);
    }
    setSelectedAddColumn("");
    setColumnAddOpen(false);
  };

  /** Builds the next metric-period map from one configurable column draft. */
  const metricPeriodsFromDraft = (key, metricDraft = {}) => {
    const nextMetricPeriods = { ...metricPeriods };
    if (metricDraft.period !== undefined) {
      nextMetricPeriods[key] = Number.isFinite(Number(metricDraft.period)) ? Number(metricDraft.period) : metricDraft.period;
    }
    if (metricDraft.timeframe) {
      nextMetricPeriods[key] = metricDraft.range ? { timeframe: metricDraft.timeframe, range: Number(metricDraft.range) } : metricDraft.timeframe;
    }
    return nextMetricPeriods;
  };

  /** Reconfigures a visible calculated column without rerunning the scanner. */
  const reconfigureColumn = (key, metricDraft = {}) => {
    const nextMetricPeriods = metricPeriodsFromDraft(key, metricDraft);
    setMetricPeriods(nextMetricPeriods);
    setForcedColumns((current) => new Set([...current, key]));
    enrichColumn(key, nextMetricPeriods, true);
  };

  /** Requests one missing historical column for current result symbols only. */
  const enrichColumn = async (key, periods = metricPeriods, force = false) => {
    const symbols = results.map((row) => row.symbol).filter(Boolean);
    if (!symbols.length || (enrichingColumns.has(key) && !force)) {
      return;
    }

    setEnrichingColumns((current) => new Set([...current, key]));
    try {
      const response = await fetch("/api/scanner/columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols, metrics: [key], metric_periods: periods }),
      });
      if (!response.ok) {
        throw new Error(`Column request failed with status ${response.status}`);
      }
      const payload = await response.json();
      const rowsBySymbol = new Map((payload.results || []).map((row) => [row.symbol, row]));
      setResults((current) => current.map((row) => ({ ...row, ...(rowsBySymbol.get(row.symbol) || {}) })));
      setMetricPeriods((current) => ({ ...current, ...(payload.metric_periods || {}) }));
      setCalculatedMetrics((current) => [...new Set([...current, ...(payload.calculated_metrics || [key])])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Column unavailable");
      setForcedColumns((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    } finally {
      setEnrichingColumns((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  /** Updates one pending add-column metric setting. */
  const updateColumnAddDraft = (key, updates) => {
    setColumnAddDrafts((current) => ({ ...current, [key]: { ...(current[key] || {}), ...updates } }));
  };

  /** Opens the column header menu at the pointer position. */
  const openColumnContextMenu = (event, column) => {
    event.preventDefault();
    setColumnAddOpen(false);
    setSelectedAddColumn("");
    const config = columnFilterConfig(column.key, filterConfigs);
    const estimatedHeight = isConfigurableColumn(config) ? COLUMN_CONTEXT_MENU_MAX_HEIGHT : 275;
    const x = Math.min(
      event.clientX,
      window.innerWidth - COLUMN_CONTEXT_MENU_WIDTH - POPOVER_VIEWPORT_PADDING,
    );
    const y = Math.min(
      event.clientY,
      window.innerHeight - estimatedHeight - POPOVER_VIEWPORT_PADDING,
    );
    setColumnContextMenu({
      column,
      x: Math.max(POPOVER_VIEWPORT_PADDING, x),
      y: Math.max(POPOVER_VIEWPORT_PADDING, y),
    });
  };

  /** Runs a column menu command and closes the menu. */
  const runColumnCommand = (command) => {
    if (!columnContextMenu) {
      return;
    }
    const key = columnContextMenu.column.key;
    if (command === "sort-asc") {
      setSortConfig({ key, direction: "asc" });
    } else if (command === "sort-desc") {
      setSortConfig({ key, direction: "desc" });
    } else if (command === "left") {
      moveColumn(key, -1);
    } else if (command === "right") {
      moveColumn(key, 1);
    } else if (command === "start") {
      moveColumnToIndex(key, 1);
    } else if (command === "end") {
      moveColumnToIndex(key, columnOrder.length - 1);
    } else if (command === "hide" && key !== "symbol") {
      toggleColumn(key);
    }
    setColumnContextMenu(null);
  };

  /** Opens a stock chart for a scanner row. */
  const openTicker = (ticker) => {
    const normalized = normalizeTicker(ticker);
    if (normalized) {
      navigate(`/stock/${encodeURIComponent(normalized)}`);
    }
  };

  /** Stores local edits for the currently open filter without running the scanner. */
  const updateDraftFilter = (id, nextFilter) => {
    setDraftFilters((current) => ({ ...current, [id]: nextFilter }));
  };

  /** Removes an applied filter and any draft value for it. */
  const clearFilter = (id) => {
    setFilters((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDraftFilters((current) => ({ ...current, [id]: EMPTY_FILTER }));
    if (openFilter === id) {
      setOpenFilter("");
    }
  };

  /** Applies an open filter draft when it is valid, then closes the popover. */
  const applyDraftFilter = (id) => {
    if (!id) {
      return;
    }

    const config = filterConfigs.find((item) => item.id === id);
    if (!config) {
      return;
    }

    const draft = draftFilters[id] || filters[id] || EMPTY_FILTER;
    if (!hasFilterDraftValue(draft)) {
      clearFilter(id);
      setOpenFilter("");
      return;
    }

    if (!isFilterValid(config, draft)) {
      setOpenFilter("");
      return;
    }

    setFilters((current) => ({ ...current, [id]: draft }));
    setOpenFilter("");
  };

  /** Opens a filter popover, applying any previous draft first. */
  const toggleFilter = (id) => {
    if (openFilter === id) {
      applyDraftFilter(id);
      return;
    }

    if (openFilter) {
      applyDraftFilter(openFilter);
    }

    setDraftFilters((current) => ({ ...current, [id]: current[id] || filters[id] || EMPTY_FILTER }));
    setOpenFilter(id);
  };

  /** Expands rendered scanner rows as the user scrolls near the table bottom. */
  const handleTableScroll = (event) => {
    const target = event.currentTarget;
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remaining < 360) {
      setRenderedRowCount((current) => Math.min(current + RENDERED_ROWS_INCREMENT, sortedResults.length));
    }
  };

  useEffect(() => {
    if (!openFilter) {
      setPopoverOffset(0);
      return undefined;
    }

    /** Keeps the open filter menu inside the viewport. */
    const updatePopoverOffset = () => {
      const trigger = document.querySelector(`[data-filter-id="${openFilter}"]`);
      if (!trigger) {
        setPopoverOffset(0);
        return;
      }

      const rect = trigger.getBoundingClientRect();
      const overflow = rect.left + POPOVER_WIDTH - window.innerWidth + POPOVER_VIEWPORT_PADDING;
      setPopoverOffset(overflow > 0 ? -overflow : 0);
    };

    updatePopoverOffset();
    window.addEventListener("resize", updatePopoverOffset);
    return () => window.removeEventListener("resize", updatePopoverOffset);
  }, [openFilter]);

  useEffect(() => {
    if (!openFilter) {
      return undefined;
    }

    /** Applies the current filter when focus moves outside the scanner filter panel. */
    const closeOnOutsideClick = (event) => {
      if (filterPanelRef.current?.contains(event.target)) {
        return;
      }
      applyDraftFilter(openFilter);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [openFilter, draftFilters, filters, filterConfigs]);

  useEffect(() => {
    /** Closes open scanner column menus on outside pointer actions. */
    const closeColumnMenus = () => {
      setColumnContextMenu(null);
      setColumnAddOpen(false);
      setColumnAddOffset(0);
      setSelectedAddColumn("");
    };

    document.addEventListener("mousedown", closeColumnMenus);
    return () => document.removeEventListener("mousedown", closeColumnMenus);
  }, []);

  useEffect(() => {
    if (!columnAddOpen) {
      setColumnAddOffset(0);
      return undefined;
    }

    /** Keeps the add-column menu inside the scanner results panel. */
    const updateColumnAddOffset = () => {
      const trigger = addColumnTriggerRef.current;
      const resultsPanel = resultsRef.current;
      if (!trigger || !resultsPanel) {
        setColumnAddOffset(0);
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const resultsRect = resultsPanel.getBoundingClientRect();
      const overflow = triggerRect.left + ADD_COLUMN_POPOVER_WIDTH - resultsRect.right + POPOVER_VIEWPORT_PADDING;
      setColumnAddOffset(overflow > 0 ? -overflow : 0);
    };

    updateColumnAddOffset();
    window.addEventListener("resize", updateColumnAddOffset);
    return () => window.removeEventListener("resize", updateColumnAddOffset);
  }, [columnAddOpen, selectedAddColumn]);

  useEffect(() => {
    setRenderedRowCount(INITIAL_RENDERED_ROWS);
  }, [results, sortConfig, visibleColumns.length]);

  useEffect(() => {
    /** Loads scanner option metadata for categorical filters. */
    async function loadScannerMetadata() {
      try {
        const response = await fetch("/api/scanner/metadata");
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        setIndustryOptions(payload.industries || []);
      } catch {
        setIndustryOptions([]);
      }
    }

    loadScannerMetadata();
  }, []);

  useEffect(() => {
    if (!mode) {
      return undefined;
    }
    if (mode === "custom" && activeFilters.length === 0) {
      requestSeqRef.current += 1;
      requestRef.current?.abort();
      setResults([]);
      setTotalCount(0);
      setCalculatedMetrics([]);
      setForcedColumns(new Set());
      setScannerName("");
      setLoading(false);
      setError("");
      setAsOf("");
      return undefined;
    }

    const controller = new AbortController();
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    /** Runs the scanner for the currently applied filter set. */
    async function loadScanner() {
      requestRef.current?.abort();
      requestRef.current = controller;
      setLoading(true);
      setError("");

      try {
        const response = await fetch("/api/scanner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, filters: mode === "custom" ? activeFilters : [] }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Scanner request failed with status ${response.status}`);
        }

        const payload = await response.json();
        if (controller.signal.aborted || requestSeqRef.current !== requestSeq) {
          return;
        }
        setResults(payload.results || []);
        setTotalCount(payload.total_count ?? payload.results?.length ?? 0);
        setCalculatedMetrics(payload.calculated_metrics || []);
        setColumnOrder((current) => appendCalculatedColumns(current, payload.calculated_metrics || []));
        setForcedColumns(new Set());
        setScannerName(payload.scanner_name || "");
        setMetricPeriods({ ...DEFAULT_METRIC_PERIODS, ...(payload.metric_periods || {}) });
        setAsOf(payload.as_of || "");
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError") && requestSeqRef.current === requestSeq) {
          setError(err instanceof Error ? err.message : "Scanner unavailable");
        }
      } finally {
        if (requestRef.current === controller && requestSeqRef.current === requestSeq) {
          requestRef.current = null;
          setLoading(false);
        }
      }
    }

    loadScanner();

    return () => {
      controller.abort();
    };
  }, [mode, activeFilters, scanVersion]);

  const asOfLabel = asOf ? new Date(asOf).toLocaleString() : "";

  return (
    <main className="tv-page scanner-page">
      <HeaderBar onSearch={openTicker} />

      <section className="scanner-toolbar">
        <button className={`scanner-mode-button ${mode === "predefined" ? "active" : ""}`} type="button" onClick={() => setMode("predefined")}>
          Pre-defined Scanner
        </button>
        <button className={`scanner-mode-button ${mode === "custom" ? "active" : ""}`} type="button" onClick={() => setMode("custom")}>
          Custom Scanner
        </button>
        <div className="menu-popover scanner-source-popover-wrap">
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
              <strong>Scanner data</strong>
              <span>Market data: Massive/Polygon.io</span>
            </div>
          )}
        </div>
      </section>

      {mode === "custom" && (
        <section className="scanner-filter-panel" ref={filterPanelRef}>
          {filterGroups.map((group) => (
            <div className="scanner-filter-group" key={group.category}>
              <span className="scanner-filter-category-label">{FILTER_CATEGORY_LABELS[group.category]}</span>
              {group.filters.map((config) => {
                const filter = filters[config.id] || EMPTY_FILTER;
                const draftFilter = draftFilters[config.id] || filter;
                const selected = isFilterValid(config, filter);
                const draftSummary = filterSummary(config, draftFilter);
                const summary = openFilter === config.id && draftSummary ? draftSummary : filterSummary(config, filter);
                const invalidDraft = openFilter === config.id && hasFilterDraftValue(draftFilter) && !isFilterValid(config, draftFilter);
                const showClear = selected || hasFilterDraftValue(draftFilter);
                return (
                  <div className="scanner-filter-wrap" key={config.id}>
                    <div className={`scanner-filter-control ${selected || draftSummary ? "selected" : ""} ${invalidDraft ? "invalid" : ""} ${showClear ? "has-clear" : ""}`}>
                      <button
                        className="scanner-filter-button"
                        type="button"
                        onClick={() => toggleFilter(config.id)}
                        aria-expanded={openFilter === config.id}
                        data-filter-id={config.id}
                      >
                        <span>{config.label}</span>
                        {summary && <small>{summary}</small>}
                      </button>
                      {showClear && (
                        <button
                          className="scanner-filter-clear"
                          type="button"
                          aria-label={`Clear ${config.label}`}
                          title={`Clear ${config.label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            clearFilter(config.id);
                          }}
                        >
                          x
                        </button>
                      )}
                    </div>
                    {openFilter === config.id && (
                      <FilterPopover
                        config={config}
                        filter={draftFilter}
                        offset={popoverOffset}
                        onChange={(nextFilter) => updateDraftFilter(config.id, nextFilter)}
                        onApply={() => applyDraftFilter(config.id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <button className="scanner-rerun-button" type="button" disabled={!canRunScanner || loading} onClick={rerunScanner} aria-label="Rerun scanner" title="Rerun scanner">
            <RefreshIcon />
          </button>
        </section>
      )}

      {mode === "predefined" && scannerName && (
        <section className="scanner-filter-panel predefined-scanner-panel">
          <div className="scanner-session-label">{scannerName === "premarket" ? "Pre-market scanner" : "Intraday scanner"}</div>
          {(PREDEFINED_FILTERS[scannerName] || []).map((item) => (
            <div className="scanner-filter-wrap" key={item.label}>
              <div className="scanner-filter-control selected immutable">
                <button className="scanner-filter-button" type="button" disabled>
                  <span>{item.label}</span>
                  <small>{item.summary}</small>
                </button>
              </div>
            </div>
          ))}
          <button className="scanner-rerun-button" type="button" disabled={!canRunScanner || loading} onClick={rerunScanner} aria-label="Rerun scanner" title="Rerun scanner">
            <RefreshIcon />
          </button>
        </section>
      )}

      <section className="scanner-results" ref={resultsRef}>
        <div className="scanner-results-header">
          <div className="scanner-results-title">
            <h2>Results</h2>
            <span>{totalCount.toLocaleString()} found</span>
          </div>
          <span>{loading ? "Scanning..." : asOfLabel ? `As of ${asOfLabel}` : "No scan running"}</span>
        </div>
        {error && <p className="scanner-error">{error}</p>}
        {!error && mode === "custom" && activeFilters.length === 0 && <p className="scanner-empty">Select at least one filter.</p>}
        {!error && mode && activeFilters.length > 0 && !loading && results.length === 0 && <p className="scanner-empty">No matches.</p>}
        {!error && mode === "predefined" && !loading && results.length === 0 && asOf && <p className="scanner-empty">No matches.</p>}
        {results.length > 0 && (
          <div className="scanner-table-wrap" onScroll={handleTableScroll}>
            <table className="scanner-table">
              <thead>
                <tr>
                  {visibleColumns.map((column) => (
                    <th
                      key={column.key}
                      className={[
                        columnDropTarget?.key === column.key && columnDropTarget.side === "left" ? "drop-left" : "",
                        columnDropTarget?.key === column.key && columnDropTarget.side === "right" ? "drop-right" : "",
                        enrichingColumns.has(column.key) ? "loading-column" : "",
                      ].filter(Boolean).join(" ")}
                      draggable={column.key !== "symbol"}
                      onDragStart={() => {
                        draggedColumnRef.current = column.key;
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        updateColumnDropTarget(event, column.key);
                      }}
                      onDragLeave={() => setColumnDropTarget(null)}
                      onDrop={dropColumnOn}
                      onContextMenu={(event) => openColumnContextMenu(event, column)}
                      aria-sort={sortConfig.key === column.key ? (sortConfig.direction === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <button type="button" onClick={() => sortByColumn(column.key)}>
                        <span>{columnLabel(column, metricPeriods)}</span>
                        <small>{sortArrow(column, sortConfig)}</small>
                      </button>
                    </th>
                  ))}
                  <th className="scanner-add-column-header">
                    <div className="menu-popover">
                      <button
                        ref={addColumnTriggerRef}
                        className="scanner-add-column-button"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setColumnContextMenu(null);
                          setSelectedAddColumn("");
                          setColumnAddOffset(0);
                          setColumnAddOpen((open) => !open);
                        }}
                        aria-expanded={columnAddOpen}
                      >
                        +
                      </button>
                      {columnAddOpen && (
                        <div
                          className="tv-dropdown scanner-add-column-popover"
                          style={{ transform: `translateX(${columnAddOffset}px)` }}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          {!selectedAddColumn && (
                            <div className="scanner-add-column-list">
                              {hiddenOrUnavailableColumns.length === 0 && <small>No hidden columns.</small>}
                              {hiddenOrUnavailableColumns.map((column) => {
                                const config = columnFilterConfig(column.key, filterConfigs);
                                return (
                                  <button
                                    type="button"
                                    key={column.key}
                                    onClick={() => {
                                      if (isConfigurableColumn(config)) {
                                        setSelectedAddColumn(column.key);
                                      } else {
                                        showColumn(column.key);
                                      }
                                    }}
                                  >
                                    {column.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {selectedAddColumn && (() => {
                            const column = columnByKey.get(selectedAddColumn);
                            const config = columnFilterConfig(selectedAddColumn, filterConfigs);
                            const draft = columnAddDrafts[selectedAddColumn] || defaultColumnMetricDraft(config, metricPeriods);
                            return (
                              <div className="scanner-add-column-config">
                                <button className="scanner-add-column-back" type="button" onClick={() => setSelectedAddColumn("")}>
                                  <span>&lt;</span>
                                  <strong>{column?.label}</strong>
                                </button>
                                <div className="scanner-add-column-fields">
                                  {config?.periods && (
                                    <label className="scanner-period-field">
                                      <span>Period</span>
                                      <select value={draft.period} onChange={(event) => updateColumnAddDraft(selectedAddColumn, { period: event.target.value })}>
                                        {config.periods.map((period) => (
                                          <option value={period} key={period}>{PERIOD_LABELS[period] || `${period} trading days`}</option>
                                        ))}
                                      </select>
                                    </label>
                                  )}
                                  {config?.timeframes && (
                                    <label className="scanner-period-field">
                                      <span>Timeframe</span>
                                      <select value={draft.timeframe} onChange={(event) => updateColumnAddDraft(selectedAddColumn, { timeframe: event.target.value })}>
                                        {config.timeframes.map((timeframe) => (
                                          <option value={timeframe} key={timeframe}>{PERIOD_LABELS[timeframe] || timeframe}</option>
                                        ))}
                                      </select>
                                    </label>
                                  )}
                                  {config?.ranges && (
                                    <label className="scanner-period-field">
                                      <span>Range</span>
                                      <select value={draft.range} onChange={(event) => updateColumnAddDraft(selectedAddColumn, { range: Number(event.target.value) })}>
                                        {config.ranges.map((range) => (
                                          <option value={range} key={range}>{range}</option>
                                        ))}
                                      </select>
                                    </label>
                                  )}
                                </div>
                                <div className="scanner-add-column-actions">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setColumnAddOpen(false);
                                      setColumnAddOffset(0);
                                      setSelectedAddColumn("");
                                    }}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    className="accept"
                                    type="button"
                                    disabled={enrichingColumns.has(selectedAddColumn)}
                                    onClick={() => showColumn(selectedAddColumn, draft)}
                                  >
                                    Add column
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {renderedResults.map((row) => (
                  <tr key={row.symbol} onClick={() => openTicker(row.symbol)}>
                    {visibleColumns.map((column) => (
                      <td
                        key={column.key}
                        className={[
                          scannerCellClass(column, row),
                          enrichingColumns.has(column.key) ? "loading-column" : "",
                        ].filter(Boolean).join(" ")}
                      >
                        <ScannerTableCell column={column} row={row} loading={enrichingColumns.has(column.key)} />
                      </td>
                    ))}
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {columnContextMenu && (
        <div
          className="scanner-column-context-menu"
          style={{ left: columnContextMenu.x, top: columnContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="scanner-column-context-title">
            <strong>{columnLabel(columnContextMenu.column, metricPeriods)}</strong>
            <span>?</span>
            {columnContextMenu.column.key !== "symbol" && (
              <button type="button" aria-label="Hide column" onClick={() => runColumnCommand("hide")}><TrashIcon /></button>
            )}
          </div>
          {(() => {
            const key = columnContextMenu.column.key;
            const config = columnFilterConfig(key, filterConfigs);
            const draft = defaultColumnMetricDraft(config, metricPeriods);
            if (!isConfigurableColumn(config)) {
              return null;
            }
            return (
              <div className="scanner-column-context-config">
                {config.periods && (
                  <label>
                    <span>Period</span>
                    <select
                      value={draft.period}
                      disabled={enrichingColumns.has(key)}
                      onChange={(event) => reconfigureColumn(key, { ...draft, period: event.target.value })}
                    >
                      {config.periods.map((period) => (
                        <option value={period} key={period}>{PERIOD_LABELS[period] || `${period} trading days`}</option>
                      ))}
                    </select>
                  </label>
                )}
                {config.timeframes && (
                  <label>
                    <span>Timeframe</span>
                    <select
                      value={draft.timeframe}
                      disabled={enrichingColumns.has(key)}
                      onChange={(event) => reconfigureColumn(key, { ...draft, timeframe: event.target.value })}
                    >
                      {config.timeframes.map((timeframe) => (
                        <option value={timeframe} key={timeframe}>{PERIOD_LABELS[timeframe] || timeframe}</option>
                      ))}
                    </select>
                  </label>
                )}
                {config.ranges && (
                  <label>
                    <span>Range</span>
                    <select
                      value={draft.range}
                      disabled={enrichingColumns.has(key)}
                      onChange={(event) => reconfigureColumn(key, { ...draft, range: Number(event.target.value) })}
                    >
                      {config.ranges.map((range) => (
                        <option value={range} key={range}>{range}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            );
          })()}
          <button type="button" onClick={() => runColumnCommand("sort-asc")}>↑≡ Sort ascending</button>
          <button type="button" className="active" onClick={() => runColumnCommand("sort-desc")}>↓≡ Sort descending</button>
          {columnContextMenu.column.key !== "symbol" && (
            <>
              <button type="button" onClick={() => runColumnCommand("left")}>← Move left</button>
              <button type="button" onClick={() => runColumnCommand("right")}>→ Move right</button>
              <button type="button" onClick={() => runColumnCommand("start")}>|← Move to the start</button>
              <button type="button" onClick={() => runColumnCommand("end")}>→| Move to the end</button>
            </>
          )}
        </div>
      )}
    </main>
  );
}
