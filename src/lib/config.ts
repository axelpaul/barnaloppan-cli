import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "../types.ts";

// BARNALOPPAN_CONFIG_DIR wins, then $XDG_CONFIG_HOME/barnaloppan-cli, then
// ~/.config/barnaloppan-cli.
export const CONFIG_DIR =
	Bun.env.BARNALOPPAN_CONFIG_DIR ||
	join(
		Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
		"barnaloppan-cli",
	);
// Versions before 0.2 used ~/.config/barnaloppan. It is still read, so an
// existing login keeps working, but nothing new is written there.
export const LEGACY_CONFIG_DIR = Bun.env.BARNALOPPAN_CONFIG_DIR
	? undefined
	: join(homedir(), ".config", "barnaloppan");
export const SESSION_PATH = join(CONFIG_DIR, "session.json");
const LEGACY_SESSION_PATH = LEGACY_CONFIG_DIR
	? join(LEGACY_CONFIG_DIR, "session.json")
	: undefined;

async function readSessionFile(): Promise<string> {
	try {
		return await readFile(SESSION_PATH, "utf8");
	} catch (error) {
		if (!LEGACY_SESSION_PATH) throw error;
		return readFile(LEGACY_SESSION_PATH, "utf8");
	}
}

export async function loadSession(): Promise<Session> {
	try {
		const session = JSON.parse(await readSessionFile()) as {
			cookie?: unknown;
			booking_id?: unknown;
			bookingId?: unknown;
		};
		const bookingId = Number(session.bookingId ?? session.booking_id);
		if (
			typeof session.cookie !== "string" ||
			!session.cookie ||
			!Number.isInteger(bookingId)
		)
			throw new Error("invalid session");
		return { cookie: session.cookie, bookingId };
	} catch {
		throw new Error('Not authenticated. Run "barnaloppan auth login" first.');
	}
}

export async function saveSession(session: Session): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
	await chmod(CONFIG_DIR, 0o700);
	await writeFile(SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`, {
		mode: 0o600,
	});
	await chmod(SESSION_PATH, 0o600);
}

async function removeIfPresent(path: string): Promise<boolean> {
	try {
		await rm(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function clearSession(): Promise<boolean> {
	const current = await removeIfPresent(SESSION_PATH);
	const legacy = LEGACY_SESSION_PATH
		? await removeIfPresent(LEGACY_SESSION_PATH)
		: false;
	return current || legacy;
}
