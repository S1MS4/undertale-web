import type { Font, Sprite, TexturePageItem } from '../data/DataWin.ts';
import type { Point } from '../render/Renderer.ts';
import { GameFiles } from './files.ts';
import { ALL, EV, type Game, NOONE, OTHER_EV } from './Game.ts';
import type { Instance } from './Instance.ts';
import type { Frame } from './Interpreter.ts';
import { gmString, roundHalfEven, toInt, toNumber, truthy, type Value } from './values.ts';

/** Functions with no result return nothing; the call then yields undefined, which the code discards. */
type Builtin = (g: Game, f: Frame, a: Value[]) => Value | void;

const n = toNumber;
const i = toInt;
const b = truthy;
const s = (v: Value): string => (typeof v === 'string' ? v : gmString(v));
const deg = Math.PI / 180;

// ---------------------------------------------------------------- text

function currentFont(g: Game): Font | undefined {
	return g.data.fontList[g.drawFont] ?? g.data.fontList[0];
}

/** GameMaker 1 treats # as a line break unless escaped as \#. */
function splitLines(text: string): string[] {
	return text
		.replace(/\r\n/g, '\n')
		.split(/(?<!\\)#|\n/)
		.map((line) => line.replace(/\\#/g, '#'));
}

function lineHeight(font: Font): number {
	return font.glyphs.get(77)?.height ?? font.lineHeight; // 'M'
}

function lineWidth(font: Font, line: string): number {
	let w = 0;
	for (const ch of line) w += font.glyphs.get(ch.codePointAt(0) ?? 0)?.shift ?? Math.ceil(font.size / 2);
	return w;
}

function wrap(font: Font, lines: string[], width: number): string[] {
	if (width < 0) return lines;
	const out: string[] = [];
	for (const line of lines) {
		let current = '';
		for (const word of line.split(' ')) {
			const candidate = current ? `${current} ${word}` : word;
			if (current && lineWidth(font, candidate) > width) {
				out.push(current);
				current = word;
			} else {
				current = candidate;
			}
		}
		out.push(current);
	}
	return out;
}

function drawText(g: Game, x: number, y: number, text: string, xs: number, ys: number, angle: number, colors: number[], alpha: number, sep = -1, width = -1): void {
	const font = currentFont(g);
	if (!font) return;
	const lines = wrap(font, splitLines(text), width);
	const lh = sep >= 0 ? sep : lineHeight(font);
	const total = lines.length * lh;
	const oy = g.valign === 1 ? -total / 2 : g.valign === 2 ? -total : 0;
	const sx = xs * font.scaleX;
	const sy = ys * font.scaleY;
	const rad = -angle * deg;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const at = (px: number, py: number): Point => (angle === 0 ? { x: x + px, y: y + py } : { x: x + px * cos - py * sin, y: y + px * sin + py * cos });
	const item = font.item;
	lines.forEach((line, row) => {
		const w = lineWidth(font, line);
		let cx = g.halign === 1 ? -w / 2 : g.halign === 2 ? -w : 0;
		const cy = oy + row * lh;
		for (const ch of line) {
			const glyph = font.glyphs.get(ch.codePointAt(0) ?? 0);
			if (glyph && glyph.width > 0) {
				const gx = (cx + glyph.offset) * sx;
				const gy = cy * sy;
				const gw = glyph.width * sx;
				const gh = glyph.height * sy;
				const corners = [at(gx, gy), at(gx + gw, gy), at(gx, gy + gh), at(gx + gw, gy + gh)];
				g.renderer.quad(item.page, item.sourceX + glyph.x, item.sourceY + glyph.y, glyph.width, glyph.height, corners, colors, alpha);
			}
			cx += glyph?.shift ?? Math.ceil(font.size / 2);
		}
	});
}

function textSize(g: Game, text: string, sep = -1, width = -1): { w: number; h: number } {
	const font = currentFont(g);
	if (!font) return { w: 0, h: 0 };
	const lines = wrap(font, splitLines(text), width);
	return {
		w: Math.max(0, ...lines.map((l) => lineWidth(font, l))) * font.scaleX,
		h: lines.length * (sep >= 0 ? sep : lineHeight(font)) * font.scaleY,
	};
}

// ---------------------------------------------------------------- sprites

function sprite(g: Game, index: Value): Sprite | undefined {
	return g.data.spriteList[i(index)];
}

function subimage(f: Frame, sub: Value): number {
	const v = n(sub);
	return v < 0 ? f.self.imageIndex : v;
}

/** Draws the part [left, left+w) x [top, top+h) of an item's full (untrimmed) image. */
function drawItemPart(g: Game, item: TexturePageItem, left: number, top: number, w: number, h: number, x: number, y: number, xs: number, ys: number, color: number, alpha: number): void {
	const l = Math.max(left, item.targetX);
	const t = Math.max(top, item.targetY);
	const r = Math.min(left + w, item.targetX + item.targetWidth);
	const btm = Math.min(top + h, item.targetY + item.targetHeight);
	if (r <= l || btm <= t) return;
	const fx = item.sourceWidth / item.targetWidth;
	const fy = item.sourceHeight / item.targetHeight;
	g.renderer.drawRegion(
		item.page,
		item.sourceX + (l - item.targetX) * fx,
		item.sourceY + (t - item.targetY) * fy,
		(r - l) * fx,
		(btm - t) * fy,
		x + (l - left) * xs,
		y + (t - top) * ys,
		(r - l) * xs,
		(btm - t) * ys,
		color,
		alpha,
	);
}

function frameItem(spr: Sprite, sub: number): TexturePageItem | undefined {
	const count = spr.frames.length;
	if (!count) return undefined;
	return spr.frames[((Math.floor(sub) % count) + count) % count];
}

// ---------------------------------------------------------------- shapes

function circlePoints(g: Game, cx: number, cy: number, rx: number, ry: number): Point[] {
	const steps = Math.max(4, g.circlePrecision);
	return Array.from({ length: steps }, (_, k) => {
		const a = (k / steps) * Math.PI * 2;
		return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
	});
}

function drawLine(g: Game, x1: number, y1: number, x2: number, y2: number, width: number, c1: number, c2: number): void {
	const len = Math.hypot(x2 - x1, y2 - y1);
	if (len === 0) {
		g.renderer.fillRect(x1, y1, width, width, c1, g.drawAlpha);
		return;
	}
	const nx = (-(y2 - y1) / len) * (width / 2);
	const ny = ((x2 - x1) / len) * (width / 2);
	g.renderer.fillQuad(
		[
			{ x: x1 + nx, y: y1 + ny },
			{ x: x2 + nx, y: y2 + ny },
			{ x: x1 - nx, y: y1 - ny },
			{ x: x2 - nx, y: y2 - ny },
		],
		[c1, c2, c1, c2],
		g.drawAlpha,
	);
}

function drawRect(g: Game, x1: number, y1: number, x2: number, y2: number, colors: number[], outline: boolean): void {
	let l = Math.min(x1, x2);
	let t = Math.min(y1, y2);
	let r = Math.max(x1, x2) + 1;
	let btm = Math.max(y1, y2) + 1;
	if (!outline) [l, t, r, btm] = g.coverArea(l, t, r, btm);
	// colors: top-left, top-right, bottom-right, bottom-left (GameMaker order)
	if (outline) {
		drawLine(g, l, t + 0.5, r, t + 0.5, 1, colors[0], colors[1]);
		drawLine(g, l, btm - 0.5, r, btm - 0.5, 1, colors[3], colors[2]);
		drawLine(g, l + 0.5, t, l + 0.5, btm, 1, colors[0], colors[3]);
		drawLine(g, r - 0.5, t, r - 0.5, btm, 1, colors[1], colors[2]);
		return;
	}
	g.renderer.fillQuad(
		[
			{ x: l, y: t },
			{ x: r, y: t },
			{ x: l, y: btm },
			{ x: r, y: btm },
		],
		[colors[0], colors[1], colors[3], colors[2]],
		g.drawAlpha,
	);
}

function drawEllipse(g: Game, x1: number, y1: number, x2: number, y2: number, inner: number, outer: number, outline: boolean): void {
	const cx = (x1 + x2) / 2;
	const cy = (y1 + y2) / 2;
	const pts = circlePoints(g, cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2);
	pts.forEach((p, k) => {
		const q = pts[(k + 1) % pts.length];
		if (outline) drawLine(g, p.x, p.y, q.x, q.y, 1, outer, outer);
		else g.renderer.fillTriangle({ x: cx, y: cy }, p, q, [inner, outer, outer], g.drawAlpha);
	});
}

// ---------------------------------------------------------------- misc helpers

function playSurface(g: Game, id: number) {
	return g.surfaces.get(id);
}

function datetimeNow(): number {
	// GameMaker datetimes count days since 1899-12-30, in local time.
	const now = new Date();
	const local = now.getTime() - now.getTimezoneOffset() * 60000;
	return local / 86400000 + 25569;
}

function hsvToColor(h: number, sat: number, v: number): number {
	const hh = ((h / 255) * 360) % 360;
	const ss = sat / 255;
	const vv = v / 255;
	const c = vv * ss;
	const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
	const m = vv - c;
	const [r, gr, bl] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
	return Math.round((r + m) * 255) | (Math.round((gr + m) * 255) << 8) | (Math.round((bl + m) * 255) << 16);
}

function nearestDistance(g: Game, self: Instance, x: number, y: number): number {
	const bb = g.bounds(self);
	if (!bb) return Math.hypot(x - self.x, y - self.y);
	const dx = Math.max(bb.left - x, 0, x - bb.right);
	const dy = Math.max(bb.top - y, 0, y - bb.bottom);
	return Math.hypot(dx, dy);
}

function dsMap(g: Game, id: Value) {
	return g.dsMaps.get(i(id));
}

// GameMaker gamepad constants (gp_face1...) mapped to the browser's standard gamepad layout.
const GP_BUTTONS: Record<number, number> = {
	32769: 0, // gp_face1
	32770: 1,
	32771: 2,
	32772: 3,
	32773: 4, // gp_shoulderl
	32774: 5,
	32775: 6, // gp_shoulderlb
	32776: 7,
	32777: 8, // gp_select
	32778: 9, // gp_start
	32779: 10, // gp_stickl
	32780: 11,
	32781: 12, // gp_padu
	32782: 13,
	32783: 14,
	32784: 15,
};
const GP_AXES: Record<number, number> = { 32785: 0, 32786: 1, 32787: 2, 32788: 3 };

function pad(index: number): Gamepad | null {
	return navigator.getGamepads?.()[index] ?? null;
}

function key(v: Value): string | number {
	return typeof v === 'number' ? v : s(v);
}

function relative(g: Game, base: number, v: number): number {
	return g.actionRelative ? base + v : v;
}

// ---------------------------------------------------------------- the table

export const BUILTINS: Record<string, Builtin> = {
	// ---- math
	abs: (_g, _f, a) => Math.abs(n(a[0])),
	sign: (_g, _f, a) => Math.sign(n(a[0])),
	floor: (_g, _f, a) => Math.floor(n(a[0])),
	ceil: (_g, _f, a) => Math.ceil(n(a[0])),
	round: (_g, _f, a) => roundHalfEven(n(a[0])),
	frac: (_g, _f, a) => n(a[0]) % 1,
	sqr: (_g, _f, a) => n(a[0]) ** 2,
	sqrt: (_g, _f, a) => Math.sqrt(n(a[0])),
	power: (_g, _f, a) => n(a[0]) ** n(a[1]),
	exp: (_g, _f, a) => Math.exp(n(a[0])),
	ln: (_g, _f, a) => Math.log(n(a[0])),
	sin: (_g, _f, a) => Math.sin(n(a[0])),
	cos: (_g, _f, a) => Math.cos(n(a[0])),
	tan: (_g, _f, a) => Math.tan(n(a[0])),
	arctan2: (_g, _f, a) => Math.atan2(n(a[0]), n(a[1])),
	darctan2: (_g, _f, a) => Math.atan2(n(a[0]), n(a[1])) / deg,
	dsin: (_g, _f, a) => Math.sin(n(a[0]) * deg),
	dcos: (_g, _f, a) => Math.cos(n(a[0]) * deg),
	degtorad: (_g, _f, a) => n(a[0]) * deg,
	radtodeg: (_g, _f, a) => n(a[0]) / deg,
	max: (_g, _f, a) => Math.max(...a.map(n)),
	min: (_g, _f, a) => Math.min(...a.map(n)),
	mean: (_g, _f, a) => a.reduce<number>((t, v) => t + n(v), 0) / Math.max(1, a.length),
	clamp: (_g, _f, a) => Math.min(Math.max(n(a[0]), n(a[1])), n(a[2])),
	lerp: (_g, _f, a) => n(a[0]) + (n(a[1]) - n(a[0])) * n(a[2]),
	random: (g, _f, a) => g.random() * n(a[0]),
	random_range: (g, _f, a) => n(a[0]) + g.random() * (n(a[1]) - n(a[0])),
	irandom: (g, _f, a) => Math.floor(g.random() * (i(a[0]) + 1)),
	irandom_range: (g, _f, a) => i(a[0]) + Math.floor(g.random() * (i(a[1]) - i(a[0]) + 1)),
	choose: (g, _f, a) => a[Math.floor(g.random() * a.length)],
	randomize: (g) => g.setRandomSeed(Math.random() * 0x100000000),
	random_set_seed: (g, _f, a) => g.setRandomSeed(i(a[0])),
	random_get_seed: (g) => g.randomSeed,
	point_direction: (_g, _f, a) => {
		const d = Math.atan2(-(n(a[3]) - n(a[1])), n(a[2]) - n(a[0])) / deg;
		return d < 0 ? d + 360 : d;
	},
	point_distance: (_g, _f, a) => Math.hypot(n(a[2]) - n(a[0]), n(a[3]) - n(a[1])),
	lengthdir_x: (_g, _f, a) => Math.cos(n(a[1]) * deg) * n(a[0]),
	lengthdir_y: (_g, _f, a) => -Math.sin(n(a[1]) * deg) * n(a[0]),
	make_color_rgb: (_g, _f, a) => (i(a[0]) & 255) | ((i(a[1]) & 255) << 8) | ((i(a[2]) & 255) << 16),
	make_colour_rgb: (_g, _f, a) => (i(a[0]) & 255) | ((i(a[1]) & 255) << 8) | ((i(a[2]) & 255) << 16),
	make_color_hsv: (_g, _f, a) => hsvToColor(n(a[0]), n(a[1]), n(a[2])),
	make_colour_hsv: (_g, _f, a) => hsvToColor(n(a[0]), n(a[1]), n(a[2])),
	merge_color: (_g, _f, a) => {
		const c1 = i(a[0]);
		const c2 = i(a[1]);
		const t = Math.min(1, Math.max(0, n(a[2])));
		const mix = (shift: number) => Math.round(((c1 >> shift) & 255) * (1 - t) + ((c2 >> shift) & 255) * t) << shift;
		return mix(0) | mix(8) | mix(16);
	},
	color_get_red: (_g, _f, a) => i(a[0]) & 255,
	color_get_green: (_g, _f, a) => (i(a[0]) >> 8) & 255,
	color_get_blue: (_g, _f, a) => (i(a[0]) >> 16) & 255,

	// ---- strings
	string: (_g, _f, a) => gmString(a[0]),
	real: (_g, _f, a) => n(a[0]),
	chr: (_g, _f, a) => String.fromCharCode(i(a[0])),
	ord: (_g, _f, a) => s(a[0]).charCodeAt(0) || 0,
	is_undefined: (_g, _f, a) => (a[0] === undefined ? 1 : 0),
	is_string: (_g, _f, a) => (typeof a[0] === 'string' ? 1 : 0),
	is_real: (_g, _f, a) => (typeof a[0] === 'number' ? 1 : 0),
	string_length: (_g, _f, a) => s(a[0]).length,
	string_byte_length: (_g, _f, a) => new TextEncoder().encode(s(a[0])).length,
	string_char_at: (_g, _f, a) => {
		const str = s(a[0]);
		const k = i(a[1]);
		return str.charAt(Math.max(1, k) - 1);
	},
	string_copy: (_g, _f, a) => {
		const str = s(a[0]);
		const start = Math.max(1, i(a[1]));
		return str.substr(start - 1, Math.max(0, i(a[2])));
	},
	string_delete: (_g, _f, a) => {
		const str = s(a[0]);
		const start = Math.max(1, i(a[1])) - 1;
		return str.slice(0, start) + str.slice(start + Math.max(0, i(a[2])));
	},
	string_insert: (_g, _f, a) => {
		const str = s(a[1]);
		const at = Math.max(1, i(a[2])) - 1;
		return str.slice(0, at) + s(a[0]) + str.slice(at);
	},
	string_pos: (_g, _f, a) => s(a[1]).indexOf(s(a[0])) + 1,
	string_lower: (_g, _f, a) => s(a[0]).toLowerCase(),
	string_upper: (_g, _f, a) => s(a[0]).toUpperCase(),
	string_repeat: (_g, _f, a) => s(a[0]).repeat(Math.max(0, i(a[1]))),
	string_replace: (_g, _f, a) => s(a[0]).replace(s(a[1]), s(a[2])),
	string_replace_all: (_g, _f, a) => (s(a[1]) === '' ? s(a[0]) : s(a[0]).split(s(a[1])).join(s(a[2]))),
	string_count: (_g, _f, a) => (s(a[0]) === '' ? 0 : s(a[1]).split(s(a[0])).length - 1),
	string_digits: (_g, _f, a) => s(a[0]).replace(/\D/g, ''),
	string_letters: (_g, _f, a) => s(a[0]).replace(/[^A-Za-z]/g, ''),
	string_width: (g, _f, a) => textSize(g, s(a[0])).w,
	string_height: (g, _f, a) => textSize(g, s(a[0])).h,
	string_width_ext: (g, _f, a) => textSize(g, s(a[0]), n(a[1]), n(a[2])).w,
	string_height_ext: (g, _f, a) => textSize(g, s(a[0]), n(a[1]), n(a[2])).h,

	// ---- draw state
	draw_set_color: (g, _f, a) => void (g.drawColor = i(a[0])),
	draw_set_colour: (g, _f, a) => void (g.drawColor = i(a[0])),
	draw_get_color: (g) => g.drawColor,
	draw_get_colour: (g) => g.drawColor,
	draw_set_alpha: (g, _f, a) => void (g.drawAlpha = n(a[0])),
	draw_get_alpha: (g) => g.drawAlpha,
	draw_set_font: (g, _f, a) => void (g.drawFont = i(a[0])),
	draw_set_halign: (g, _f, a) => void (g.halign = i(a[0])),
	draw_set_valign: (g, _f, a) => void (g.valign = i(a[0])),
	draw_set_circle_precision: (g, _f, a) => void (g.circlePrecision = Math.max(4, i(a[0]))),
	draw_enable_alphablend: (g, _f, a) => g.renderer.setBlending(b(a[0])),
	texture_set_interpolation: () => 0,
	draw_clear: (g, _f, a) => g.renderer.clear(i(a[0]), 1),
	draw_clear_alpha: (g, _f, a) => g.renderer.clear(i(a[0]), n(a[1])),
	draw_getpixel: (g, _f, a) => g.renderer.getPixel(n(a[0]), n(a[1])),

	// ---- draw sprites and backgrounds
	draw_self: (g, f) => g.drawSelf(f.self),
	draw_sprite: (g, f, a) => {
		const spr = sprite(g, a[0]);
		if (spr) g.drawSprite(spr, subimage(f, a[1]), n(a[2]), n(a[3]), 1, 1, 0, 0xffffff, g.drawAlpha);
	},
	draw_sprite_ext: (g, f, a) => {
		const spr = sprite(g, a[0]);
		if (spr) g.drawSprite(spr, subimage(f, a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), i(a[7]), n(a[8]));
	},
	draw_sprite_stretched: (g, f, a) => {
		const spr = sprite(g, a[0]);
		if (spr) g.drawSprite(spr, subimage(f, a[1]), n(a[2]) + spr.originX * (n(a[4]) / spr.width), n(a[3]) + spr.originY * (n(a[5]) / spr.height), n(a[4]) / spr.width, n(a[5]) / spr.height, 0, 0xffffff, g.drawAlpha);
	},
	draw_sprite_part: (g, f, a) => {
		const spr = sprite(g, a[0]);
		const item = spr && frameItem(spr, subimage(f, a[1]));
		if (item) drawItemPart(g, item, n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), n(a[7]), 1, 1, 0xffffff, g.drawAlpha);
	},
	draw_sprite_part_ext: (g, f, a) => {
		const spr = sprite(g, a[0]);
		const item = spr && frameItem(spr, subimage(f, a[1]));
		if (item) drawItemPart(g, item, n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), n(a[7]), n(a[8]), n(a[9]), i(a[10]), n(a[11]));
	},
	draw_background: (g, _f, a) => {
		const item = g.data.backgrounds[i(a[0])]?.item;
		if (item) g.drawItem(item, n(a[1]), n(a[2]), 0, 0, 1, 1, 0, 0xffffff, g.drawAlpha);
	},
	draw_background_ext: (g, _f, a) => {
		const item = g.data.backgrounds[i(a[0])]?.item;
		if (item) g.drawItem(item, n(a[1]), n(a[2]), 0, 0, n(a[3]), n(a[4]), n(a[5]), i(a[6]), n(a[7]));
	},
	draw_background_stretched: (g, _f, a) => {
		const item = g.data.backgrounds[i(a[0])]?.item;
		if (item) g.drawItem(item, n(a[1]), n(a[2]), 0, 0, n(a[3]) / item.boundingWidth, n(a[4]) / item.boundingHeight, 0, 0xffffff, g.drawAlpha);
	},
	draw_background_part: (g, _f, a) => {
		const item = g.data.backgrounds[i(a[0])]?.item;
		if (item) drawItemPart(g, item, n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), 1, 1, 0xffffff, g.drawAlpha);
	},
	draw_background_part_ext: (g, _f, a) => {
		const item = g.data.backgrounds[i(a[0])]?.item;
		if (item) drawItemPart(g, item, n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), n(a[7]), n(a[8]), i(a[9]), n(a[10]));
	},

	// ---- draw text
	draw_text: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), 1, 1, 0, Array(4).fill(g.drawColor), g.drawAlpha),
	draw_text_ext: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), 1, 1, 0, Array(4).fill(g.drawColor), g.drawAlpha, n(a[3]), n(a[4])),
	draw_text_transformed: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), n(a[3]), n(a[4]), n(a[5]), Array(4).fill(g.drawColor), g.drawAlpha),
	draw_text_color: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), 1, 1, 0, [i(a[3]), i(a[4]), i(a[6]), i(a[5])], n(a[7])),
	draw_text_colour: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), 1, 1, 0, [i(a[3]), i(a[4]), i(a[6]), i(a[5])], n(a[7])),
	draw_text_transformed_color: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), n(a[3]), n(a[4]), n(a[5]), [i(a[6]), i(a[7]), i(a[9]), i(a[8])], n(a[10])),
	draw_text_transformed_colour: (g, _f, a) => drawText(g, n(a[0]), n(a[1]), s(a[2]), n(a[3]), n(a[4]), n(a[5]), [i(a[6]), i(a[7]), i(a[9]), i(a[8])], n(a[10])),

	// ---- draw shapes
	draw_point: (g, _f, a) => g.renderer.fillRect(n(a[0]), n(a[1]), 1, 1, g.drawColor, g.drawAlpha),
	draw_point_color: (g, _f, a) => g.renderer.fillRect(n(a[0]), n(a[1]), 1, 1, i(a[2]), g.drawAlpha),
	draw_point_colour: (g, _f, a) => g.renderer.fillRect(n(a[0]), n(a[1]), 1, 1, i(a[2]), g.drawAlpha),
	draw_line: (g, _f, a) => drawLine(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), 1, g.drawColor, g.drawColor),
	draw_line_width: (g, _f, a) => drawLine(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), g.drawColor, g.drawColor),
	draw_line_color: (g, _f, a) => drawLine(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), 1, i(a[4]), i(a[5])),
	draw_line_colour: (g, _f, a) => drawLine(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), 1, i(a[4]), i(a[5])),
	draw_line_width_color: (g, _f, a) => drawLine(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), i(a[5]), i(a[6])),
	draw_line_width_colour: (g, _f, a) => drawLine(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), i(a[5]), i(a[6])),
	draw_rectangle: (g, _f, a) => drawRect(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), Array(4).fill(g.drawColor), b(a[4])),
	draw_rectangle_color: (g, _f, a) => drawRect(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), [i(a[4]), i(a[5]), i(a[6]), i(a[7])], b(a[8])),
	draw_rectangle_colour: (g, _f, a) => drawRect(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), [i(a[4]), i(a[5]), i(a[6]), i(a[7])], b(a[8])),
	draw_roundrect: (g, _f, a) => drawRect(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), Array(4).fill(g.drawColor), b(a[4])),
	draw_circle: (g, _f, a) => {
		const r = n(a[2]);
		drawEllipse(g, n(a[0]) - r, n(a[1]) - r, n(a[0]) + r, n(a[1]) + r, g.drawColor, g.drawColor, b(a[3]));
	},
	draw_circle_color: (g, _f, a) => {
		const r = n(a[2]);
		drawEllipse(g, n(a[0]) - r, n(a[1]) - r, n(a[0]) + r, n(a[1]) + r, i(a[3]), i(a[4]), b(a[5]));
	},
	draw_ellipse: (g, _f, a) => drawEllipse(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), g.drawColor, g.drawColor, b(a[4])),
	draw_ellipse_color: (g, _f, a) => drawEllipse(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), i(a[4]), i(a[5]), b(a[6])),
	draw_ellipse_colour: (g, _f, a) => drawEllipse(g, n(a[0]), n(a[1]), n(a[2]), n(a[3]), i(a[4]), i(a[5]), b(a[6])),
	draw_triangle: (g, _f, a) => BUILTINS.draw_triangle_color(g, _f, [a[0], a[1], a[2], a[3], a[4], a[5], g.drawColor, g.drawColor, g.drawColor, a[6]]),
	draw_triangle_color: (g, _f, a) => {
		const p = [
			{ x: n(a[0]), y: n(a[1]) },
			{ x: n(a[2]), y: n(a[3]) },
			{ x: n(a[4]), y: n(a[5]) },
		];
		const c = [i(a[6]), i(a[7]), i(a[8])];
		if (b(a[9])) {
			for (let k = 0; k < 3; k++) drawLine(g, p[k].x, p[k].y, p[(k + 1) % 3].x, p[(k + 1) % 3].y, 1, c[k], c[(k + 1) % 3]);
		} else {
			g.renderer.fillTriangle(p[0], p[1], p[2], c, g.drawAlpha);
		}
	},

	// ---- surfaces
	surface_create: (g, _f, a) => g.createSurface(n(a[0]), n(a[1])),
	surface_free: (g, _f, a) => g.freeSurface(i(a[0])),
	surface_exists: (g, _f, a) => (g.surfaces.has(i(a[0])) ? 1 : 0),
	surface_get_width: (g, _f, a) => playSurface(g, i(a[0]))?.width ?? -1,
	surface_get_height: (g, _f, a) => playSurface(g, i(a[0]))?.height ?? -1,
	surface_set_target: (g, _f, a) => {
		const surf = playSurface(g, i(a[0]));
		if (!surf) return 0;
		g.pushTarget(surf);
		return 1;
	},
	surface_reset_target: (g) => g.popTarget(),
	draw_surface: (g, _f, a) => {
		const surf = playSurface(g, i(a[0]));
		if (surf) g.renderer.drawPage(surf, 0, 0, surf.width, surf.height, n(a[1]), n(a[2]), surf.width, surf.height, 0xffffff, g.drawAlpha);
	},
	draw_surface_ext: (g, _f, a) => {
		const surf = playSurface(g, i(a[0]));
		if (!surf) return;
		const x = n(a[1]);
		const y = n(a[2]);
		const xs = n(a[3]);
		const ys = n(a[4]);
		const rad = -n(a[5]) * deg;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		const at = (px: number, py: number) => ({ x: x + px * cos - py * sin, y: y + px * sin + py * cos });
		const w = surf.width * xs;
		const h = surf.height * ys;
		const c = i(a[6]);
		g.renderer.quad(surf, 0, 0, surf.width, surf.height, [at(0, 0), at(w, 0), at(0, h), at(w, h)], [c, c, c, c], n(a[7]));
	},
	draw_surface_part: (g, _f, a) => {
		const surf = playSurface(g, i(a[0]));
		if (surf) g.renderer.drawPage(surf, n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5]), n(a[6]), n(a[3]), n(a[4]), 0xffffff, g.drawAlpha);
	},
	draw_surface_stretched: (g, _f, a) => {
		const surf = playSurface(g, i(a[0]));
		if (surf) g.renderer.drawPage(surf, 0, 0, surf.width, surf.height, n(a[1]), n(a[2]), n(a[3]), n(a[4]), 0xffffff, g.drawAlpha);
	},
	application_surface_enable: (g, _f, a) => void (g.appSurfaceEnabled = b(a[0])),
	application_surface_draw_enable: (g, _f, a) => void (g.appSurfaceDraw = b(a[0])),
	sprite_create_from_surface: (g, _f, a) => g.spriteFromSurface(i(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[7]), n(a[8])),

	// ---- sprite and background info
	sprite_exists: (g, _f, a) => (sprite(g, a[0]) ? 1 : 0),
	sprite_get_width: (g, _f, a) => sprite(g, a[0])?.width ?? 0,
	sprite_get_height: (g, _f, a) => sprite(g, a[0])?.height ?? 0,
	sprite_get_number: (g, _f, a) => sprite(g, a[0])?.frames.length ?? 0,
	sprite_get_xoffset: (g, _f, a) => sprite(g, a[0])?.originX ?? 0,
	sprite_get_yoffset: (g, _f, a) => sprite(g, a[0])?.originY ?? 0,
	sprite_get_name: (g, _f, a) => sprite(g, a[0])?.name ?? '<undefined>',
	sprite_delete: (g, _f, a) => g.deleteSprite(i(a[0])),
	// Loads an image from a file on disk; a browser page has no such file, so the sprite stays as it is.
	sprite_replace: () => 0,
	sprite_prefetch: () => 0,
	sprite_collision_mask: () => 0,
	background_get_width: (g, _f, a) => g.data.backgrounds[i(a[0])]?.item?.boundingWidth ?? 0,
	background_get_height: (g, _f, a) => g.data.backgrounds[i(a[0])]?.item?.boundingHeight ?? 0,
	tile_layer_hide: (g, _f, a) => void g.hiddenTileDepths.add(n(a[0])),
	tile_layer_show: (g, _f, a) => void g.hiddenTileDepths.delete(n(a[0])),
	tile_layer_shift: (g, _f, a) => {
		for (const t of g.tiles) {
			if (t.depth === n(a[0])) {
				t.x += n(a[1]);
				t.y += n(a[2]);
			}
		}
	},

	// ---- instances
	instance_create: (g, _f, a) => g.spawn(n(a[0]), n(a[1]), i(a[2]))?.id ?? NOONE,
	instance_destroy: (g, f, a) => {
		const target = a.length ? g.findInstance(i(a[0])) : f.self;
		if (target) g.destroy(target);
	},
	instance_exists: (g, f, a) => (g.resolveAll(f, i(a[0])).length > 0 ? 1 : 0),
	instance_number: (g, f, a) => g.resolveAll(f, i(a[0])).length,
	instance_find: (g, f, a) => g.resolveAll(f, i(a[0]))[i(a[1])]?.id ?? NOONE,
	instance_change: (g, f, a) => g.changeInstance(f.self, i(a[0]), b(a[1])),
	instance_position: (g, f, a) => g.findCollision(f, i(a[2]), false, (o) => g.pointInside(o, n(a[0]), n(a[1]))),
	instance_place: (g, f, a) => g.placeCollision(f, n(a[0]), n(a[1]), i(a[2])),
	place_meeting: (g, f, a) => (g.placeCollision(f, n(a[0]), n(a[1]), i(a[2])) !== NOONE ? 1 : 0),
	place_free: (g, f, a) => (g.placeCollision(f, n(a[0]), n(a[1]), ALL, true) === NOONE ? 1 : 0),
	place_empty: (g, f, a) => (g.placeCollision(f, n(a[0]), n(a[1]), ALL) === NOONE ? 1 : 0),
	instance_activate_all: (g) => {
		for (const inst of g.instances) inst.active = true;
	},
	instance_activate_object: (g, _f, a) => {
		for (const inst of g.instances) if (g.isA(inst, i(a[0])) || inst.id === i(a[0])) inst.active = true;
	},
	instance_deactivate_all: (g, f, a) => {
		for (const inst of g.instances) if (!(b(a[0]) && inst === f.self)) inst.active = false;
	},
	instance_deactivate_object: (g, _f, a) => {
		for (const inst of g.instances) if (g.isA(inst, i(a[0])) || inst.id === i(a[0])) inst.active = false;
	},
	object_get_name: (g, _f, a) => g.data.objects[i(a[0])]?.name ?? '<undefined>',
	object_exists: (g, _f, a) => (g.data.objects[i(a[0])] ? 1 : 0),
	object_get_parent: (g, _f, a) => g.data.objects[i(a[0])]?.parent ?? -1,
	object_is_ancestor: (g, _f, a) => {
		let o = g.data.objects[i(a[0])]?.parent ?? -1;
		for (let guard = 0; o >= 0 && guard < 64; guard++, o = g.data.objects[o].parent) if (o === i(a[1])) return 1;
		return 0;
	},

	// ---- collisions
	collision_point: (g, f, a) => g.findCollision(f, i(a[2]), b(a[4]), (o) => g.pointInside(o, n(a[0]), n(a[1]), b(a[3]))),
	collision_rectangle: (g, f, a) => {
		const l = Math.min(n(a[0]), n(a[2]));
		const t = Math.min(n(a[1]), n(a[3]));
		const r = Math.max(n(a[0]), n(a[2]));
		const btm = Math.max(n(a[1]), n(a[3]));
		return g.findCollision(f, i(a[4]), b(a[6]), (o) => g.rectOverlaps(o, l, t, r, btm, b(a[5])));
	},
	collision_circle: (g, f, a) => {
		const cx = n(a[0]);
		const cy = n(a[1]);
		const r = n(a[2]);
		return g.findCollision(f, i(a[3]), b(a[5]), (o) => {
			const bb = g.bounds(o);
			if (!bb) return false;
			const dx = Math.max(bb.left - cx, 0, cx - bb.right);
			const dy = Math.max(bb.top - cy, 0, cy - bb.bottom);
			return dx * dx + dy * dy <= r * r;
		});
	},
	collision_line: (g, f, a) => {
		const [x1, y1, x2, y2] = [n(a[0]), n(a[1]), n(a[2]), n(a[3])];
		const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
		return g.findCollision(f, i(a[4]), b(a[6]), (o) => {
			for (let k = 0; k <= steps; k++) {
				if (g.pointInside(o, x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps, b(a[5]))) return true;
			}
			return false;
		});
	},
	distance_to_point: (g, f, a) => nearestDistance(g, f.self, n(a[0]), n(a[1])),
	distance_to_object: (g, f, a) => {
		let best = 1e6;
		const mine = g.bounds(f.self);
		for (const o of g.resolveAll(f, i(a[0]))) {
			if (o === f.self) continue;
			const ob = g.bounds(o);
			if (!mine || !ob) {
				best = Math.min(best, Math.hypot(o.x - f.self.x, o.y - f.self.y));
				continue;
			}
			const dx = Math.max(ob.left - mine.right, 0, mine.left - ob.right);
			const dy = Math.max(ob.top - mine.bottom, 0, mine.top - ob.bottom);
			best = Math.min(best, Math.hypot(dx, dy));
		}
		return best;
	},
	move_snap: (_g, f, a) => {
		const hs = n(a[0]);
		const vs = n(a[1]);
		if (hs > 0) f.self.x = roundHalfEven(f.self.x / hs) * hs;
		if (vs > 0) f.self.y = roundHalfEven(f.self.y / vs) * vs;
	},
	move_towards_point: (_g, f, a) => {
		const dir = Math.atan2(-(n(a[1]) - f.self.y), n(a[0]) - f.self.x) / deg;
		f.self.setMotion(dir, n(a[2]));
	},
	motion_set: (_g, f, a) => f.self.setMotion(n(a[0]), n(a[1])),
	path_start: (g, f, a) => {
		const inst = f.self;
		const path = g.data.paths[i(a[0])];
		if (!path || path.points.length === 0) return;
		inst.path = path.index;
		inst.pathSpeed = n(a[1]);
		inst.pathEndAction = i(a[2]);
		inst.pathPosition = inst.pathSpeed < 0 ? 1 : 0;
		inst.pathOrigin = b(a[3]) ? { x: 0, y: 0 } : { x: inst.x - path.points[0].x, y: inst.y - path.points[0].y };
	},
	path_end: (_g, f) => {
		f.self.path = -1;
	},

	// ---- events and scripts
	event_inherited: (g, f) => g.runInherited(f),
	event_perform: (g, f, a) => {
		g.runEvent(f.self, i(a[0]), i(a[1]), f.other);
	},
	event_user: (g, f, a) => {
		g.runEvent(f.self, EV.OTHER, OTHER_EV.USER0 + i(a[0]), f.other);
	},
	script_execute: (g, f, a) => {
		const name = g.data.scriptNames[i(a[0])];
		const code = name === undefined ? undefined : g.data.scripts.get(name);
		return code === undefined ? 0 : g.callScript(f, code, a.slice(1));
	},
	script_exists: (g, _f, a) => (g.data.scriptNames[i(a[0])] !== undefined ? 1 : 0),

	// ---- rooms and game
	room_goto: (g, _f, a) => g.gotoRoom(i(a[0])),
	room_goto_next: (g) => g.gotoRoom(g.data.roomOrder[g.data.roomOrder.indexOf(g.roomIndex) + 1] ?? -1),
	room_goto_previous: (g) => g.gotoRoom(g.data.roomOrder[g.data.roomOrder.indexOf(g.roomIndex) - 1] ?? -1),
	room_next: (g, _f, a) => g.data.roomOrder[g.data.roomOrder.indexOf(i(a[0])) + 1] ?? -1,
	room_previous: (g, _f, a) => g.data.roomOrder[g.data.roomOrder.indexOf(i(a[0])) - 1] ?? -1,
	room_restart: (g) => g.gotoRoom(g.roomIndex),
	room_get_name: (g, _f, a) => g.data.roomNames[i(a[0])] ?? '<undefined>',
	room_exists: (g, _f, a) => (g.data.rooms[i(a[0])] ? 1 : 0),
	room_set_persistent: (g, _f, a) => {
		if (i(a[0]) === g.roomIndex) g.roomPersistent = b(a[1]);
		const room = g.data.rooms[i(a[0])];
		if (room) room.persistent = b(a[1]);
	},
	game_end: (g) => g.end(),
	game_restart: (g) => g.restart(),

	// ---- keyboard and controllers
	keyboard_check: (g, _f, a) => (g.input.isDown(i(a[0])) ? 1 : 0),
	keyboard_check_direct: (g, _f, a) => (g.input.isDown(i(a[0])) ? 1 : 0),
	keyboard_check_pressed: (g, _f, a) => (g.input.wasPressed(i(a[0])) ? 1 : 0),
	keyboard_check_released: (g, _f, a) => (g.input.wasReleased(i(a[0])) ? 1 : 0),
	keyboard_clear: (g, _f, a) => g.input.clear(i(a[0])),
	keyboard_key_press: (g, _f, a) => g.input.press(i(a[0])),
	keyboard_key_release: (g, _f, a) => g.input.release(i(a[0])),
	joystick_exists: () => 0,
	joystick_buttons: () => 0,
	joystick_check_button: () => 0,
	joystick_direction: () => 101, // vk_numpad5: centred
	joystick_has_pov: () => 0,
	joystick_pov: () => -1,
	joystick_xpos: () => 0,
	joystick_ypos: () => 0,
	gamepad_is_connected: (_g, _f, a) => (pad(i(a[0])) ? 1 : 0),
	gamepad_get_device_count: () => navigator.getGamepads?.().length ?? 0,
	gamepad_button_check: (_g, _f, a) => (pad(i(a[0]))?.buttons[GP_BUTTONS[i(a[1])] ?? -1]?.pressed ? 1 : 0),
	gamepad_axis_value: (_g, _f, a) => pad(i(a[0]))?.axes[GP_AXES[i(a[1])] ?? -1] ?? 0,

	// ---- audio
	audio_play_sound: (g, _f, a) => g.audio.play(i(a[0]), b(a[2])),
	audio_stop_sound: (g, _f, a) => g.audio.stop(i(a[0])),
	audio_stop_all: (g) => g.audio.stopAll(),
	audio_pause_sound: (g, _f, a) => g.audio.pause(i(a[0])),
	audio_resume_sound: (g, _f, a) => g.audio.resumeSound(i(a[0])),
	audio_pause_all: (g) => g.audio.pauseAll(),
	audio_resume_all: (g) => g.audio.resumeAll(),
	audio_is_playing: (g, _f, a) => (g.audio.isPlaying(i(a[0])) ? 1 : 0),
	audio_sound_gain: (g, _f, a) => g.audio.setGain(i(a[0]), n(a[1]), n(a[2])),
	audio_sound_get_gain: (g, _f, a) => g.audio.getGain(i(a[0])),
	audio_sound_pitch: (g, _f, a) => g.audio.setPitch(i(a[0]), n(a[1])),
	audio_sound_get_pitch: (g, _f, a) => g.audio.getPitch(i(a[0])),
	audio_sound_get_track_position: (g, _f, a) => g.audio.getPosition(i(a[0])),
	audio_sound_set_track_position: (g, _f, a) => g.audio.setPosition(i(a[0]), n(a[1])),
	audio_channel_num: () => 0,
	audio_exists: (g, _f, a) => (g.data.sounds[i(a[0])] ? 1 : 0),

	// ---- files
	file_exists: (g, _f, a) => (g.files.exists(s(a[0])) ? 1 : 0),
	file_delete: (g, _f, a) => g.files.delete(s(a[0])),
	file_rename: (g, _f, a) => g.files.rename(s(a[0]), s(a[1])),
	file_text_open_read: (g, _f, a) => g.files.textOpen(s(a[0]), false),
	file_text_open_write: (g, _f, a) => g.files.textOpen(s(a[0]), true),
	file_text_close: (g, _f, a) => g.files.textClose(i(a[0])),
	file_text_read_real: (g, _f, a) => g.files.textReadReal(i(a[0])),
	file_text_read_string: (g, _f, a) => g.files.textReadString(i(a[0])),
	file_text_readln: (g, _f, a) => g.files.textReadln(i(a[0])),
	file_text_eof: (g, _f, a) => (g.files.textEof(i(a[0])) ? 1 : 0),
	file_text_write_real: (g, _f, a) => g.files.textWrite(i(a[0]), ` ${gmString(n(a[1])) === String(Math.trunc(n(a[1]))) ? Math.trunc(n(a[1])) : n(a[1]).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`),
	file_text_write_string: (g, _f, a) => g.files.textWrite(i(a[0]), s(a[1])),
	file_text_writeln: (g, _f, a) => g.files.textWrite(i(a[0]), '\r\n'),
	ini_open: (g, _f, a) => g.files.iniOpen(s(a[0])),
	ini_open_from_string: (g, _f, a) => g.files.iniOpenFromString(s(a[0])),
	ini_close: (g) => g.files.iniClose(),
	ini_section_exists: (g, _f, a) => (g.files.iniSectionExists(s(a[0])) ? 1 : 0),
	ini_read_string: (g, _f, a) => g.files.iniRead(s(a[0]), s(a[1])) ?? s(a[2]),
	ini_read_real: (g, _f, a) => {
		const v = g.files.iniRead(s(a[0]), s(a[1]));
		const num = v === undefined ? NaN : Number(v);
		return Number.isFinite(num) ? num : n(a[2]);
	},
	ini_write_string: (g, _f, a) => g.files.iniWrite(s(a[0]), s(a[1]), s(a[2])),
	ini_write_real: (g, _f, a) => g.files.iniWrite(s(a[0]), s(a[1]), n(a[2]).toFixed(6)),
	ini_key_exists: (g, _f, a) => (g.files.iniRead(s(a[0]), s(a[1])) !== undefined ? 1 : 0),

	// ---- data structures
	ds_map_create: (g) => {
		const id = g.nextDsMap++;
		g.dsMaps.set(id, new Map());
		return id;
	},
	ds_map_destroy: (g, _f, a) => void g.dsMaps.delete(i(a[0])),
	ds_map_exists: (g, _f, a) => (dsMap(g, a[0])?.has(key(a[1])) ? 1 : 0),
	ds_map_add: (g, _f, a) => {
		const m = dsMap(g, a[0]);
		if (m && !m.has(key(a[1]))) m.set(key(a[1]), a[2]);
	},
	ds_map_set: (g, _f, a) => void dsMap(g, a[0])?.set(key(a[1]), a[2]),
	ds_map_set_post: (g, _f, a) => void dsMap(g, a[0])?.set(key(a[1]), a[2]),
	ds_map_replace: (g, _f, a) => void dsMap(g, a[0])?.set(key(a[1]), a[2]),
	ds_map_find_value: (g, _f, a) => dsMap(g, a[0])?.get(key(a[1])),
	ds_map_delete: (g, _f, a) => void dsMap(g, a[0])?.delete(key(a[1])),
	ds_map_size: (g, _f, a) => dsMap(g, a[0])?.size ?? 0,
	ds_map_clear: (g, _f, a) => dsMap(g, a[0])?.clear(),
	json_encode: (g, _f, a) => JSON.stringify(Object.fromEntries(dsMap(g, a[0]) ?? [])),
	json_decode: (g, _f, a) => {
		const id = g.nextDsMap++;
		const m = new Map<string | number, Value>();
		try {
			const parsed: unknown = JSON.parse(s(a[0]));
			if (parsed && typeof parsed === 'object') {
				for (const [k, v] of Object.entries(parsed)) m.set(k, typeof v === 'number' || typeof v === 'string' ? v : undefined);
			}
		} catch {
			return -1;
		}
		g.dsMaps.set(id, m);
		return id;
	},

	// ---- buffers (only used by console builds' async saving)
	buffer_create: () => -1,
	buffer_delete: () => 0,
	buffer_write: () => 0,
	buffer_read: () => 0,
	buffer_get_size: () => 0,
	buffer_save_async: () => -1,
	buffer_load_async: () => -1,
	buffer_async_group_begin: () => 0,
	buffer_async_group_end: () => -1,
	buffer_async_group_option: () => 0,

	// ---- platform
	steam_initialised: () => 0,
	steam_file_exists: () => 0,
	steam_file_delete: () => 0,
	steam_file_write_file: () => 0,
	os_get_language: () => 'en',
	os_get_region: () => '',
	os_is_paused: () => 0,
	window_get_width: (g) => g.renderer.width,
	window_get_height: (g) => g.renderer.height,
	window_get_x: () => 0,
	window_get_y: () => 0,
	window_get_fullscreen: () => (document.fullscreenElement ? 1 : 0),
	window_set_fullscreen: (_g, _f, a) => {
		// F4 in the game: the key press is the user gesture browsers require for fullscreen.
		if (b(a[0]) && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
		else if (!b(a[0]) && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
	},
	window_set_caption: () => 0,
	window_set_position: () => 0,
	window_set_size: () => 0,
	window_center: () => 0,
	display_get_width: () => screen.width,
	display_get_height: () => screen.height,
	date_current_datetime: () => datetimeNow(),
	get_timer: (g) => Math.floor(g.elapsedMs() * 1000),
	get_string_async: () => -1,
	variable_global_exists: (g, _f, a) => (g.globals.has(s(a[0])) ? 1 : 0),
	variable_global_get: (g, _f, a) => g.globals.get(s(a[0])),
	variable_global_set: (g, _f, a) => void g.globals.set(s(a[0]), a[1]),
	extension_stubfunc_real: () => 0,
	show_debug_message: (_g, _f, a) => void console.debug('[game]', s(a[0])),
	show_message: (_g, _f, a) => void console.info('[game message]', s(a[0])),

	// ---- drag-and-drop actions compiled into code
	action_set_relative: (g, _f, a) => void (g.actionRelative = b(a[0])),
	action_create_object: (g, f, a) => {
		g.spawn(relative(g, f.self.x, n(a[1])), relative(g, f.self.y, n(a[2])), i(a[0]));
	},
	action_kill_object: (g, f) => g.destroy(f.self),
	action_move_to: (g, f, a) => {
		f.self.x = relative(g, f.self.x, n(a[0]));
		f.self.y = relative(g, f.self.y, n(a[1]));
	},
	action_move_point: (_g, f, a) => {
		const dir = Math.atan2(-(n(a[1]) - f.self.y), n(a[0]) - f.self.x) / deg;
		f.self.setMotion(dir, n(a[2]));
	},
	action_move: (g, f, a) => {
		// A 9-character string of allowed directions, numpad layout from the bottom-left.
		const dirs = s(a[0]);
		const angles = [225, 270, 315, 180, -1, 0, 135, 90, 45];
		const allowed = angles.filter((_, k) => dirs[k] === '1');
		const pick = allowed[Math.floor(g.random() * allowed.length)];
		if (pick === undefined) return;
		if (pick < 0) f.self.setMotion(0, 0);
		else f.self.setMotion(pick, relative(g, f.self.speed, n(a[1])));
	},
	action_set_motion: (g, f, a) => {
		if (g.actionRelative) {
			const rad = n(a[0]) * deg;
			f.self.hspeed += Math.cos(rad) * n(a[1]);
			f.self.vspeed -= Math.sin(rad) * n(a[1]);
		} else {
			f.self.setMotion(n(a[0]), n(a[1]));
		}
	},
	action_set_hspeed: (g, f, a) => void (f.self.hspeed = relative(g, f.self.hspeed, n(a[0]))),
	action_set_vspeed: (g, f, a) => void (f.self.vspeed = relative(g, f.self.vspeed, n(a[0]))),
	action_set_friction: (g, f, a) => void (f.self.friction = relative(g, f.self.friction, n(a[0]))),
	action_set_gravity: (g, f, a) => {
		f.self.gravityDirection = n(a[0]);
		f.self.gravity = relative(g, f.self.gravity, n(a[1]));
	},
	action_set_alarm: (g, f, a) => {
		const alarm = i(a[1]);
		if (alarm >= 0 && alarm < f.self.alarm.length) f.self.alarm[alarm] = relative(g, f.self.alarm[alarm], n(a[0]));
	},
	action_previous_room: (g) => BUILTINS.room_goto_previous(g, g.dummyFrame(), []),
	action_next_room: (g) => BUILTINS.room_goto_next(g, g.dummyFrame(), []),
};
