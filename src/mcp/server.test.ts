import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.ts";

const READ_TOOLS = ["auth_status", "get_sales", "list_products"];
const WRITE_TOOLS = [
	"add_products",
	"delete_products",
	"edit_products",
	"hide_products",
	"set_product_images",
	"show_products",
	"unprint_products",
];

async function connect(env: Record<string, string | undefined>) {
	const client = new Client({ name: "barnaloppan-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createServer(env).connect(serverSide);
	await client.connect(clientSide);
	return client;
}

const text = (response: unknown) =>
	(response as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("Barnaloppan MCP", () => {
	test("exposes only read tools by default", async () => {
		const client = await connect({});
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names.sort()).toEqual(READ_TOOLS);
		await client.close();
	});

	test("adds write tools with BARNALOPPAN_MCP_ENABLE_WRITES=1", async () => {
		const client = await connect({ BARNALOPPAN_MCP_ENABLE_WRITES: "1" });
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names.sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
		await client.close();
	});

	test("write tools dry-run without confirm", async () => {
		const client = await connect({ BARNALOPPAN_MCP_ENABLE_WRITES: "1" });
		const response = await client.callTool({
			name: "delete_products",
			arguments: { ids: [12345] },
		});
		expect(JSON.parse(text(response))).toEqual({
			dryRun: true,
			wouldDelete: [12345],
		});
		const add = await client.callTool({
			name: "add_products",
			arguments: { products: [{ name: "Flíspeysa", price: 1500 }] },
		});
		expect(JSON.parse(text(add))).toMatchObject({ dryRun: true, count: 1 });
		await client.close();
	});

	test("serve over stdio speaks only protocol on stdout", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "barnaloppan-test-"));
		const client = new Client({ name: "barnaloppan-test", version: "0.0.0" });
		try {
			await client.connect(
				new StdioClientTransport({
					command: process.execPath,
					args: ["src/index.ts", "serve"],
					cwd: process.cwd(),
					env: { ...process.env, BARNALOPPAN_CONFIG_DIR: configDir },
					stderr: "pipe",
				}),
			);
			const names = (await client.listTools()).tools.map((tool) => tool.name);
			expect(names.sort()).toEqual(READ_TOOLS);
			const status = await client.callTool({
				name: "auth_status",
				arguments: {},
			});
			expect(status.isError).toBe(true);
			expect(text(status)).toContain("Not authenticated");
		} finally {
			await client.close();
			await rm(configDir, { recursive: true, force: true });
		}
	});
});
