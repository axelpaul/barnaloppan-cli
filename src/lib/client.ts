import { readFile } from "node:fs/promises";
import { loadSession, saveSession } from "./config.ts";

const ORIGIN = "https://www.barnaloppan.is";
const PRODUCTS = `${ORIGIN}/customer/boerneloppen-theme/products`;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
type CookieMap = Map<string, string>;

function cookieMap(cookie = ""): CookieMap {
	return new Map(
		cookie
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const separator = part.indexOf("=");
				return separator === -1
					? [part, ""]
					: [part.slice(0, separator), part.slice(separator + 1)];
			}),
	);
}

function cookieHeader(cookies: CookieMap): string {
	return [...cookies.entries()]
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function mergeSetCookies(cookies: CookieMap, response: Response): void {
	const setCookies =
		typeof response.headers.getSetCookie === "function"
			? response.headers.getSetCookie()
			: [response.headers.get("set-cookie") ?? ""];
	for (const header of setCookies) {
		const pair = header.split(";", 1)[0]?.trim();
		if (!pair) continue;
		const separator = pair.indexOf("=");
		if (separator > 0)
			cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
	}
}

async function checked(response: Response, context: string): Promise<Response> {
	if (response.ok) return response;
	if (response.status === 401 || response.status === 403)
		throw new Error(
			'Barnaloppan session expired. Run "barnaloppan auth login".',
		);
	throw new Error(`${context} failed: HTTP ${response.status}`);
}

function browserHeaders(
	cookie: string,
	xhr = true,
	referer = `${ORIGIN}/barnaloppan-min/bas`,
): HeadersInit {
	return {
		Cookie: cookie,
		"User-Agent": USER_AGENT,
		Accept: "*/*",
		"Accept-Language": "en-GB,en;q=0.9,is-IS;q=0.8,is;q=0.7,en-US;q=0.6",
		Referer: referer,
		Origin: ORIGIN,
		...(xhr
			? {
					"X-Requested-With": "XMLHttpRequest",
					"Sec-Fetch-Dest": "empty",
					"Sec-Fetch-Mode": "cors",
					"Sec-Fetch-Site": "same-origin",
				}
			: {}),
	};
}

export async function login(
	email: string,
	password: string,
	bookingId?: number,
): Promise<number> {
	const cookies = cookieMap();
	const loginUrl = `${ORIGIN}/users/login`;
	let response = await fetch(loginUrl, {
		headers: { "User-Agent": USER_AGENT },
		redirect: "manual",
	});
	mergeSetCookies(cookies, response);
	await checked(response, "Barnaloppan login page");
	response = await fetch(loginUrl, {
		method: "POST",
		redirect: "manual",
		headers: {
			"User-Agent": USER_AGENT,
			Referer: loginUrl,
			"Content-Type": "application/x-www-form-urlencoded",
			Cookie: cookieHeader(cookies),
		},
		body: new URLSearchParams({ email, password }),
	});
	mergeSetCookies(cookies, response);
	if (![301, 302, 303].includes(response.status))
		throw new Error("Barnaloppan rejected the login.");
	const location = response.headers.get("location");
	if (
		!location ||
		!new URL(location, ORIGIN).pathname.endsWith("/barnaloppan-min")
	)
		throw new Error("Barnaloppan rejected the login.");
	response = await fetch(new URL(location, ORIGIN), {
		headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(cookies) },
		redirect: "manual",
	});
	mergeSetCookies(cookies, response);
	await checked(response, "Barnaloppan login redirect");
	response = await fetch(`${ORIGIN}/barnaloppan-min/bas`, {
		headers: {
			"User-Agent": USER_AGENT,
			Referer: `${ORIGIN}/barnaloppan-min`,
			Cookie: cookieHeader(cookies),
		},
	});
	mergeSetCookies(cookies, response);
	await checked(response, "Barnaloppan booth setup");
	const boothHtml = await response.text();
	const detectedBookingId = Number(
		/data-booking-id="(\d+)"/i.exec(boothHtml)?.[1],
	);
	const resolvedBookingId = bookingId ?? detectedBookingId;
	if (!Number.isInteger(resolvedBookingId))
		throw new Error(
			"Could not determine the active booth. Run login again with --booking-id <id>.",
		);
	await saveSession({
		cookie: cookieHeader(cookies),
		bookingId: resolvedBookingId,
	});
	return resolvedBookingId;
}

export async function getProductsHtml(): Promise<string> {
	const session = await loadSession();
	const response = await checked(
		await fetch(
			`${PRODUCTS}/getProductsForBooth?booking_id=${session.bookingId}`,
			{ headers: browserHeaders(session.cookie) },
		),
		"Barnaloppan product list",
	);
	return response.text();
}

// The site names the temp upload `<userId>-<temp_id>.jpg`. Without a temp_id
// every upload in a batch lands on the same path and overwrites the last, so
// only one product ends up with a real image file. The temp_id must match the
// one used for this product in the saveBooking payload.
// The sales/payout view. Returns an HTML table, not JSON.
export async function getPayoutHtml(): Promise<string> {
	const session = await loadSession();
	const response = await checked(
		await fetch(
			`${PRODUCTS}/getProductsForPayout?booking_id=${session.bookingId}`,
			{
				headers: browserHeaders(
					session.cookie,
					true,
					`${ORIGIN}/barnaloppan-min/sala`,
				),
			},
		),
		"Barnaloppan sales",
	);
	return response.text();
}

export async function uploadImage(
	path: string,
	owner: { tempId: string } | { productId: number },
): Promise<string> {
	const bytes = await readFile(path);
	const type = path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
	const form = new FormData();
	if ("tempId" in owner) form.set("temp_id", owner.tempId);
	else form.set("product_id", String(owner.productId));
	form.set(
		"image",
		new File([bytes], path.split("/").pop() || "image.jpg", { type }),
	);
	const session = await loadSession();
	const response = await checked(
		await fetch(`${PRODUCTS}/uploadImage`, {
			method: "POST",
			headers: browserHeaders(session.cookie),
			body: form,
		}),
		"Barnaloppan image upload",
	);
	const result = (await response.json()) as { image?: unknown };
	if (typeof result.image !== "string" || !result.image)
		throw new Error("Barnaloppan image upload returned no image path.");
	return result.image;
}

export async function saveProducts(products: unknown[]): Promise<number[]> {
	const session = await loadSession();
	const response = await checked(
		await fetch(`${PRODUCTS}/saveBooking.json`, {
			method: "POST",
			headers: {
				...browserHeaders(session.cookie),
				"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			},
			body: new URLSearchParams({
				json: JSON.stringify({ booking_id: session.bookingId, products }),
			}),
		}),
		"Barnaloppan product save",
	);
	const result = (await response.json()) as {
		status?: unknown;
		message?: unknown;
		newProductIds?: unknown;
	};
	if (result.status !== "success")
		throw new Error(
			`Barnaloppan did not save products: ${typeof result.message === "string" ? result.message : "unknown error"}`,
		);
	return Array.isArray(result.newProductIds)
		? result.newProductIds.map(Number)
		: [];
}

// delete.json, active.json and inactive.json all take the same body.
async function productIdsRequest(
	path: string,
	productIds: number[],
	context: string,
): Promise<string | undefined> {
	const session = await loadSession();
	const body = new URLSearchParams({ booking_id: String(session.bookingId) });
	for (const id of productIds) body.append("product_ids[]", String(id));
	const response = await checked(
		await fetch(`${PRODUCTS}/${path}`, {
			method: "POST",
			headers: {
				...browserHeaders(session.cookie),
				"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			},
			body,
		}),
		context,
	);
	const result = (await response.json()) as {
		status?: unknown;
		message?: unknown;
	};
	if (result.status !== "success")
		throw new Error(
			`${context} was refused: ${typeof result.message === "string" ? result.message : "unknown error"}`,
		);
	return typeof result.message === "string" ? result.message : undefined;
}

export function deleteProducts(
	productIds: number[],
): Promise<string | undefined> {
	return productIdsRequest("delete.json", productIds, "Barnaloppan delete");
}

// Marks price tags as not printed, which is what returns a listing to an
// editable state: the site refuses name and price changes while a tag is
// printed, because the printed tag carries both.
export function unprintProducts(
	productIds: number[],
): Promise<string | undefined> {
	return productIdsRequest("unPrint.json", productIds, "Barnaloppan unprint");
}

// The site calls this "søgning": an inactive product stays in the booth but is
// hidden from search. The site refuses to deactivate a webshop product.
export function setProductsActive(
	productIds: number[],
	active: boolean,
): Promise<string | undefined> {
	return productIdsRequest(
		active ? "active.json" : "inactive.json",
		productIds,
		active ? "Barnaloppan show" : "Barnaloppan hide",
	);
}

export type ImageUpdate = {
	productId: number;
	image: string;
	active: boolean;
	webshop: string;
};

// Replaces the photo on products that already exist. The payload deliberately
// carries no name or price: the site leaves any field it is not sent alone,
// which is why this works on listings the site has locked for editing.
export async function updateProductImages(
	updates: ImageUpdate[],
): Promise<number[]> {
	return saveProducts(
		updates.map((update, order) => ({
			product_id: String(update.productId),
			_delete: "0",
			webshop: update.webshop,
			image: update.image,
			newImage: "1",
			deleteImage: "0",
			image_2: "",
			newImage2: "0",
			deleteImage2: "0",
			imageUpload: null,
			active: update.active,
			order,
		})),
	);
}

export type DetailUpdate = {
	productId: number;
	name: string;
	price: number;
	image: string;
	active: boolean;
	webshop: string;
};

// Name and price are always sent together, using the listing's current value
// for whichever is not being changed, so a partial edit cannot blank a field.
// The existing image is echoed back with newImage 0 so the photo is untouched.
export async function updateProductDetails(
	updates: DetailUpdate[],
): Promise<number[]> {
	return saveProducts(
		updates.map((update, order) => ({
			product_id: String(update.productId),
			_delete: "0",
			webshop: update.webshop,
			image: update.image,
			newImage: "0",
			deleteImage: "0",
			image_2: "",
			newImage2: "0",
			deleteImage2: "0",
			imageUpload: null,
			name: update.name,
			price: String(update.price),
			active: update.active,
			order,
		})),
	);
}
