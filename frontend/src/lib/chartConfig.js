export const TIMEFRAME_OPTIONS = [
	{ label: "1 second", shortLabel: "1s", value: "1s", group: "Seconds", requiresApi: true },
	{ label: "5 seconds", shortLabel: "5s", value: "5s", group: "Seconds", requiresApi: true },
	{ label: "10 seconds", shortLabel: "10s", value: "10s", group: "Seconds", requiresApi: true },
	{ label: "15 seconds", shortLabel: "15s", value: "15s", group: "Seconds", requiresApi: true },
	{ label: "30 seconds", shortLabel: "30s", value: "30s", group: "Seconds", requiresApi: true },
	{ label: "45 seconds", shortLabel: "45s", value: "45s", group: "Seconds", requiresApi: true },
	{ label: "1 minute", shortLabel: "1m", value: "1m", group: "Minutes", requiresApi: true },
	{ label: "2 minutes", shortLabel: "2m", value: "2m", group: "Minutes", requiresApi: true },
	{ label: "3 minutes", shortLabel: "3m", value: "3m", group: "Minutes", requiresApi: true },
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

export const INDICATOR_TYPES = [
	{ type: "VOLUME", name: "Volume", description: "Volume histogram overlaid on the price chart." },
	{ type: "SMA", name: "Simple Moving Average", description: "Average close over a period." },
	{ type: "EMA", name: "Exponential Moving Average", description: "Moving average weighted toward recent closes." },
	{ type: "WMA", name: "Weighted Moving Average", description: "Linearly weighted moving average." },
	{ type: "VWAP", name: "Volume Weighted Average Price", description: "Price weighted by traded volume." },
	{ type: "RSI", name: "Relative Strength Index", description: "Momentum oscillator in its own pane." },
	{ type: "MACD", name: "Moving Average Convergence Divergence", description: "MACD, signal, and histogram pane." },
	{ type: "BBANDS", name: "Bollinger Bands", description: "Upper, middle, and lower volatility bands." },
];

export const TV_COLORS = {
	aqua : "#00BCD4",
	blue : "#2196F3",
	fuchsia : "#E040FB",
	gray : "#787B86",
	orange : "#FF9800",
	purple : "#9C27B0",
	red : "#F23645",
	silver : "#B2B5BE",
	teal : "#089981",
	yellow : "#FDD835",
};

export const DEFAULT_INDICATOR_STYLES = {
	VOLUME : { color: TV_COLORS.gray, upColor: TV_COLORS.teal, downColor: TV_COLORS.red },
	SMA : { color: TV_COLORS.blue },
	EMA : { color: TV_COLORS.orange },
	WMA : { color: TV_COLORS.purple },
	VWAP : { color: TV_COLORS.blue, bandColor: "#00E676", fillColor: "#00E676" },
	RSI : { color: TV_COLORS.purple, maColor: TV_COLORS.yellow },
	MACD : {
		color : TV_COLORS.blue,
		signalColor : TV_COLORS.orange,
		histogramUpColor : TV_COLORS.teal,
		histogramDownColor : TV_COLORS.red,
	},
	BBANDS : {
		color : TV_COLORS.blue,
		upperColor : TV_COLORS.blue,
		middleColor : TV_COLORS.orange,
		lowerColor : TV_COLORS.blue,
	},
};

export const FALLBACK_INDICATOR_COLORS = [
	TV_COLORS.blue,
	TV_COLORS.orange,
	TV_COLORS.purple,
	TV_COLORS.aqua,
	TV_COLORS.yellow,
	TV_COLORS.fuchsia,
	TV_COLORS.silver,
	TV_COLORS.teal,
];

export const LINE_WIDTH_OPTIONS = [1, 2, 3, 4];

export function timeframeShortLabel(value) {
	return TIMEFRAME_OPTIONS.find((option) => option.value === value)?.shortLabel || value;
}

export function timeframeRequiresApi(value) {
	return Boolean(TIMEFRAME_OPTIONS.find((option) => option.value === value)?.requiresApi);
}

export function timeframeSeconds(value) {
	const normalized = String(value || "").toLowerCase();
	if (normalized.endsWith("s")) {
		return Number.parseInt(normalized, 10);
	}
	if (normalized.endsWith("m")) {
		return Number.parseInt(normalized, 10) * 60;
	}
	if (normalized.endsWith("h")) {
		return Number.parseInt(normalized, 10) * 60 * 60;
	}
	if (normalized.endsWith("d")) {
		return Number.parseInt(normalized, 10) * 24 * 60 * 60;
	}
	if (normalized.endsWith("w")) {
		return Number.parseInt(normalized, 10) * 7 * 24 * 60 * 60;
	}
	if (normalized.endsWith("mo")) {
		return Number.parseInt(normalized, 10) * 31 * 24 * 60 * 60;
	}
	return null;
}

export function groupedTimeframes() {
	return TIMEFRAME_OPTIONS.reduce((groups, option) => {
		const current = groups.get(option.group) || [];
		current.push(option);
		groups.set(option.group, current);
		return groups;
	}, new Map());
}

export function defaultPeriodForIndicator(type) {
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

export function defaultIndicatorTimeframe(type) {
	if (type === "VOLUME") {
		return "chart";
	}
	return "chart";
}

export function defaultColorForIndicator(type, index = 0) {
	return DEFAULT_INDICATOR_STYLES[type]?.color || FALLBACK_INDICATOR_COLORS[index % FALLBACK_INDICATOR_COLORS.length];
}

export function pickColor(index) {
	return FALLBACK_INDICATOR_COLORS[index % FALLBACK_INDICATOR_COLORS.length];
}

export function effectiveIndicatorColor(type, color, index = 0) {
	if (type === "VWAP" && color === TV_COLORS.aqua) {
		return DEFAULT_INDICATOR_STYLES.VWAP.color;
	}
	return color || defaultColorForIndicator(type, index);
}

export function effectiveVwapBandColor(color) {
	if (!color || color === TV_COLORS.silver) {
		return DEFAULT_INDICATOR_STYLES.VWAP.bandColor;
	}
	return color;
}
