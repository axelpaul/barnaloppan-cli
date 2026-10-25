import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { getProductsHtml } from "../lib/client.ts";
import { loadSession, SESSION_PATH } from "../lib/config.ts";
import {
	normalizeDetailUpdates,
	normalizeImageUpdates,
	normalizeProduct,
} from "../lib/csv.ts";
import {
	addProducts,
	applyEdit,
	applySetImage,
	deleteProducts,
	listProducts,
	planEdit,
	planSetImage,
	salesReport,
	selectProducts,
	setActive,
	UNPRINT_NOTE,
	unprint,
	validateProductIds,
} from "../lib/operations.ts";

export const WRITES_ENV = "BARNALOPPAN_MCP_ENABLE_WRITES";

export function writesEnabled(env: Record<string, string | undefined>) {
	return env[WRITES_ENV] === "1";
}

const result = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const failure = (value: unknown) => ({
	isError: true,
	content: [
		{
			type: "text" as const,
			text:
				value instanceof Error ? value.message : "Barnaloppan request failed.",
		},
	],
});

async function run(work: () => Promise<unknown>) {
	try {
		return result(await work());
	} catch (e) {
		return failure(e);
	}
}

const page = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.optional()
		.describe("Maximum rows to return (default 100)."),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Rows to skip before returning (default 0)."),
};

function paged<T>(rows: T[], limit = 100, offset = 0) {
	return {
		rows: rows.slice(offset, offset + limit),
		offset,
		truncated: rows.length > offset + limit,
	};
}

const confirm = z
	.boolean()
	.optional()
	.describe(
		"Must be true to perform the change. Omitted or false returns a dry-run preview and changes nothing.",
	);

const selection = {
	selectors: z
		.array(z.string().min(1))
		.min(1)
		.describe(
			"Product IDs, product names (exact, then case-insensitive substring), or photo names resolved through the local photo index.",
		),
	all: z
		.boolean()
		.optional()
		.describe(
			"Take every match when a selector matches several listings. Without it an ambiguous selector is refused.",
		),
	index_path: z
		.string()
		.optional()
		.describe(
			"Photo index CSV (id + photo columns). Defaults to inventory.csv in the server's working directory, if present.",
		),
};

export function createServer(
	env: Record<string, string | undefined> = Bun.env,
): McpServer {
	const server = new McpServer({
		name: "barnaloppan",
		version: packageJson.version,
	});

	server.registerTool(
		"list_products",
		{
			description:
				"List the listings in the signed-in Barnaloppan booth: id, name, price, status (pending = tag not printed, active = printed), active (false = hidden from search), webshop and sold flags. Read-only.",
			inputSchema: page,
			annotations: { readOnlyHint: true },
		},
		({ limit, offset }) =>
			run(async () => {
				const products = await listProducts();
				const { rows, ...rest } = paged(products, limit, offset);
				return { count: products.length, products: rows, ...rest };
			}),
	);

	server.registerTool(
		"get_sales",
		{
			description:
				"Read the booth's sales/payout view: each sale with timestamp and amount, plus soldTotal, commission, commissionRate, paidOut and balance (all ISK). Read-only.",
			inputSchema: page,
			annotations: { readOnlyHint: true },
		},
		({ limit, offset }) =>
			run(async () => {
				const report = await salesReport();
				const { rows, ...rest } = paged(report.sales, limit, offset);
				return { ...report, sales: rows, ...rest };
			}),
	);

	server.registerTool(
		"auth_status",
		{
			description:
				'Show the stored Barnaloppan session (booking ID, session file). With check=true, also ask the site whether the session cookie still works. Log in with "barnaloppan auth login" in a terminal. Read-only.',
			inputSchema: {
				check: z
					.boolean()
					.optional()
					.describe("Make a network call to confirm the session is live."),
			},
			annotations: { readOnlyHint: true },
		},
		({ check }) =>
			run(async () => {
				const session = await loadSession();
				const stored = {
					authenticated: true,
					bookingId: session.bookingId,
					sessionFile: SESSION_PATH,
				};
				if (!check) return stored;
				try {
					await getProductsHtml();
					return { ...stored, live: true };
				} catch (error) {
					return { ...stored, live: false, reason: (error as Error).message };
				}
			}),
	);

	if (!writesEnabled(env)) return server;

	server.registerTool(
		"add_products",
		{
			description:
				"Create new listings in the booth, uploading an optional local photo for each. Same rules as `barnaloppan add`: name 1-24 chars, price a positive whole number of kr. Without confirm=true returns a dry run.",
			inputSchema: {
				products: z
					.array(
						z.object({
							name: z.string().min(1).max(24),
							price: z.number().int().min(1).describe("Price in ISK."),
							active: z
								.boolean()
								.optional()
								.describe("Visible in search (default true)."),
							photo: z
								.string()
								.optional()
								.describe(
									"Local .jpg/.jpeg/.png path on the server's machine; the extension may be omitted.",
								),
						}),
					)
					.min(1),
				index_path: z
					.string()
					.optional()
					.describe(
						"Merge the new id-to-photo mappings into this local index CSV.",
					),
				confirm,
			},
			annotations: { destructiveHint: false },
		},
		({ products, index_path, confirm }) =>
			run(async () => {
				const normalized = [];
				for (const [position, product] of products.entries())
					normalized.push(
						await normalizeProduct(product, `products[${position}]`),
					);
				if (!confirm)
					return {
						dryRun: true,
						count: normalized.length,
						products: normalized,
					};
				return addProducts(normalized, { indexPath: index_path });
			}),
	);

	server.registerTool(
		"set_product_images",
		{
			description:
				"Replace the photo on existing listings, addressed by product ID. Works on printed listings too; hidden/webshop state is preserved. Without confirm=true returns a dry run.",
			inputSchema: {
				updates: z
					.array(
						z.object({
							id: z.number().int().min(1),
							photo: z
								.string()
								.min(1)
								.describe(
									"Local .jpg/.jpeg/.png path on the server's machine.",
								),
						}),
					)
					.min(1),
				confirm,
			},
		},
		({ updates, confirm }) =>
			run(async () => {
				const plan = await planSetImage(
					await normalizeImageUpdates(
						updates,
						(position) => `updates[${position}]`,
					),
				);
				if (!confirm)
					return {
						dryRun: true,
						count: plan.length,
						wouldReplace: plan.map(({ id, name, photo }) => ({
							id,
							name,
							photo,
						})),
					};
				return applySetImage(plan);
			}),
	);

	server.registerTool(
		"unprint_products",
		{
			description: `Mark listings' price tags as not printed, which unlocks name and price for edit_products. ${UNPRINT_NOTE} Without confirm=true returns a dry run.`,
			inputSchema: { ...selection, confirm },
			annotations: { destructiveHint: true },
		},
		({ selectors, all, index_path, confirm }) =>
			run(async () => {
				const selected = await selectProducts(selectors, {
					all,
					indexPath: index_path,
				});
				if (!confirm)
					return {
						dryRun: true,
						count: selected.length,
						wouldUnprint: selected,
						note: UNPRINT_NOTE,
					};
				return {
					count: selected.length,
					unprinted: selected,
					message: await unprint(selected),
				};
			}),
	);

	server.registerTool(
		"edit_products",
		{
			description:
				"Change name and/or price of listings by product ID. Refuses listings whose tag is still printed (unprint them first), and reads the booth back to report whether each change landed. Without confirm=true returns a dry run.",
			inputSchema: {
				updates: z
					.array(
						z.object({
							id: z.number().int().min(1),
							name: z.string().min(1).max(24).optional(),
							price: z.number().int().min(1).optional(),
						}),
					)
					.min(1),
				confirm,
			},
		},
		({ updates, confirm }) =>
			run(async () => {
				const plan = await planEdit(
					normalizeDetailUpdates(updates, (position) => `updates[${position}]`),
				);
				if (!confirm)
					return {
						dryRun: true,
						count: plan.length,
						wouldEdit: plan.map(({ id, from, to }) => ({ id, from, to })),
					};
				return applyEdit(plan);
			}),
	);

	for (const [name, active] of [
		["hide_products", false],
		["show_products", true],
	] as const)
		server.registerTool(
			name,
			{
				description: active
					? "Put hidden listings back in search. Reversible. Without confirm=true returns a dry run."
					: "Hide listings from search; they stay in the booth with the same ID and tag. Reversible with show_products. The site refuses to hide webshop listings. Without confirm=true returns a dry run.",
				inputSchema: { ...selection, confirm },
			},
			({ selectors, all, index_path, confirm }) =>
				run(async () => {
					const selected = await selectProducts(selectors, {
						all,
						indexPath: index_path,
					});
					if (!confirm)
						return {
							dryRun: true,
							count: selected.length,
							[active ? "wouldShow" : "wouldHide"]: selected,
						};
					return {
						count: selected.length,
						[active ? "shown" : "hidden"]: selected,
						message: await setActive(selected, active),
					};
				}),
		);

	server.registerTool(
		"delete_products",
		{
			description:
				"Permanently delete listings by explicit product ID. Cannot be undone; prefer hide_products. Without confirm=true returns a dry run.",
			inputSchema: {
				ids: z.array(z.number().int().min(1)).min(1),
				confirm,
			},
			annotations: { destructiveHint: true },
		},
		({ ids, confirm }) =>
			run(async () => {
				validateProductIds(ids);
				if (!confirm) return { dryRun: true, wouldDelete: ids };
				return { deleted: ids, message: await deleteProducts(ids) };
			}),
	);

	return server;
}

export async function serve(): Promise<void> {
	const server = createServer();
	await server.connect(new StdioServerTransport());
	console.error(
		`barnaloppan MCP server ${packageJson.version} on stdio (writes ${writesEnabled(Bun.env) ? "enabled" : "disabled"})`,
	);
}
