import marketConfig from "../../../shared/market_config.json";

export const EXCHANGE_TIMEZONE = marketConfig.exchangeTimezone;
export const REGULAR_MARKET_OPEN_MINUTES = marketConfig.regularMarketOpenMinutes;
export const REGULAR_MARKET_CLOSE_MINUTES = marketConfig.regularMarketCloseMinutes;
export const PRE_MARKET_BACKGROUND = "rgba(245, 196, 66, 0.1)";
export const AFTER_MARKET_BACKGROUND = "rgba(70, 130, 255, 0.1)";

const FALLBACK_TIMEZONES = [
	EXCHANGE_TIMEZONE,
	"Europe/Bucharest",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"UTC",
	"America/Chicago",
	"America/Los_Angeles",
	"Asia/Tokyo",
	"Asia/Hong_Kong",
];

const exchangeTimeFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone : EXCHANGE_TIMEZONE,
	hour : "2-digit",
	minute : "2-digit",
	hour12 : false,
});

export function systemTimeZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function timezoneOptions() {
	if (typeof Intl.supportedValuesOf === "function") {
		return Intl.supportedValuesOf("timeZone");
	}
	return FALLBACK_TIMEZONES;
}

function timezoneOffsetLabel(timeZone) {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			timeZoneName : "shortOffset",
		}).formatToParts(new Date());
		const offset = parts.find((part) => part.type === "timeZoneName")?.value;
		return offset?.replace("GMT", "UTC") || "UTC";
	} catch {
		return "UTC";
	}
}

export function timezoneLabel(timeZone) {
	return `${timeZone.replace(/_/g, " ")} (${timezoneOffsetLabel(timeZone)})`;
}

export function resolveChartTimeZone(settings) {
	if (settings.timezoneMode === "exchange") {
		return EXCHANGE_TIMEZONE;
	}
	if (settings.timezoneMode === "custom") {
		return settings.customTimezone || systemTimeZone();
	}
	return systemTimeZone();
}

export function chartQueryString(timeframe, limit, settings, bounds = {}) {
	const params = new URLSearchParams({
		timeframe,
		limit : String(limit),
		include_extended_hours : String(settings.includeExtendedHours),
		adjusted : String(settings.adjustDataForDividends),
	});

	if (bounds.before !== undefined && bounds.before !== null) {
		params.set("before", String(bounds.before));
	}

	if (bounds.after !== undefined && bounds.after !== null) {
		params.set("after", String(bounds.after));
	}

	return params.toString();
}

function exchangeMinutes(unixSeconds) {
	const parts = exchangeTimeFormatter.formatToParts(new Date(unixSeconds * 1000));
	const hour = Number(parts.find((part) => part.type === "hour")?.value || 0) % 24;
	const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
	return hour * 60 + minute;
}

export function marketSession(unixSeconds) {
	const minutes = exchangeMinutes(unixSeconds);
	if (minutes < REGULAR_MARKET_OPEN_MINUTES) {
		return "pre";
	}
	if (minutes >= REGULAR_MARKET_CLOSE_MINUTES) {
		return "after";
	}
	return "regular";
}
