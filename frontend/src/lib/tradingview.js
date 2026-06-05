export function normalizeTicker(raw) {
	return (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function isSecondTimeframe(timeframe) {
	return String(timeframe || "").toLowerCase().endsWith("s");
}

export function formatChartTime(unixSeconds, timeframe, timeZone) {
	if (!unixSeconds) {
		return "-";
	}

	const date = new Date(unixSeconds * 1000);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	const datePart = date.toLocaleDateString(undefined, {
		year : "numeric",
		month : "short",
		day : "2-digit",
		timeZone,
	});

	if (timeframe === "1d") {
		return datePart;
	}

	const timePart = date.toLocaleTimeString(undefined, {
		hour : "2-digit",
		minute : "2-digit",
		second : isSecondTimeframe(timeframe) ? "2-digit" : undefined,
		hour12 : false,
		timeZone,
	});

	return `${datePart} ${timePart}`;
}

export function formatChartTickTime(unixSeconds, timeframe, timeZone) {
	if (!unixSeconds) {
		return "-";
	}

	const date = new Date(unixSeconds * 1000);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	if (timeframe === "1d" || timeframe?.endsWith("w") || timeframe?.endsWith("mo")) {
		return date.toLocaleDateString(undefined, {
			month : "short",
			day : "2-digit",
			timeZone,
		});
	}

	return date.toLocaleTimeString(undefined, {
		hour : "2-digit",
		minute : "2-digit",
		second : isSecondTimeframe(timeframe) ? "2-digit" : undefined,
		hour12 : false,
		timeZone,
	});
}
