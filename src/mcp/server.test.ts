import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Barnaloppan MCP exposes read-only inventory and sales", async () => {
	const client = new Client({ name: "barnaloppan-test", version: "0.1.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: ["src/index.ts", "serve"],
				cwd: process.cwd(),
				stderr: "pipe",
			}),
		);
		expect(
			(await client.listTools()).tools.map((tool) => tool.name).sort(),
		).toEqual(["products", "sales"]);
	} finally {
		await client.close();
	}
});
