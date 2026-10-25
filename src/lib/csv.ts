import { access, constants, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { CsvProduct } from "../types.ts";

// Accepted spellings for each column, in priority order.
const COLUMNS = {
	name: ["name", "title"],
	price: ["price"],
	active: ["active"],
	photo: ["photo", "image", "filename", "file"],
} as const;

const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"];

export function parseCsv(source: string): string[][] {
	const rows: string[][] = [[]];
	let value = "";
	let quoted = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source.charAt(index);
		if (quoted) {
			if (character === '"' && source[index + 1] === '"') {
				value += '"';
				index += 1;
			} else if (character === '"') quoted = false;
			else value += character;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === ",") {
			const current = rows.at(-1);
			if (!current) throw new Error("CSV parser lost its current row.");
			current.push(value);
			value = "";
		} else if (character === "\n") {
			const current = rows.at(-1);
			if (!current) throw new Error("CSV parser lost its current row.");
			current.push(value.replace(/\r$/, ""));
			rows.push([]);
			value = "";
		} else value += character;
	}
	if (quoted) throw new Error("CSV has an unterminated quoted field.");
	const current = rows.at(-1);
	if (!current) throw new Error("CSV parser produced no rows.");
	if (value || current.length) current.push(value.replace(/\r$/, ""));
	else rows.pop();
	return rows;
}

function columnIndex(header: string[], aliases: readonly string[]): number {
	for (const alias of aliases) {
		const index = header.indexOf(alias);
		if (index !== -1) return index;
	}
	return -1;
}

async function readable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

// A photo may be given with or without its extension, and relative to either
// the working directory or the CSV's own directory. Returns an absolute path
// so the upload works whatever the caller's directory is.
async function resolvePhoto(
	value: string,
	baseDirectory: string,
	label: string,
): Promise<string> {
	const extension = /\.[^./\\]+$/.exec(value)?.[0];
	if (extension && !/^\.(jpe?g|png)$/i.test(extension))
		throw new Error(
			`${label}: photo must be a .jpg, .jpeg, or .png file: ${value}`,
		);
	const bases = isAbsolute(value)
		? [value]
		: [
				...new Set([
					resolve(process.cwd(), value),
					resolve(baseDirectory, value),
				]),
			];
	const tried: string[] = [];
	for (const base of bases) {
		const candidates = extension
			? [base]
			: PHOTO_EXTENSIONS.map((suffix) => base + suffix);
		for (const candidate of candidates) {
			if (await readable(candidate)) return candidate;
			tried.push(candidate);
		}
	}
	if (extension)
		throw new Error(`${label}: photo cannot be read: ${tried.join(", ")}`);
	throw new Error(
		`${label}: no .jpg, .jpeg, or .png found for "${value}". Tried ${tried.length} paths, starting with ${tried[0]}`,
	);
}

export type RawProduct = {
	name: string;
	price: string | number;
	active?: string | boolean;
	photo?: string;
};

// Shared by the CSV reader and the MCP tool, so both apply the same limits.
// `label` prefixes errors ("Row 3", "products[2]"); relative photos resolve
// against the working directory, then `baseDirectory`.
export async function normalizeProduct(
	raw: RawProduct,
	label: string,
	baseDirectory = process.cwd(),
): Promise<CsvProduct> {
	const name = raw.name.trim();
	const price = Number(String(raw.price).replaceAll(" ", ""));
	if (!name || name.length > 24)
		throw new Error(
			`${label}: name is required and must be at most 24 characters.`,
		);
	if (!Number.isInteger(price) || price < 1)
		throw new Error(`${label}: price must be a positive whole number in kr.`);
	const active =
		typeof raw.active === "boolean"
			? raw.active
			: !["0", "false", "no"].includes((raw.active ?? "").trim().toLowerCase());
	const value = raw.photo?.trim();
	const photo = value
		? await resolvePhoto(value, baseDirectory, label)
		: undefined;
	return { name, price, active, photo };
}

export async function readProductsCsv(path: string): Promise<CsvProduct[]> {
	const source = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
	const rows = parseCsv(source);
	if (rows.length < 2)
		throw new Error("CSV needs a header and at least one product.");
	const firstRow = rows[0];
	if (!firstRow) throw new Error("CSV needs a header row.");
	const header = firstRow.map((field) => field.trim().toLowerCase());
	const indexes = {
		name: columnIndex(header, COLUMNS.name),
		price: columnIndex(header, COLUMNS.price),
		active: columnIndex(header, COLUMNS.active),
		photo: columnIndex(header, COLUMNS.photo),
	};
	if (indexes.name === -1 || indexes.price === -1)
		throw new Error(
			'CSV needs a name column (or "title") and a price column. Optional: active, and photo (or "image").',
		);
	const csvDirectory = dirname(resolve(path));
	const products: CsvProduct[] = [];
	for (let row = 1; row < rows.length; row += 1) {
		const values = rows[row];
		if (!values) continue;
		const get = (column: keyof typeof indexes) =>
			indexes[column] === -1 ? "" : (values[indexes[column]]?.trim() ?? "");
		products.push(
			await normalizeProduct(
				{
					name: get("name"),
					price: get("price"),
					active: get("active"),
					photo: get("photo"),
				},
				`Row ${row + 1}`,
				csvDirectory,
			),
		);
	}
	return products;
}

export type ImageUpdateRow = { id: number; photo: string };

function productId(value: unknown, label: string): number {
	const id = Number(typeof value === "string" ? value.trim() : value);
	if (!Number.isInteger(id) || id < 1)
		throw new Error(`${label}: id must be a product ID.`);
	return id;
}

export async function normalizeImageUpdates(
	raw: Array<{ id: string | number; photo: string }>,
	labelFor: (position: number) => string,
	baseDirectory = process.cwd(),
): Promise<ImageUpdateRow[]> {
	const updates: ImageUpdateRow[] = [];
	const seen = new Set<number>();
	for (const [position, entry] of raw.entries()) {
		const label = labelFor(position);
		const id = productId(entry.id, label);
		if (seen.has(id))
			throw new Error(`${label}: ID ${id} appears more than once.`);
		seen.add(id);
		const value = entry.photo?.trim();
		if (!value) throw new Error(`${label}: photo is required.`);
		updates.push({
			id,
			photo: await resolvePhoto(value, baseDirectory, label),
		});
	}
	if (!updates.length) throw new Error("Give at least one listing to update.");
	return updates;
}

// id,photo - the listing is addressed by ID because names can repeat.
export async function readImageUpdatesCsv(
	path: string,
): Promise<ImageUpdateRow[]> {
	const rows = parseCsv((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
	const firstRow = rows[0];
	if (!firstRow || rows.length < 2)
		throw new Error("CSV needs a header and at least one row.");
	const header = firstRow.map((field) => field.trim().toLowerCase());
	const idColumn = header.indexOf("id");
	const photoColumn = columnIndex(header, COLUMNS.photo);
	if (idColumn === -1 || photoColumn === -1)
		throw new Error('CSV needs an "id" column and a "photo" column.');
	const body = rows
		.map((values, row) => ({ values, row }))
		.slice(1)
		.filter(({ values }) => values.some((field) => field.trim()));
	return normalizeImageUpdates(
		body.map(({ values }) => ({
			id: values[idColumn] ?? "",
			photo: values[photoColumn] ?? "",
		})),
		(position) => `Row ${(body[position]?.row ?? 0) + 1}`,
		dirname(resolve(path)),
	);
}

export type DetailUpdateRow = { id: number; name?: string; price?: number };

export function normalizeDetailUpdates(
	raw: Array<{ id: string | number; name?: string; price?: string | number }>,
	labelFor: (position: number) => string,
): DetailUpdateRow[] {
	const updates: DetailUpdateRow[] = [];
	const seen = new Set<number>();
	for (const [position, entry] of raw.entries()) {
		const label = labelFor(position);
		const id = productId(entry.id, label);
		if (seen.has(id))
			throw new Error(`${label}: ID ${id} appears more than once.`);
		seen.add(id);
		const name = entry.name?.trim() ?? "";
		const priceText = String(entry.price ?? "").trim();
		if (name && name.length > 24)
			throw new Error(`${label}: name must be at most 24 characters.`);
		const price = priceText ? Number(priceText.replaceAll(" ", "")) : undefined;
		if (price !== undefined && (!Number.isInteger(price) || price < 1))
			throw new Error(`${label}: price must be a positive whole number in kr.`);
		if (!name && price === undefined)
			throw new Error(`${label}: needs a new name or a new price.`);
		updates.push({
			id,
			...(name ? { name } : {}),
			...(price === undefined ? {} : { price }),
		});
	}
	if (!updates.length) throw new Error("Give at least one listing to edit.");
	return updates;
}

// id plus at least one of name / price. Addressed by ID because names repeat.
export async function readDetailUpdatesCsv(
	path: string,
): Promise<DetailUpdateRow[]> {
	const rows = parseCsv((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
	const firstRow = rows[0];
	if (!firstRow || rows.length < 2)
		throw new Error("CSV needs a header and at least one row.");
	const header = firstRow.map((field) => field.trim().toLowerCase());
	const idColumn = header.indexOf("id");
	const nameColumn = columnIndex(header, COLUMNS.name);
	const priceColumn = columnIndex(header, COLUMNS.price);
	if (idColumn === -1) throw new Error('CSV needs an "id" column.');
	if (nameColumn === -1 && priceColumn === -1)
		throw new Error('CSV needs a "name" column, a "price" column, or both.');
	const body = rows
		.map((values, row) => ({ values, row }))
		.slice(1)
		.filter(({ values }) => values.some((field) => field.trim()));
	return normalizeDetailUpdates(
		body.map(({ values }) => ({
			id: values[idColumn] ?? "",
			name: nameColumn === -1 ? undefined : values[nameColumn],
			price: priceColumn === -1 ? undefined : values[priceColumn],
		})),
		(position) => `Row ${(body[position]?.row ?? 0) + 1}`,
	);
}
