// Parses data.win with the engine's reader and prints structural facts (no game text).
// Usage: node tools/check-datawin.ts [path/to/data.win]
import { readFileSync } from 'node:fs';
import { parseDataWin } from '../src/data/DataWin.ts';

const path = process.argv[2] ?? 'C:/Users/ariju/Documents/code_proj/undertale-reverse/assets/data.win';
const bytes = new Uint8Array(readFileSync(path));
const t0 = performance.now();
const data = parseDataWin(bytes);
const ms = (performance.now() - t0).toFixed(1);

const pngSize = (png: Uint8Array) => {
	const v = new DataView(png.buffer, png.byteOffset);
	return `${v.getUint32(16)}x${v.getUint32(20)}`;
};

console.log(`parsed in ${ms} ms: bytecode ${data.bytecodeVersion}, ${data.windowWidth}x${data.windowHeight}`);
console.log(`chunks: ${[...data.chunks.keys()].join(' ')}`);
console.log(`texture pages: ${data.texturePages.length} (${data.texturePages.map(pngSize).join(', ')})`);
console.log(`sprites: ${data.sprites.size}, fonts: ${data.fonts.size}, rooms: ${data.roomNames.length}`);

for (const name of ['fnt_main', 'fnt_small']) {
	const f = data.fonts.get(name);
	if (!f) throw new Error(`missing ${name}`);
	const chars = [...f.glyphs.keys()];
	console.log(
		`${name}: size ${f.size}, ${f.glyphs.size} glyphs (${Math.min(...chars)}..${Math.max(...chars)}), ` +
			`line ${f.lineHeight}px, scale ${f.scaleX}x${f.scaleY}, page ${f.item.page} at ${f.item.sourceX},${f.item.sourceY}`,
	);
	const m = f.glyphs.get('M'.charCodeAt(0));
	console.log(`  'M' glyph: ${JSON.stringify(m)}`);
}

const heart = data.sprites.get('spr_heart');
if (!heart) throw new Error('missing spr_heart');
console.log(`spr_heart: ${heart.width}x${heart.height}, origin ${heart.originX},${heart.originY}, ${heart.frames.length} frame(s)`);
console.log(`  frame 0: ${JSON.stringify(heart.frames[0])}`);
