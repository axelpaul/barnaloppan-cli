import type { Product } from "../types.ts";

// Named entities first, then &amp;, so &amp;lt; does not decode twice.
export function decodeEntities(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}

// While a booth is editable the site renders name and price as form inputs.
// Once the products go live it renders them as spans instead, so both shapes
// must be read or `list` silently returns an empty booth.
export function productsFromHtml(html: string): Product[] {
	const products: Product[] = [];
	for (const match of html.matchAll(
		/<div[^>]*class="[^"]*\bproduct\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bproduct\b|$)/gi,
	)) {
		const block = match[0];
		const id = Number(/name="product_id"[^>]*value="(\d+)"/i.exec(block)?.[1]);
		const name =
			/name="name"[^>]*value="([^"]*)"/i.exec(block)?.[1] ??
			/<span[^>]*class="[^"]*\bname-span\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
				.exec(block)?.[1]
				?.trim();
		if (!id || name === undefined) continue;
		const priceText =
			/name="price"[^>]*value="([^"]*)"/i.exec(block)?.[1] ??
			/<span[^>]*class="[^"]*\bcost-span\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
				block,
			)?.[1];
		const price = Number(priceText?.replace(/\D/g, ""));
		const status = /data-status="([^"]+)"/i.exec(block)?.[1];
		// Attribute order varies, so test the whole tag for `checked`.
		const activeInput = /<input[^>]*name="active"[^>]*>/i.exec(block)?.[0];
		const webshop = /name="webshop"[^>]*value="([^"]*)"/i.exec(block)?.[1];
		products.push({
			id,
			name: decodeEntities(name),
			...(Number.isFinite(price) && price ? { price } : {}),
			...(status ? { status } : {}),
			...(activeInput ? { active: /\bchecked\b/i.test(activeInput) } : {}),
			...(webshop === undefined ? {} : { webshop }),
		});
	}
	return products;
}
