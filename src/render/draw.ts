import type { Font, Sprite } from '../data/DataWin.ts';
import type { Renderer } from './Renderer.ts';

// GameMaker colours are 0xBBGGRR.
export const C_WHITE = 0xffffff;
export const C_YELLOW = 0x00ffff;
export const C_GRAY = 0x808080;
export const C_RED = 0x0000ff;

export interface TextOptions {
	color?: number;
	alpha?: number;
	scale?: number;
	align?: 'left' | 'center' | 'right';
}

/** Draws one frame the way GameMaker does: the frame's trimmed image sits at its target offset inside the sprite box. */
export function drawSprite(r: Renderer, sprite: Sprite, frame: number, x: number, y: number, color = C_WHITE, alpha = 1): void {
	const item = sprite.frames[frame % sprite.frames.length];
	r.drawRegion(
		item.page,
		item.sourceX,
		item.sourceY,
		item.sourceWidth,
		item.sourceHeight,
		x - sprite.originX + item.targetX,
		y - sprite.originY + item.targetY,
		item.targetWidth,
		item.targetHeight,
		color,
		alpha,
	);
}

export function textWidth(font: Font, line: string, scale = 1): number {
	let width = 0;
	for (const ch of line) width += advance(font, ch.codePointAt(0) ?? 0);
	return width * font.scaleX * scale;
}

export function drawText(r: Renderer, font: Font, text: string, x: number, y: number, options: TextOptions = {}): void {
	const { color = C_WHITE, alpha = 1, scale = 1, align = 'left' } = options;
	const sx = font.scaleX * scale;
	const sy = font.scaleY * scale;
	const { item } = font;
	text.split('\n').forEach((line, row) => {
		const width = textWidth(font, line, scale);
		let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
		const cy = y + row * font.lineHeight * sy;
		for (const ch of line) {
			const code = ch.codePointAt(0) ?? 0;
			const glyph = font.glyphs.get(code);
			if (glyph && glyph.width > 0) {
				r.drawRegion(
					item.page,
					item.sourceX + glyph.x,
					item.sourceY + glyph.y,
					glyph.width,
					glyph.height,
					Math.round(cx + glyph.offset * sx),
					Math.round(cy),
					glyph.width * sx,
					glyph.height * sy,
					color,
					alpha,
				);
			}
			cx += advance(font, code) * sx;
		}
	});
}

function advance(font: Font, code: number): number {
	return font.glyphs.get(code)?.shift ?? Math.ceil(font.size / 2);
}
