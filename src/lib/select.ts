import { readFile } from "node:fs/promises";
import type { Product } from "../types.ts";
import { parseCsv } from "./csv.ts";

export const DEFAULT_INDEX_FILE = "inventory.csv";

export type Selection = { id: number; name?: string; via: string };

const PHOTO_COLUMNS = ["photo", "image", "filename", "file"];

export function photoStem(value: string): string {
	return (value.split("/").pop() ?? value)
		.replace(/\.[^.]+$/, "")
		.toLowerCase();
}

// The site renames every upload to <product_id>.jpg and keeps no record of the
// original filename, so a photo name can only be resolved through a local index
// written when the products were created.
export async function loadPhotoIndex(
	path: string,
): Promise<Map<string, number[]>> {
	const rows = parseCsv((await readFile(path, "utf8")).replace(/^﻿/, ""));
	const header = (rows[0] ?? []).map((field) => field.trim().toLowerCase());
	const idColumn = header.indexOf("id");
	const photoColumn = PHOTO_COLUMNS.map((name) => header.indexOf(name)).find(
		(index) => index !== -1,
	);
	if (idColumn === -1 || photoColumn === undefined || photoColumn === -1)
		throw new Error(`${path} needs an "id" column and a "photo" column.`);
	const index = new Map<string, number[]>();
	for (const row of rows.slice(1)) {
		const id = Number(row[idColumn]?.trim());
		const photo = row[photoColumn]?.trim();
		if (!Number.isInteger(id) || !photo) continue;
		const key = photoStem(photo);
		index.set(key, [...(index.get(key) ?? []), id]);
	}
	return index;
}

function matchOne(
	selector: string,
	products: Product[],
	byId: Map<number, Product>,
	index: Map<string, number[]>,
): number[] {
	if (/^\d+$/.test(selector)) {
		const id = Number(selector);
		if (!byId.has(id))
			throw new Error(`No listing with ID ${id} in this booth.`);
		return [id];
	}
	const fromIndex = index.get(photoStem(selector));
	if (fromIndex?.length) {
		const live = fromIndex.filter((id) => byId.has(id));
		if (!live.length)
			throw new Error(
				`"${selector}" maps to ${fromIndex.join(", ")} in the index, but none of those are in the booth. Regenerate the index.`,
			);
		return live;
	}
	const needle = selector.toLowerCase();
	const exact = products.filter(
		(product) => product.name.toLowerCase() === needle,
	);
	if (exact.length) return exact.map((product) => product.id);
	return products
		.filter((product) => product.name.toLowerCase().includes(needle))
		.map((product) => product.id);
}

export function resolveSelectors(
	selectors: string[],
	products: Product[],
	index: Map<string, number[]>,
	all: boolean,
): Selection[] {
	const byId = new Map(products.map((product) => [product.id, product]));
	const selected: Selection[] = [];
	const seen = new Set<number>();
	for (const selector of selectors.map((value) => value.trim())) {
		const ids = matchOne(selector, products, byId, index);
		if (!ids.length)
			throw new Error(`Nothing in the booth matches "${selector}".`);
		// Never let one ambiguous word hide more than the caller intended.
		if (ids.length > 1 && !all)
			throw new Error(
				`"${selector}" matches ${ids.length} listings: ${ids
					.map((id) => `${id} (${byId.get(id)?.name ?? "?"})`)
					.join(", ")}. Pass --all to take every match, or name the IDs.`,
			);
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			selected.push({
				id,
				...(byId.get(id)?.name ? { name: byId.get(id)?.name } : {}),
				via: selector,
			});
		}
	}
	return selected;
}

export type IndexRow = {
	id: number;
	name: string;
	price?: number;
	photo: string;
	active: boolean;
};

function csvField(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// Merges into any existing index rather than replacing it: a later batch must
// not drop the photo mapping for products already in the booth.
export async function mergeIntoIndex(
	path: string,
	rows: IndexRow[],
): Promise<{ added: number; total: number }> {
	const existing: string[] = [];
	const seen = new Set<number>();
	try {
		const parsed = parseCsv((await readFile(path, "utf8")).replace(/^﻿/, ""));
		const header = (parsed[0] ?? []).map((f) => f.trim().toLowerCase());
		const idColumn = header.indexOf("id");
		for (const row of parsed.slice(1)) {
			if (!row.length || row.every((field) => !field.trim())) continue;
			const id = Number(row[idColumn]?.trim());
			if (Number.isInteger(id)) seen.add(id);
			existing.push(row.map(csvField).join(","));
		}
	} catch {
		// No usable index yet; start a new one.
	}
	const fresh = rows.filter((row) => !seen.has(row.id));
	const lines = ["position,id,name,price,photo,active", ...existing];
	for (const row of fresh)
		lines.push(
			[
				String(lines.length),
				String(row.id),
				csvField(row.name),
				row.price === undefined ? "" : String(row.price),
				csvField(row.photo),
				String(row.active),
			].join(","),
		);
	// Renumber so position always reflects file order.
	const body = lines.slice(1).map((line, offset) => {
		const fields = parseCsv(line)[0] ?? [];
		fields[0] = String(offset + 1);
		return fields.map(csvField).join(",");
	});
	await Bun.write(path, `${lines[0]}\n${body.join("\n")}\n`);
	return { added: fresh.length, total: body.length };
}
