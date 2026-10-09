import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPayoutHtml, getProductsHtml } from "../lib/client.ts";
import { productsFromHtml } from "../lib/products.ts";
import { salesFromHtml } from "../lib/sales.ts";

const server = new McpServer({ name: "barnaloppan", version: "0.1.0" });
const result = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const error = (value: unknown) => ({
	isError: true,
	content: [
		{
			type: "text" as const,
			text:
				value instanceof Error ? value.message : "Barnaloppan lookup failed.",
		},
	],
});

server.registerTool(
	"products",
	{
		description: "Read the signed-in booth inventory. No product changes.",
		inputSchema: {},
	},
	async () => {
		try {
			const products = productsFromHtml(await getProductsHtml());
			return result({
				count: products.length,
				products: products.slice(0, 100),
				truncated: products.length > 100,
			});
		} catch (e) {
			return error(e);
		}
	},
);

server.registerTool(
	"sales",
	{
		description:
			"Read signed-in booth payout/sales records. No product changes.",
		inputSchema: {},
	},
	async () => {
		try {
			const report = salesFromHtml(await getPayoutHtml());
			return result({
				...report,
				sales: report.sales.slice(0, 100),
				truncated: report.sales.length > 100,
			});
		} catch (e) {
			return error(e);
		}
	},
);

export async function serve(): Promise<void> {
	await server.connect(new StdioServerTransport());
}
