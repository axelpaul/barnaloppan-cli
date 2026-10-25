import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, LEGACY_CONFIG_DIR } from "./config.ts";

// Bun auto-loads ./.env, but only relative to the current directory, so a
// project .env goes unseen when the CLI runs from anywhere else. This file is
// the directory-independent fallback.
export const ENV_PATH = join(CONFIG_DIR, ".env");
const LEGACY_ENV_PATH = LEGACY_CONFIG_DIR
	? join(LEGACY_CONFIG_DIR, ".env")
	: undefined;

export type PartialCredentials = { email?: string; password?: string };

function unquote(value: string): string {
	const quote = value.charAt(0);
	if (
		(quote === '"' || quote === "'") &&
		value.endsWith(quote) &&
		value.length > 1
	)
		return value.slice(1, -1);
	return value;
}

// Deliberately does not strip trailing `# comments`: a password may contain a
// hash. Wrap a value in quotes to keep surrounding whitespace.
function parseEnv(source: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const body = line.startsWith("export ") ? line.slice(7).trim() : line;
		const separator = body.indexOf("=");
		if (separator <= 0) continue;
		values.set(
			body.slice(0, separator).trim(),
			unquote(body.slice(separator + 1).trim()),
		);
	}
	return values;
}

async function warnIfReadableByOthers(path: string): Promise<void> {
	try {
		const info = await stat(path);
		if (info.mode & 0o077)
			console.error(
				`Warning: ${path} holds your password and is readable by other users on this machine. Run: chmod 600 ${path}`,
			);
	} catch {
		// Missing or unreadable: nothing to warn about.
	}
}

function present(values: {
	email?: string;
	password?: string;
}): PartialCredentials {
	return {
		...(values.email ? { email: values.email.trim() } : {}),
		...(values.password ? { password: values.password } : {}),
	};
}

async function credentialsFromEnvFile(): Promise<
	PartialCredentials & { path?: string }
> {
	let source: string | undefined;
	let path: string | undefined;
	for (const candidate of [ENV_PATH, LEGACY_ENV_PATH]) {
		if (!candidate) continue;
		try {
			source = await readFile(candidate, "utf8");
			path = candidate;
			break;
		} catch {
			// Try the next location.
		}
	}
	if (source === undefined) return {};
	const values = parseEnv(source);
	return {
		...present({
			email: values.get("BARNALOPPAN_EMAIL"),
			password: values.get("BARNALOPPAN_PASSWORD"),
		}),
		path,
	};
}

export async function credentialsFromEnv(): Promise<PartialCredentials> {
	// Covers both a real exported variable and Bun's auto-loaded ./.env.
	const fromProcess = present({
		email: Bun.env.BARNALOPPAN_EMAIL,
		password: Bun.env.BARNALOPPAN_PASSWORD,
	});
	if (fromProcess.password)
		await warnIfReadableByOthers(join(process.cwd(), ".env"));
	if (fromProcess.email && fromProcess.password) return fromProcess;
	const { path, ...fromFile } = await credentialsFromEnvFile();
	if (path && fromFile.password && !fromProcess.password)
		await warnIfReadableByOthers(path);
	// Per field, an explicit environment variable beats the file.
	return { ...fromFile, ...fromProcess };
}
