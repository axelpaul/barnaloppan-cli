import { expect, test } from "bun:test";
import { normalizeDetailUpdates, normalizeProduct, parseCsv } from "./csv.ts";
import { productsFromHtml } from "./products.ts";
import { resolveSelectors } from "./select.ts";

test("parseCsv handles quotes and CRLF", () => {
	expect(parseCsv('name,price\r\n"Peysa, blá",1500\r\n')).toEqual([
		["name", "price"],
		["Peysa, blá", "1500"],
	]);
});

test("normalizeProduct enforces the site's limits", async () => {
	expect(
		await normalizeProduct({ name: "Flíspeysa", price: "1 500" }, "x"),
	).toEqual({ name: "Flíspeysa", price: 1500, active: true, photo: undefined });
	await expect(
		normalizeProduct({ name: "a".repeat(25), price: 1 }, "x"),
	).rejects.toThrow("at most 24");
	await expect(normalizeProduct({ name: "a", price: 0 }, "x")).rejects.toThrow(
		"positive whole number",
	);
});

test("normalizeDetailUpdates needs a change and unique IDs", () => {
	expect(normalizeDetailUpdates([{ id: 12345, price: 900 }], String)).toEqual([
		{ id: 12345, price: 900 },
	]);
	expect(() => normalizeDetailUpdates([{ id: 12345 }], String)).toThrow(
		"needs a new name or a new price",
	);
	expect(() =>
		normalizeDetailUpdates(
			[
				{ id: 1, name: "a" },
				{ id: 1, name: "b" },
			],
			String,
		),
	).toThrow("more than once");
});

test("productsFromHtml reads editable and live markup", () => {
	const html = `
<div class="product" data-status="pending"><input name="product_id" value="11"><input name="name" value="Peysa &amp; húfa"><input name="price" value="1.500"><input type="checkbox" name="active" checked></div>
<div class="product" data-status="active" data-sold="1"><input name="product_id" value="12"><span class="name-span">Stígvél</span><span class="cost-span">900 kr.</span><input type="checkbox" name="active"></div>`;
	expect(productsFromHtml(html)).toEqual([
		{
			id: 11,
			name: "Peysa & húfa",
			price: 1500,
			status: "pending",
			active: true,
		},
		{
			id: 12,
			name: "Stígvél",
			price: 900,
			status: "active",
			active: false,
			sold: true,
		},
	]);
});

test("resolveSelectors refuses ambiguous matches without all", () => {
	const products = [
		{ id: 1, name: "Svefnpoki lítill" },
		{ id: 2, name: "Svefnpoki stór" },
	];
	expect(() =>
		resolveSelectors(["svefnpoki"], products, new Map(), false),
	).toThrow("matches 2 listings");
	expect(
		resolveSelectors(["svefnpoki"], products, new Map(), true).map((s) => s.id),
	).toEqual([1, 2]);
});
