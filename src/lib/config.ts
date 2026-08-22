import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "../types.ts";

export const CONFIG_DIR = join(homedir(), ".config", "barnaloppan");
export const SESSION_PATH = join(CONFIG_DIR, "session.json");

export async function loadSession(): Promise<Session> {
	try {
		const session = JSON.parse(await readFile(SESSION_PATH, "utf8")) as {
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

export async function clearSession(): Promise<boolean> {
	try {
		await rm(SESSION_PATH);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
