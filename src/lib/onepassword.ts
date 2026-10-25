// Optional, off by default: used only with `auth login --from-1password`.
// The item (and optionally vault) must be named in the environment; nothing
// about anyone's 1Password layout is assumed here.
export async function credentialsFrom1Password(): Promise<{
	email: string;
	password: string;
}> {
	const itemName = Bun.env.BARNALOPPAN_1PASSWORD_ITEM?.trim();
	if (!itemName)
		throw new Error(
			"--from-1password needs BARNALOPPAN_1PASSWORD_ITEM set to the name or ID of your 1Password item (optionally BARNALOPPAN_1PASSWORD_VAULT too).",
		);
	const op = Bun.which("op");
	if (!op)
		throw new Error("1Password CLI (op) is not installed or not on PATH.");
	const vault = Bun.env.BARNALOPPAN_1PASSWORD_VAULT;
	const args = [op, "item", "get", itemName, "--format", "json"];
	if (vault) args.push("--vault", vault);
	const child = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
		env: Bun.env,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`Could not read the Barnaloppan credentials from 1Password: ${stderr.trim() || `exit ${code}`}`,
		);
	const item = JSON.parse(stdout) as {
		fields?: Array<{ label?: string; value?: string }>;
	};
	const fields = new Map(
		(item.fields ?? []).map((field) => [
			field.label?.toLowerCase(),
			field.value,
		]),
	);
	const email = fields.get("email") || fields.get("username");
	const password = fields.get("password");
	if (!email || !password)
		throw new Error(
			"The 1Password item needs email/username and password fields.",
		);
	return { email, password };
}
