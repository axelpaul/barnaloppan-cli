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
	csvDirectory: string,
	row: number,
): Promise<string> {
	const extension = /\.[^./\\]+$/.exec(value)?.[0];
	if (extension && !/^\.(jpe?g|png)$/i.test(extension))
		throw new Error(
			`Row ${row}: photo must be a .jpg, .jpeg, or .png file: ${value}`,
		);
	const bases = isAbsolute(value)
		? [value]
		: [
				...new Set([
					resolve(process.cwd(), value),
					resolve(csvDirectory, value),
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
		throw new Error(`Row ${row}: photo cannot be read: ${tried.join(", ")}`);
	throw new Error(
		`Row ${row}: no .jpg, .jpeg, or .png found for "${value}". Tried ${tried.length} paths, starting with ${tried[0]}`,
	);
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
		const name = get("name");
		const price = Number(get("price").replaceAll(" ", ""));
		if (!name || name.length > 24)
			throw new Error(
				`Row ${row + 1}: name is required and must be at most 24 characters.`,
			);
		if (!Number.isInteger(price) || price < 1)
			throw new Error(
				`Row ${row + 1}: price must be a positive whole number in kr.`,
			);
		const active = !["0", "false", "no"].includes(get("active").toLowerCase());
		const value = get("photo");
		const photo = value
			? await resolvePhoto(value, csvDirectory, row + 1)
			: undefined;
		products.push({ name, price, active, photo });
	}
	return products;
}
