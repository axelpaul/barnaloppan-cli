#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { getProductsHtml, login } from "./lib/client.ts";
import { clearSession, loadSession, SESSION_PATH } from "./lib/config.ts";
import { credentialsFromEnv, ENV_PATH } from "./lib/credentials.ts";
import {
	readDetailUpdatesCsv,
	readImageUpdatesCsv,
	readProductsCsv,
} from "./lib/csv.ts";
import { credentialsFrom1Password } from "./lib/onepassword.ts";
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
} from "./lib/operations.ts";
import { isJsonMode, output } from "./lib/output.ts";
import { promptLine, promptSecret, readSecretFromStdin } from "./lib/prompt.ts";

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
const selectOptions = () => ({
	all: has("--all"),
	indexPath: value("--index"),
});
const json = isJsonMode({ json: has("--json"), pretty: has("--pretty") });

function help(): void {
	console.log(`barnaloppan - CLI for Barnaloppan booth inventory

Usage:
  barnaloppan auth login [--email you@example.com] [--booking-id ID]
  barnaloppan auth login --from-env | --from-1password [--booking-id ID]
  barnaloppan auth status [--check] | logout
  barnaloppan list [--json]
  barnaloppan sales
  barnaloppan serve                         # MCP server over stdio
  barnaloppan --version
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
${ENV_PATH}), else an interactive prompt.
--from-1password reads the item named by BARNALOPPAN_1PASSWORD_ITEM. A
password is never accepted as a command-line argument.
You log in once; the session cookie is reused by every later command.
"auth status --check" asks the site whether that cookie is still valid.
MCP writes are off unless BARNALOPPAN_MCP_ENABLE_WRITES=1 is set for "serve".`);
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
	if (has("--version") || has("-v") || command === "version")
		return console.log(packageJson.version);
	if (has("--help") || has("-h") || !command || command === "help")
		return help();
	if (command === "serve" || command === "mcp") {
		const { serve } = await import("./mcp/server.ts");
		return serve();
	}
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
	if (command === "list") return output(await listProducts(), true);
	if (command === "sales") return output(await salesReport(), true);
	if (command === "add") {
		const csv = positional[1];
		if (!csv) throw new Error("Usage: barnaloppan add products.csv [--yes]");
		const products = await readProductsCsv(csv);
		if (!has("--yes"))
			return output({ dryRun: true, count: products.length, products }, true);
		return output(
			await addProducts(products, { indexPath: value("--index") }),
			true,
		);
	}
	if (command === "unprint") {
		const selectors = positional.slice(1);
		if (!selectors.length)
			throw new Error(
				"Usage: barnaloppan unprint <id | name | photo> [more] [--all] [--yes]",
			);
		const selected = await selectProducts(selectors, selectOptions());
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: selected.length,
					wouldUnprint: selected,
					note: UNPRINT_NOTE,
				},
				true,
			);
		const message = await unprint(selected);
		return output(
			{ count: selected.length, unprinted: selected, message },
			true,
		);
	}
	if (command === "edit") {
		const csv = positional[1];
		if (!csv) throw new Error("Usage: barnaloppan edit updates.csv [--yes]");
		const plan = await planEdit(await readDetailUpdatesCsv(csv));
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: plan.length,
					wouldEdit: plan.map(({ id, from, to }) => ({ id, from, to })),
				},
				true,
			);
		return output(await applyEdit(plan), true);
	}
	if (command === "set-image") {
		const csv = positional[1];
		if (!csv)
			throw new Error("Usage: barnaloppan set-image updates.csv [--yes]");
		// Reuses the add CSV photo resolution, so `photo` aliases apply. The
		// listing is addressed by `id`.
		const plan = await planSetImage(await readImageUpdatesCsv(csv));
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: plan.length,
					wouldReplace: plan.map(({ id, name, photo }) => ({
						id,
						name,
						photo,
					})),
				},
				true,
			);
		return output(await applySetImage(plan), true);
	}
	if (command === "hide" || command === "show") {
		const active = command === "show";
		const selectors = positional.slice(1);
		if (!selectors.length)
			throw new Error(
				`Usage: barnaloppan ${command} <id | name | photo> [more] [--all] [--yes]`,
			);
		const selected = await selectProducts(selectors, selectOptions());
		if (!has("--yes"))
			return output(
				{
					dryRun: true,
					count: selected.length,
					[active ? "wouldShow" : "wouldHide"]: selected,
				},
				true,
			);
		const message = await setActive(selected, active);
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
