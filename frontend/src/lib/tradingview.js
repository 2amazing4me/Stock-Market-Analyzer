export function normalizeTicker(raw) {
	return (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function formatChartTime(unixSeconds, timeframe) {
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
	});

	if (timeframe === "1d") {
		return datePart;
	}

	const timePart = date.toLocaleTimeString(undefined, {
		hour : "2-digit",
		minute : "2-digit",
		hour12 : false,
	});

	return `${datePart} ${timePart}`;
}
