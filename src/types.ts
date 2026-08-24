export type Session = {
	cookie: string;
	bookingId: number;
};

export type Product = {
	id: number;
	name: string;
	price?: number;
	status?: string;
	active?: boolean;
	webshop?: string;
	sold?: boolean;
};

export type CsvProduct = {
	name: string;
	price: number;
	active: boolean;
	photo?: string;
};
