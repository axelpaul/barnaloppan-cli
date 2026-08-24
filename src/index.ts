#!/usr/bin/env bun

import {
	deleteProducts,
	getPayoutHtml,
	getProductsHtml,
	login,
	saveProducts,
	setProductsActive,
	unprintProducts,
	updateProductDetails,
	updateProductImages,
	uploadImage,
} from "./lib/client.ts";
import { clearSession, loadSession, SESSION_PATH } from "./lib/config.ts";
import { credentialsFromEnv, ENV_PATH } from "./lib/credentials.ts";
import {
	readDetailUpdatesCsv,
	readImageUpdatesCsv,
	readProductsCsv,
} from "./lib/csv.ts";
import { credentialsFrom1Password } from "./lib/onepassword.ts";
import { isJsonMode, output } from "./lib/output.ts";
import { productsFromHtml } from "./lib/products.ts";
import { promptLine, promptSecret, readSecretFromStdin } from "./lib/prompt.ts";
import { salesFromHtml } from "./lib/sales.ts";
import {
	DEFAULT_INDEX_FILE,
	loadPhotoIndex,
	mergeIntoIndex,
	resolveSelectors,
} from "./lib/select.ts";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--booking-id", "--email", "--index"]);
const positional = args.filter(
	(arg, index) =>
		!arg.startsWith("-") && !VALUE_FLAGS.has(args[index - 1] ?? ""),
);
const json = isJsonMode({ json: has("--json"), pretty: has("--pretty") });

function help(): void {
	console.log(`barnaloppan - CLI for Barnaloppan booth inventory

Usage:
  barnaloppan auth login [--email you@example.com] [--booking-id ID]
  barnaloppan auth login --from-env | --from-1password [--booking-id ID]
  barnaloppan auth status [--check] | logout
  barnaloppan list [--json]
  barnaloppan sales
  barnaloppan add products.csv [--yes] [--index inventory.csv]
  barnaloppan set-image updates.csv [--yes]
  barnaloppan unprint <id | name | photo> [more] [--all] [--yes]
  barnaloppan edit updates.csv [--yes]
  barnaloppan hide | show <id | name | photo> [more] [--all] [--yes]
  barnaloppan delete <product-id> [more IDs] [--yes]

CSV columns: name (or title), price, active, photo (or image).
A photo may omit its extension: IMG_0729 finds IMG_0729.jpg/.jpeg/.png next to
the CSV or in the current directory.
Creation and deletion are dry-run by default; --yes is required for writes.
Credentials: BARNALOPPAN_EMAIL / BARNALOPPAN_PASSWORD (environment, ./.env, or
~/.config/barnaloppan/.env), else 1Password, else an interactive prompt. A
password is never accepted as a command-line argument.
You log in once; the session cookie is reused by every later command.
"auth status --check" asks the site whether that cookie is still valid.`);
}

type ResolvedCredentials = {
	email: string;
	password: string;
	source: "1password" | "env" | "stdin" | "prompt";
};

async function resolveCredentials(): Promise<ResolvedCredentials> {
	if (has("--from-1password"))
		return { ...(await credentialsFrom1Password()), source: "1password" };
	if (has("--password") || args.some((arg) => arg.startsWith("--password=")))
		throw new Error(
			"--password is not accepted: the value would land in your shell history and be visible to every process on this machine. Omit it to be prompted, put BARNALOPPAN_PASSWORD in .env, or pipe it in with --password-stdin.",
		);
	const env = await credentialsFromEnv();
	if (has("--from-env")) {
		if (!env.email || !env.password)
			throw new Error(
				`--from-env needs BARNALOPPAN_EMAIL and BARNALOPPAN_PASSWORD, set in the environment, ./.env, or ${ENV_PATH}.`,
			);
		return { email: env.email, password: env.password, source: "env" };
	}
	const email =
		value("--email")?.trim() ||
		env.email ||
		(await promptLine("Barnaloppan email: "));
	if (!email) throw new Error("An email address is required.");
	if (has("--password-stdin")) {
		const password = await readSecretFromStdin();
		if (!password) throw new Error("A password is required.");
		return { email, password, source: "stdin" };
	}
	if (env.password) return { email, password: env.password, source: "env" };
	const password = await promptSecret("Barnaloppan password: ");
	if (!password) throw new Error("A password is required.");
	return { email, password, source: "prompt" };
}

async function main(): Promise<void> {
	const command = positional[0];
	if (has("--help") || !command || command === "help") return help();
	if (command === "version") return output({ version: "0.1.0" }, json);
	if (command === "auth") {
		const subcommand = positional[1];
		if (subcommand === "login") {
			const { email, password, source } = await resolveCredentials();
			const requestedBookingId = value("--booking-id");
			const bookingId = requestedBookingId
				? Number(requestedBookingId)
				: undefined;
			if (bookingId !== undefined && !Number.isInteger(bookingId))
				throw new Error("--booking-id must be an integer.");
			const resolvedBookingId = await login(email, password, bookingId);
			return output(
				{
					status: "authenticated",
					bookingId: resolvedBookingId,
					credentialSource: source,
					sessionFile: SESSION_PATH,
				},
				json,
			);
		}
		if (subcommand === "status") {
			const session = await loadSession();
			const stored = {
				authenticated: true,
				bookingId: session.bookingId,
				sessionFile: SESSION_PATH,
			};
			if (!has("--check")) return output(stored, json);
			try {
				await getProductsHtml();
				return output({ ...stored, live: true }, json);
			} catch (error) {
				process.exitCode = 1;
				return output(
					{ ...stored, live: false, reason: (error as Error).message },
					json,
				);
			}
		}
		if (subcommand === "logout")
			return output({ loggedOut: await clearSession() }, json);
		return help();
	}
	if (command === "list")
		return output(productsFromHtml(await getProductsHtml()), true);
	if (command === "sales")
		return output(salesFromHtml(await getPayoutHtml()), true);
	if (command === "add") {
		const csv = positional[1];
		if (!csv) throw new Error("Usage: barnaloppan add products.csv [--yes]");
		const products = await readProductsCsv(csv);
		if (!has("--yes"))
			return output({ dryRun: true, count: products.length, products }, true);
		// Existing IDs, so the new ones can be reported exactly: saveBooking
		// reports success without always returning newProductIds.
		const before = new Set(
			productsFromHtml(await getProductsHtml()).map((product) => product.id),
		);
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
		const created = productsFromHtml(await getProductsHtml()).filter(
			(product) => !before.has(product.id),
		);
		const indexPath = value("--index");
		let indexResult: { added: number; total: number } | undefined;
		// created comes back newest-first, which is the order the products were
		// sent, so the two line up only when every product was created.
		if (indexPath && created.length === products.length)
			indexResult = await mergeIntoIndex(
				indexPath,
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
		return output(
			{
				count: products.length,
				created: created.length,
				...(indexResult ? { index: { file: indexPath, ...indexResult } } : {}),
				products: created,
				...(reported.length ? { reportedIds: reported } : {}),
				...(created.length === products.length
					? {}
					: {
							warning: `Sent ${products.length} products but the booth gained ${created.length}.`,
						}),
			},
			true,
		);
	}
	if (command === "unprint") {
		const selectors = positional.slice(1);
		if (!selectors.length)
			throw new Error(
				"Usage: barnaloppan unprint <id | name | photo> [more] [--all] [--yes]",
			);
		const products = productsFromHtml(await getProductsHtml());
		const requestedIndex = value("--index");
		let index = new Map<string, number[]>();
		try {
			index = await loadPhotoIndex(requestedIndex ?? DEFAULT_INDEX_FILE);
		} catch (error) {
			if (requestedIndex) throw error;
		}
		const selected = resolveSelectors(selectors, products, index, has("--all"));
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: selected.length,
					wouldUnprint: selected,
					note: "Unprinting cannot be undone from this CLI. Reprint the tag from the site to mark it printed again.",
				},
				true,
			);
		const message = await unprintProducts(
			selected.map((selection) => selection.id),
		);
		return output(
			{ count: selected.length, unprinted: selected, message },
			true,
		);
	}
	if (command === "edit") {
		const csv = positional[1];
		if (!csv) throw new Error("Usage: barnaloppan edit updates.csv [--yes]");
		const rows = await readDetailUpdatesCsv(csv);
		const products = new Map(
			productsFromHtml(await getProductsHtml()).map((product) => [
				product.id,
				product,
			]),
		);
		const plan = rows.map((row) => {
			const product = products.get(row.id);
			if (!product)
				throw new Error(`No listing with ID ${row.id} in this booth.`);
			// A printed tag makes the site accept the save and ignore the change,
			// so refuse rather than report a success that did nothing.
			if (product.status !== "pending")
				throw new Error(
					`${row.id} (${product.name}) still has a printed price tag, so the site would ignore a name or price change. Run "barnaloppan unprint ${row.id} --yes" first, and reprint its tag afterwards.`,
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
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: plan.length,
					wouldEdit: plan.map(({ id, from, to }) => ({ id, from, to })),
				},
				true,
			);
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
			productsFromHtml(await getProductsHtml()).map((product) => [
				product.id,
				product,
			]),
		);
		// Read it back: this site reports success on changes it discarded.
		const applied = plan.map((entry) => {
			const now = after.get(entry.id);
			return {
				id: entry.id,
				name: now?.name,
				price: now?.price,
				applied: now?.name === entry.to.name && now?.price === entry.to.price,
			};
		});
		const failed = applied.filter((entry) => !entry.applied);
		return output(
			{
				count: applied.length,
				edited: applied,
				...(failed.length
					? { warning: `${failed.length} change(s) did not take effect.` }
					: {}),
			},
			true,
		);
	}
	if (command === "set-image") {
		const csv = positional[1];
		if (!csv)
			throw new Error("Usage: barnaloppan set-image updates.csv [--yes]");
		// Reuses the add CSV reader, so `photo` resolution and its aliases apply.
		// `name` here is only a label; the listing is addressed by `id`.
		const rows = await readImageUpdatesCsv(csv);
		const products = new Map(
			productsFromHtml(await getProductsHtml()).map((product) => [
				product.id,
				product,
			]),
		);
		const plan = rows.map((row) => {
			const product = products.get(row.id);
			if (!product)
				throw new Error(`No listing with ID ${row.id} in this booth.`);
			return { ...row, name: product.name, product };
		});
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: plan.length,
					wouldReplace: plan.map((entry) => ({
						id: entry.id,
						name: entry.name,
						photo: entry.photo,
					})),
				},
				true,
			);
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
		return output(
			{
				count: updates.length,
				replaced: plan.map((entry) => ({
					id: entry.id,
					name: entry.name,
					photo: entry.photo,
				})),
			},
			true,
		);
	}
	if (command === "hide" || command === "show") {
		const active = command === "show";
		const selectors = positional.slice(1);
		if (!selectors.length)
			throw new Error(
				`Usage: barnaloppan ${command} <id | name | photo> [more] [--all] [--yes]`,
			);
		const products = productsFromHtml(await getProductsHtml());
		const requestedIndex = value("--index");
		let index = new Map<string, number[]>();
		try {
			index = await loadPhotoIndex(requestedIndex ?? DEFAULT_INDEX_FILE);
		} catch (error) {
			// An explicitly requested index must exist; the default one need not.
			if (requestedIndex) throw error;
		}
		const selected = resolveSelectors(selectors, products, index, has("--all"));
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: selected.length,
					[active ? "wouldShow" : "wouldHide"]: selected,
				},
				true,
			);
		const message = await setProductsActive(
			selected.map((selection) => selection.id),
			active,
		);
		return output(
			{
				count: selected.length,
				[active ? "shown" : "hidden"]: selected,
				message,
			},
			true,
		);
	}
	if (command === "delete") {
		const ids = positional.slice(1).map(Number);
		if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1))
			throw new Error(
				"Usage: barnaloppan delete <product-id> [more IDs] [--yes]",
			);
		if (!has("--yes")) return output({ dryRun: true, wouldDelete: ids }, true);
		return output({ deleted: ids, message: await deleteProducts(ids) }, true);
	}
	throw new Error(`Unknown command: ${command}. Run "barnaloppan help".`);
}

try {
	await main();
} catch (error) {
	console.error(
		json
			? JSON.stringify({ error: (error as Error).message })
			: `Error: ${(error as Error).message}`,
	);
	process.exit(1);
}
