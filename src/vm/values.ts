// GML values: reals, strings, arrays and undefined. Booleans are reals (true = 1).

/** GMS1 arrays are 2D; the compiler flattens [i, j] to i * 32000 + j. */
export const ARRAY_ROW = 32000;

export class GMArray {
	readonly rows: Value[][] = [];

	get(index: number): Value {
		const row = this.rows[Math.floor(index / ARRAY_ROW)];
		return row ? row[index % ARRAY_ROW] : undefined;
	}

	set(index: number, value: Value): void {
		const r = Math.floor(index / ARRAY_ROW);
		(this.rows[r] ??= [])[index % ARRAY_ROW] = value;
	}

	/** Arrays are copied on write when shared, so assignment copies. */
	clone(): GMArray {
		const copy = new GMArray();
		this.rows.forEach((row, i) => {
			if (row) copy.rows[i] = row.slice();
		});
		return copy;
	}
}

export type Value = number | string | GMArray | undefined;

/** GML's notion of true: a real above 0.5. */
export function truthy(v: Value): boolean {
	return typeof v === 'number' ? v > 0.5 : false;
}

export function toNumber(v: Value): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'string') {
		const n = Number(v.trim());
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

export function toInt(v: Value): number {
	return Math.trunc(toNumber(v));
}

/** GML's string(): integers without decimals, other reals with two. */
export function gmString(v: Value): string {
	if (typeof v === 'string') return v;
	if (typeof v === 'number') {
		if (Number.isInteger(v)) return String(v);
		if (!Number.isFinite(v)) return v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
		return v.toFixed(2);
	}
	if (v instanceof GMArray) return 'array';
	return 'undefined';
}

const EPSILON = 0.00001;

/** Three-way comparison with GML's epsilon for reals. */
export function compare(a: Value, b: Value): number {
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	if (typeof a === 'string' || typeof b === 'string') return typeof a === 'string' ? 1 : -1;
	const x = toNumber(a);
	const y = toNumber(b);
	if (Math.abs(x - y) < EPSILON) return 0;
	return x < y ? -1 : 1;
}

/** round() rounds halves to even, like the C runtime GameMaker uses. */
export function roundHalfEven(x: number): number {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
