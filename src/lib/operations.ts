// Booth operations shared by the CLI and the MCP server, so the two cannot
// drift. Each write has a plan step (read-only, used for dry runs) and an
// apply step that performs it.
import type { CsvProduct, Product } from "../types.ts";
import {
	deleteProducts as deleteProductsRequest,
	getPayoutHtml,
	getProductsHtml,
	saveProducts,
	setProductsActive,
	unprintProducts as unprintProductsRequest,
	updateProductDetails,
	updateProductImages,
	uploadImage,
} from "./client.ts";
import type { DetailUpdateRow, ImageUpdateRow } from "./csv.ts";
import { productsFromHtml } from "./products.ts";
import { type SalesReport, salesFromHtml } from "./sales.ts";
import {
	DEFAULT_INDEX_FILE,
	loadPhotoIndex,
	mergeIntoIndex,
	resolveSelectors,
	type Selection,
} from "./select.ts";

export async function listProducts(): Promise<Product[]> {
	return productsFromHtml(await getProductsHtml());
}

export async function salesReport(): Promise<SalesReport> {
	return salesFromHtml(await getPayoutHtml());
}

export type SelectOptions = { all?: boolean; indexPath?: string };

// Resolves IDs, names and photo names against the live booth. A broad
// selector matching several listings is refused unless `all` is set.
export async function selectProducts(
	selectors: string[],
	options: SelectOptions = {},
): Promise<Selection[]> {
	if (!selectors.length) throw new Error("Give at least one selector.");
	const products = await listProducts();
	let index = new Map<string, number[]>();
	try {
		index = await loadPhotoIndex(options.indexPath ?? DEFAULT_INDEX_FILE);
	} catch (error) {
		// An explicitly requested index must exist; the default one need not.
		if (options.indexPath) throw error;
	}
	return resolveSelectors(selectors, products, index, options.all ?? false);
}

export async function setActive(
	selected: Selection[],
	active: boolean,
): Promise<string | undefined> {
	return setProductsActive(
		selected.map((selection) => selection.id),
		active,
	);
}

export const UNPRINT_NOTE =
	"Unprinting cannot be undone from this CLI. Reprint the tag from the site to mark it printed again.";

export async function unprint(
	selected: Selection[],
): Promise<string | undefined> {
	return unprintProductsRequest(selected.map((selection) => selection.id));
}

export function validateProductIds(ids: number[]): number[] {
	if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1))
		throw new Error("Give one or more positive integer product IDs.");
	return ids;
}

export async function deleteProducts(
	ids: number[],
): Promise<string | undefined> {
	return deleteProductsRequest(validateProductIds(ids));
}

export type AddResult = {
	count: number;
	created: number;
	index?: { file: string; added: number; total: number };
	products: Product[];
	reportedIds?: number[];
	warning?: string;
};

export async function addProducts(
	products: CsvProduct[],
	options: { indexPath?: string } = {},
): Promise<AddResult> {
	if (!products.length) throw new Error("Give at least one product to add.");
	// Existing IDs, so the new ones can be reported exactly: saveBooking
	// reports success without always returning newProductIds.
	const before = new Set((await listProducts()).map((product) => product.id));
	const payload = [] as Record<string, unknown>[];
	const uploaded = new Map<string, string>();
	for (const [order, product] of products.entries()) {
		const tempId = String(order);
		const image = product.photo
			? await uploadImage(product.photo, { tempId })
			: "";
		// Two products sharing one uploaded path means the images clobbered
		// each other and all but one listing would end up with no photo.
		if (image) {
			const clash = uploaded.get(image);
			if (clash)
				throw new Error(
					`Barnaloppan returned the same upload path for "${clash}" and "${product.name}" (${image}). Nothing was saved; re-run so each photo gets its own upload.`,
				);
			uploaded.set(image, product.name);
		}
		payload.push({
			product_id: "",
			temp_id: tempId,
			image,
			newImage: image ? "1" : "0",
			deleteImage: "0",
			_delete: "0",
			name: product.name,
			price: String(product.price),
			imageUpload: null,
			active: product.active,
			image_2: "",
			newImage2: "0",
			deleteImage2: "0",
			webshop: "0",
			order,
		});
	}
	const reported = await saveProducts(payload);
	const created = (await listProducts()).filter(
		(product) => !before.has(product.id),
	);
	let indexResult: { added: number; total: number } | undefined;
	// created comes back newest-first, which is the order the products were
	// sent, so the two line up only when every product was created.
	if (options.indexPath && created.length === products.length)
		indexResult = await mergeIntoIndex(
			options.indexPath,
			created.map((product, position) => ({
				id: product.id,
				name: product.name,
				...(product.price === undefined ? {} : { price: product.price }),
				photo:
					products[position]?.photo
						?.split("/")
						.pop()
						?.replace(/\.[^.]+$/, "") ?? "",
				active: product.active ?? true,
			})),
		);
	return {
		count: products.length,
		created: created.length,
		...(indexResult && options.indexPath
			? { index: { file: options.indexPath, ...indexResult } }
			: {}),
		products: created,
		...(reported.length ? { reportedIds: reported } : {}),
		...(created.length === products.length
			? {}
			: {
					warning: `Sent ${products.length} products but the booth gained ${created.length}.`,
				}),
	};
}

export type EditPlanEntry = {
	id: number;
	from: { name: string; price?: number };
	to: { name: string; price: number };
	product: Product;
};

export async function planEdit(
	rows: DetailUpdateRow[],
): Promise<EditPlanEntry[]> {
	const products = new Map(
		(await listProducts()).map((product) => [product.id, product]),
	);
	return rows.map((row) => {
		const product = products.get(row.id);
		if (!product)
			throw new Error(`No listing with ID ${row.id} in this booth.`);
		// A printed tag makes the site accept the save and ignore the change,
		// so refuse rather than report a success that did nothing.
		if (product.status !== "pending")
			throw new Error(
				`${row.id} (${product.name}) still has a printed price tag, so the site would ignore a name or price change. Unprint it first ("barnaloppan unprint ${row.id} --yes"), and reprint its tag afterwards.`,
			);
		if (product.price === undefined && row.price === undefined)
			throw new Error(
				`${row.id} (${product.name}) has no readable current price, so give a price for it.`,
			);
		return {
			id: row.id,
			from: { name: product.name, price: product.price },
			to: {
				name: row.name ?? product.name,
				price: row.price ?? (product.price as number),
			},
			product,
		};
	});
}

export async function applyEdit(plan: EditPlanEntry[]): Promise<{
	count: number;
	edited: Array<{
		id: number;
		name?: string;
		price?: number;
		applied: boolean;
	}>;
	warning?: string;
}> {
	await updateProductDetails(
		plan.map((entry) => ({
			productId: entry.id,
			name: entry.to.name,
			price: entry.to.price,
			image: `uploads/productimages/${entry.id}.jpg`,
			active: entry.product.active ?? true,
			webshop: entry.product.webshop ?? "0",
		})),
	);
	const after = new Map(
		(await listProducts()).map((product) => [product.id, product]),
	);
	// Read it back: this site reports success on changes it discarded.
	const edited = plan.map((entry) => {
		const now = after.get(entry.id);
		return {
			id: entry.id,
			name: now?.name,
			price: now?.price,
			applied: now?.name === entry.to.name && now?.price === entry.to.price,
		};
	});
	const failed = edited.filter((entry) => !entry.applied);
	return {
		count: edited.length,
		edited,
		...(failed.length
			? { warning: `${failed.length} change(s) did not take effect.` }
			: {}),
	};
}

export type ImagePlanEntry = ImageUpdateRow & {
	name: string;
	product: Product;
};

export async function planSetImage(
	rows: ImageUpdateRow[],
): Promise<ImagePlanEntry[]> {
	const products = new Map(
		(await listProducts()).map((product) => [product.id, product]),
	);
	return rows.map((row) => {
		const product = products.get(row.id);
		if (!product)
			throw new Error(`No listing with ID ${row.id} in this booth.`);
		return { ...row, name: product.name, product };
	});
}

export async function applySetImage(plan: ImagePlanEntry[]): Promise<{
	count: number;
	replaced: Array<{ id: number; name: string; photo: string }>;
}> {
	const updates = [];
	for (const entry of plan)
		updates.push({
			productId: entry.id,
			image: await uploadImage(entry.photo, { productId: entry.id }),
			// Carry the current state through, so replacing a photo never
			// un-hides a listing or changes its webshop flag.
			active: entry.product.active ?? true,
			webshop: entry.product.webshop ?? "0",
		});
	const clash = new Map<string, number>();
	for (const update of updates) {
		const seen = clash.get(update.image);
		if (seen !== undefined)
			throw new Error(
				`Barnaloppan returned the same upload path for ${seen} and ${update.productId} (${update.image}). Nothing was saved.`,
			);
		clash.set(update.image, update.productId);
	}
	await updateProductImages(updates);
	return {
		count: updates.length,
		replaced: plan.map(({ id, name, photo }) => ({ id, name, photo })),
	};
}
