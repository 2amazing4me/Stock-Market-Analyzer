export function formatPrice(value) {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return "-";
	}
	return Number(value).toFixed(2);
}

export function formatVolume(value) {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return "-";
	}
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatCandleChange(candle) {
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

export function colorWithAlpha(color, alpha) {
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

export function formatVolumeScale(value) {
	const number = Number(value);

	if (Math.abs(number) >= 1_000_000) {
		return `${(number / 1_000_000).toFixed(1)}M`;
	}

	if (Math.abs(number) >= 1_000) {
		return `${(number / 1_000).toFixed(0)}K`;
	}

	return number.toFixed(0);
}

export function rsiPriceFormatter(value) {
	return Number(value).toFixed(2);
}

export function macdPriceFormatter(value) {
	const absValue = Math.abs(Number(value));

	if (absValue >= 10) {
		return Number(value).toFixed(2);
	}

	if (absValue >= 1) {
		return Number(value).toFixed(3);
	}

	return Number(value).toFixed(4);
}

export function priceFormatter(value) {
	return Number(value).toFixed(2);
}
