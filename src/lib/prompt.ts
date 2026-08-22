import { Buffer } from "node:buffer";
import { createInterface } from "node:readline/promises";

const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const RETURN = 13;
const NEWLINE = 10;
const DELETE = 127;
const FIRST_PRINTABLE = 32;

function decode(bytes: number[]): string {
	return new TextDecoder().decode(new Uint8Array(bytes));
}

// Backspace has to erase a whole character, not a byte, or a password
// containing å/ä/ö is silently corrupted mid-edit.
function dropLastCharacter(bytes: number[]): void {
	while (bytes.length) {
		const byte = bytes.pop();
		if (byte === undefined || byte < 0x80 || byte >= 0xc0) return;
	}
}

function stty(
	args: string[],
	capture = false,
): { exitCode: number; stdout: string } {
	const child = Bun.spawnSync(["stty", ...args], {
		stdin: "inherit",
		stdout: capture ? "pipe" : "ignore",
		stderr: "ignore",
	});
	return {
		exitCode: child.exitCode ?? 1,
		stdout: capture ? (child.stdout?.toString().trim() ?? "") : "",
	};
}

// Bun 1.4's process.stdin.setRawMode() flips its own isRaw flag without
// actually changing the terminal, so the password stays echoed on screen.
// Drive termios through stty instead, and always put it back.
function withEchoDisabled(): () => void {
	const saved = stty(["-g"], true);
	if (saved.exitCode !== 0 || !saved.stdout)
		throw new Error(
			"Could not turn off terminal echo, so the password would be visible while typing. Pipe it in with --password-stdin instead.",
		);
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		process.off("exit", restore);
		process.off("SIGTERM", restore);
		process.off("SIGHUP", restore);
		stty([saved.stdout]);
	};
	// -isig so Ctrl-C arrives as a byte we can handle and restore from,
	// rather than killing the process with echo still switched off.
	if (
		stty(["-echo", "-icanon", "-isig", "min", "1", "time", "0"]).exitCode !== 0
	) {
		restore();
		throw new Error(
			"Could not turn off terminal echo, so the password would be visible while typing. Pipe it in with --password-stdin instead.",
		);
	}
	process.once("exit", restore);
	process.once("SIGTERM", restore);
	process.once("SIGHUP", restore);
	return restore;
}

export async function promptLine(question: string): Promise<string> {
	if (!process.stdin.isTTY)
		throw new Error(
			`Cannot prompt for "${question.trim()}" because stdin is not a terminal.`,
		);
	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		return (await readline.question(question)).trim();
	} finally {
		readline.close();
	}
}

export async function readSecretFromStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
	return Buffer.concat(chunks)
		.toString("utf8")
		.replace(/\r?\n$/, "");
}

export async function promptSecret(question: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY)
		throw new Error(
			"Cannot prompt for a password because stdin is not a terminal. Pipe it in with --password-stdin instead.",
		);
	const bytes: number[] = [];
	let onData: ((chunk: Buffer) => void) | undefined;
	const restore = withEchoDisabled();
	process.stdout.write(question);
	stdin.resume();
	try {
		return await new Promise<string>((resolve, reject) => {
			const settle = (finish: () => void) => {
				if (onData) stdin.off("data", onData);
				process.stdout.write("\n");
				finish();
			};
			onData = (chunk: Buffer) => {
				for (const byte of chunk) {
					if (byte === RETURN || byte === NEWLINE)
						return settle(() => resolve(decode(bytes)));
					if (byte === CTRL_C || byte === CTRL_D)
						return settle(() => reject(new Error("Login cancelled.")));
					if (byte === DELETE || byte === BACKSPACE) {
						dropLastCharacter(bytes);
						continue;
					}
					if (byte < FIRST_PRINTABLE) continue;
					bytes.push(byte);
				}
			};
			stdin.on("data", onData);
		});
	} finally {
		bytes.length = 0;
		restore();
		stdin.pause();
	}
}
