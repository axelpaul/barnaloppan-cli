#!/usr/bin/env bun

import {
	deleteProducts,
	getProductsHtml,
	login,
	saveProducts,
	uploadImage,
} from "./lib/client.ts";
import { clearSession, loadSession, SESSION_PATH } from "./lib/config.ts";
import { credentialsFromEnv, ENV_PATH } from "./lib/credentials.ts";
import { readProductsCsv } from "./lib/csv.ts";
import { credentialsFrom1Password } from "./lib/onepassword.ts";
import { isJsonMode, output } from "./lib/output.ts";
import { promptLine, promptSecret, readSecretFromStdin } from "./lib/prompt.ts";
import type { Product } from "./types.ts";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--booking-id", "--email"]);
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
  barnaloppan add products.csv [--yes]
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

function productsFromHtml(html: string): Product[] {
	const products: Product[] = [];
	for (const match of html.matchAll(
		/<div[^>]*class="[^"]*\bproduct\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bproduct\b|$)/gi,
	)) {
		const block = match[0];
		const id = Number(/name="product_id"[^>]*value="(\d+)"/i.exec(block)?.[1]);
		const name = /name="name"[^>]*value="([^"]*)"/i.exec(block)?.[1];
		if (!id || name === undefined) continue;
		const price = Number(/name="price"[^>]*value="(\d+)"/i.exec(block)?.[1]);
		const status = /data-status="([^"]+)"/i.exec(block)?.[1];
		products.push({
			id,
			name: name.replaceAll("&amp;", "&"),
			...(Number.isFinite(price) && price ? { price } : {}),
			...(status ? { status } : {}),
		});
	}
	return products;
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
				? await uploadImage(product.photo, tempId)
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
		return output(
			{
				count: products.length,
				created: created.length,
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
