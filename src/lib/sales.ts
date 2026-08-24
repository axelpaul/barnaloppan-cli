export type Sale = {
	name: string;
	soldAt: string;
	soldAtIso?: string;
	amount: number;
	online?: boolean;
};

export type SalesReport = {
	count: number;
	sales: Sale[];
	soldTotal?: number;
	commission?: number;
	commissionRate?: string;
	paidOut?: number;
	balance?: number;
	rowSum?: number;
	warning?: string;
};

function text(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ")
		.trim();
}

// Icelandic formatting: "5.000 kr." is five thousand, dot groups thousands.
function amount(value: string): number | undefined {
	const match = /(-?)\s*([\d.\s]+)\s*kr/i.exec(value);
	if (!match) return undefined;
	const digits = match[2]?.replace(/[.\s]/g, "");
	if (!digits) return undefined;
	const parsed = Number(digits);
	return Number.isFinite(parsed) ? parsed : undefined;
}

// "24.8.2026, 13:18" -> "2026-08-24T13:18". Local booth time; no zone implied.
function isoDate(value: string): string | undefined {
	const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/.exec(
		value,
	);
	if (!match) return undefined;
	const [, day, month, year, hour, minute] = match;
	const pad = (part: string) => part.padStart(2, "0");
	const date = `${year}-${pad(month ?? "1")}-${pad(day ?? "1")}`;
	return hour ? `${date}T${pad(hour)}:${minute}` : date;
}

function labelled(html: string, label: RegExp): number | undefined {
	const match = label.exec(html);
	if (!match) return undefined;
	return amount(html.slice(match.index, match.index + 400));
}

export function salesFromHtml(html: string): SalesReport {
	const body = /<tbody>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? "";
	const sales: Sale[] = [];
	for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
		const cells = [
			...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
		].map((cell) => cell[1] ?? "");
		if (cells.length < 4) continue;
		// The first cell holds the name, then a mobile-only copy of the date.
		const name = text(
			/<p[^>]*>([\s\S]*?)<\/p>/i.exec(cells[0] ?? "")?.[1] ?? "",
		);
		const soldAt = text(cells[1] ?? "");
		const value = amount(text(cells[3] ?? ""));
		if (!name || value === undefined) continue;
		const iso = isoDate(soldAt);
		// A tick means sold online, a cross means not. Anything else is left
		// unset rather than reported as false.
		const marker = cells[4] ?? "";
		const online = /fa-check/i.test(marker)
			? true
			: /fa-times/i.test(marker)
				? false
				: undefined;
		sales.push({
			name,
			soldAt,
			...(iso ? { soldAtIso: iso } : {}),
			amount: value,
			...(online === undefined ? {} : { online }),
		});
	}
	const soldTotal = labelled(html, /selt fyrir samtals/i);
	const commission = labelled(html, /Söluþóknun/i);
	const rowSum = sales.reduce((total, sale) => total + sale.amount, 0);
	return {
		count: sales.length,
		sales,
		...(soldTotal === undefined ? {} : { soldTotal }),
		...(commission === undefined ? {} : { commission }),
		...(() => {
			const rate = /Söluþóknun\s*([\d.,]+\s*%)/i.exec(text(html))?.[1];
			return rate ? { commissionRate: rate.replace(/\s+/g, "") } : {};
		})(),
		...(() => {
			const paidOut = labelled(html, /Útborgað/i);
			return paidOut === undefined ? {} : { paidOut };
		})(),
		...(() => {
			const balance = labelled(html, /Inneign/i);
			return balance === undefined ? {} : { balance };
		})(),
		rowSum,
		...(soldTotal !== undefined && soldTotal !== rowSum
			? {
					warning: `Rows add up to ${rowSum} but the site reports ${soldTotal}.`,
				}
			: {}),
	};
}
