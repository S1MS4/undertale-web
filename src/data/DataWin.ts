import { BinaryReader } from './BinaryReader.ts';

// Layouts follow GameMaker Studio 1.4 (bytecode 15/16), which is what Undertale ships.

export interface Chunk {
	offset: number;
	size: number;
}

/** A rectangle on a texture page, plus where it sits inside its sprite's bounding box. */
export interface TexturePageItem {
	sourceX: number;
	sourceY: number;
	sourceWidth: number;
	sourceHeight: number;
	targetX: number;
	targetY: number;
	targetWidth: number;
	targetHeight: number;
	boundingWidth: number;
	boundingHeight: number;
	page: number;
}

export interface Sprite {
	index: number;
	name: string;
	width: number;
	height: number;
	originX: number;
	originY: number;
	/** Collision box, inclusive, in sprite pixels. */
	bboxLeft: number;
	bboxRight: number;
	bboxTop: number;
	bboxBottom: number;
	/** 0 automatic, 1 full image, 2 manual. */
	bboxMode: number;
	/** 0 rectangle, 1 precise (per pixel), 2 rotated rectangle. */
	collisionKind: number;
	frames: TexturePageItem[];
	/** One bit per pixel (MSB first), rows padded to whole bytes; one per frame, or a single shared mask. */
	masks: Uint8Array[];
}

/** Glyph source coordinates are relative to the font's texture page item. */
export interface Glyph {
	char: number;
	x: number;
	y: number;
	width: number;
	height: number;
	shift: number;
	offset: number;
}

export interface Font {
	index: number;
	name: string;
	displayName: string;
	size: number;
	bold: boolean;
	italic: boolean;
	item: TexturePageItem;
	scaleX: number;
	scaleY: number;
	glyphs: Map<number, Glyph>;
	lineHeight: number;
}

export interface Background {
	index: number;
	name: string;
	item: TexturePageItem | null;
}

export interface Sound {
	index: number;
	name: string;
	/** File name for streamed sounds (music, loose .ogg next to data.win). */
	file: string;
	volume: number;
	pitch: number;
	/** Index into embedded audio, or -1 when the sound streams from `file`. */
	audioId: number;
}

export interface EventAction {
	codeId: number;
}

/** Events by type, then subtype (alarm number, key code, other-event number, collision object...). */
export type ObjectEvents = Map<number, Map<number, number>>;

export interface GameObject {
	index: number;
	name: string;
	sprite: number;
	visible: boolean;
	solid: boolean;
	depth: number;
	persistent: boolean;
	parent: number;
	mask: number;
	/** event type -> subtype -> code id */
	events: ObjectEvents;
}

export interface RoomBackground {
	enabled: boolean;
	foreground: boolean;
	background: number;
	x: number;
	y: number;
	tileX: boolean;
	tileY: boolean;
	speedX: number;
	speedY: number;
	stretch: boolean;
}

export interface RoomView {
	enabled: boolean;
	viewX: number;
	viewY: number;
	viewW: number;
	viewH: number;
	portX: number;
	portY: number;
	portW: number;
	portH: number;
	borderX: number;
	borderY: number;
	speedX: number;
	speedY: number;
	object: number;
}

export interface RoomInstance {
	x: number;
	y: number;
	object: number;
	id: number;
	creationCode: number;
	scaleX: number;
	scaleY: number;
	color: number;
	rotation: number;
	preCreateCode: number;
}

export interface RoomTile {
	x: number;
	y: number;
	background: number;
	sourceX: number;
	sourceY: number;
	width: number;
	height: number;
	depth: number;
	id: number;
	scaleX: number;
	scaleY: number;
	color: number;
}

export interface Room {
	index: number;
	name: string;
	width: number;
	height: number;
	speed: number;
	persistent: boolean;
	backgroundColor: number;
	drawBackgroundColor: boolean;
	creationCode: number;
	flags: number;
	backgrounds: RoomBackground[];
	views: RoomView[];
	instances: RoomInstance[];
	tiles: RoomTile[];
}

export interface CodeEntry {
	index: number;
	name: string;
	/** Absolute file offset of the first instruction, and length in bytes. */
	start: number;
	length: number;
	locals: number;
	arguments: number;
}

export interface Variable {
	name: string;
	instanceType: number;
	varId: number;
}

export interface PathPoint {
	x: number;
	y: number;
	speed: number;
}

export interface Path {
	index: number;
	name: string;
	smooth: boolean;
	closed: boolean;
	precision: number;
	points: PathPoint[];
}

export interface DataWin {
	bytecodeVersion: number;
	displayName: string;
	windowWidth: number;
	windowHeight: number;
	chunks: Map<string, Chunk>;
	bytes: Uint8Array;
	reader: BinaryReader;
	/** PNG bytes for each texture page, decoded lazily by the renderer. */
	texturePages: Uint8Array[];
	sprites: Map<string, Sprite>;
	spriteList: Sprite[];
	fonts: Map<string, Font>;
	fontList: Font[];
	backgrounds: Background[];
	sounds: Sound[];
	/** Embedded audio files (WAV/OGG bytes). */
	audio: Uint8Array[];
	objects: GameObject[];
	rooms: Room[];
	roomNames: string[];
	roomOrder: number[];
	paths: Path[];
	/** Script name -> code id. */
	scripts: Map<string, number>;
	scriptNames: string[];
	code: CodeEntry[];
	strings: string[];
	/** Absolute instruction address -> variable referenced there. */
	variableRefs: Map<number, Variable>;
	/** Absolute instruction address -> function name called there. */
	functionRefs: Map<number, string>;
}

const MAX_BYTECODE_VERSION = 16;

export function parseDataWin(bytes: Uint8Array): DataWin {
	const r = new BinaryReader(bytes);
	if (r.tag(0) !== 'FORM') throw new Error('data.win: missing FORM header');
	const chunks = readChunks(r);

	const gen8 = need(chunks, 'GEN8');
	const bytecodeVersion = r.u8(gen8.offset + 1);
	if (bytecodeVersion > MAX_BYTECODE_VERSION) {
		throw new Error(`data.win: bytecode ${bytecodeVersion} is newer than this engine supports`);
	}

	// Sprites and fonts point at shared texture page items; read each one once.
	const items = new Map<number, TexturePageItem>();
	const item = (ptr: number): TexturePageItem => {
		let it = items.get(ptr);
		if (!it) {
			it = readTexturePageItem(r, ptr);
			items.set(ptr, it);
		}
		return it;
	};

	const spriteList = readSprites(r, need(chunks, 'SPRT'), item);
	const fontList = readFonts(r, need(chunks, 'FONT'), item);
	const rooms = readRooms(r, need(chunks, 'ROOM'));
	const scriptEntries = r.pointerList(need(chunks, 'SCPT').offset).map((at) => [r.string(r.u32(at)), r.u32(at + 4)] as const);

	return {
		bytecodeVersion,
		displayName: r.string(r.u32(gen8.offset + 40)),
		windowWidth: r.u32(gen8.offset + 60),
		windowHeight: r.u32(gen8.offset + 64),
		chunks,
		bytes,
		reader: r,
		texturePages: readTexturePages(r, need(chunks, 'TXTR')),
		sprites: new Map(spriteList.map((s) => [s.name, s])),
		spriteList,
		fonts: new Map(fontList.map((f) => [f.name, f])),
		fontList,
		backgrounds: r.pointerList(need(chunks, 'BGND').offset).map((at, index) => {
			const tex = r.u32(at + 16);
			return { index, name: r.string(r.u32(at)), item: tex ? item(tex) : null };
		}),
		sounds: readSounds(r, need(chunks, 'SOND')),
		audio: r.pointerList(need(chunks, 'AUDO').offset).map((at) => r.bytes.subarray(at + 4, at + 4 + r.u32(at))),
		objects: readObjects(r, need(chunks, 'OBJT')),
		rooms,
		roomNames: rooms.map((room) => room.name),
		roomOrder: readRoomOrder(r, gen8, rooms.length),
		paths: readPaths(r, need(chunks, 'PATH')),
		scripts: new Map(scriptEntries),
		scriptNames: scriptEntries.map(([name]) => name),
		code: readCode(r, need(chunks, 'CODE')),
		strings: r.pointerList(need(chunks, 'STRG').offset).map((at) => r.string(at + 4)),
		variableRefs: readVariableRefs(r, need(chunks, 'VARI')),
		functionRefs: readFunctionRefs(r, need(chunks, 'FUNC')),
	};
}

function need(chunks: Map<string, Chunk>, name: string): Chunk {
	const chunk = chunks.get(name);
	if (!chunk) throw new Error(`data.win: missing ${name} chunk`);
	return chunk;
}

function readChunks(r: BinaryReader): Map<string, Chunk> {
	const chunks = new Map<string, Chunk>();
	const end = 8 + r.u32(4);
	for (let at = 8; at < end; ) {
		const size = r.u32(at + 4);
		chunks.set(r.tag(at), { offset: at + 8, size });
		at += 8 + size;
	}
	return chunks;
}

function readTexturePageItem(r: BinaryReader, at: number): TexturePageItem {
	return {
		sourceX: r.u16(at),
		sourceY: r.u16(at + 2),
		sourceWidth: r.u16(at + 4),
		sourceHeight: r.u16(at + 6),
		targetX: r.u16(at + 8),
		targetY: r.u16(at + 10),
		targetWidth: r.u16(at + 12),
		targetHeight: r.u16(at + 14),
		boundingWidth: r.u16(at + 16),
		boundingHeight: r.u16(at + 18),
		page: r.u16(at + 20),
	};
}

function readTexturePages(r: BinaryReader, chunk: Chunk): Uint8Array[] {
	return r.pointerList(chunk.offset).map((entry) => {
		// Entry: u32 "scaled" flag, then a pointer to the PNG data.
		const png = r.u32(entry + 4);
		return r.bytes.subarray(png, png + pngLength(r, png));
	});
}

/** The file stores no PNG sizes, so walk the PNG's chunks up to IEND. */
function pngLength(r: BinaryReader, at: number): number {
	let p = at + 8;
	while (p + 12 <= r.bytes.length) {
		const length = r.view.getUint32(p, false);
		const type = r.tag(p + 4);
		p += 12 + length;
		if (type === 'IEND') return p - at;
	}
	throw new Error(`data.win: unterminated PNG at ${at}`);
}

function readSprites(r: BinaryReader, chunk: Chunk, item: (ptr: number) => TexturePageItem): Sprite[] {
	return r.pointerList(chunk.offset).map((at, index) => {
		const width = r.i32(at + 4);
		const height = r.i32(at + 8);
		// GMS2 sprites put -1 here and continue in another layout; GMS1 files never do.
		const special = r.i32(at + 56) === -1;
		const framePtrs = special ? [] : r.pointerList(at + 56);
		const masks: Uint8Array[] = [];
		if (!special) {
			let p = at + 60 + 4 * framePtrs.length;
			const count = r.u32(p);
			p += 4;
			const maskSize = ((width + 7) >> 3) * height;
			for (let i = 0; i < count; i++, p += maskSize) masks.push(r.bytes.subarray(p, p + maskSize));
		}
		return {
			index,
			name: r.string(r.u32(at)),
			width,
			height,
			bboxLeft: r.i32(at + 12),
			bboxRight: r.i32(at + 16),
			bboxBottom: r.i32(at + 20),
			bboxTop: r.i32(at + 24),
			bboxMode: r.u32(at + 40),
			collisionKind: r.u32(at + 44),
			originX: r.i32(at + 48),
			originY: r.i32(at + 52),
			frames: framePtrs.map(item),
			masks,
		};
	});
}

function readFonts(r: BinaryReader, chunk: Chunk, item: (ptr: number) => TexturePageItem): Font[] {
	return r.pointerList(chunk.offset).map((at, index) => {
		const glyphs = new Map<number, Glyph>();
		let lineHeight = 0;
		for (const g of r.pointerList(at + 40)) {
			const glyph: Glyph = {
				char: r.u16(g),
				x: r.u16(g + 2),
				y: r.u16(g + 4),
				width: r.u16(g + 6),
				height: r.u16(g + 8),
				shift: r.i16(g + 10),
				offset: r.i16(g + 12),
			};
			glyphs.set(glyph.char, glyph);
			lineHeight = Math.max(lineHeight, glyph.height);
		}
		return {
			index,
			name: r.string(r.u32(at)),
			displayName: r.string(r.u32(at + 4)),
			size: r.u32(at + 8),
			bold: r.u32(at + 12) !== 0,
			italic: r.u32(at + 16) !== 0,
			item: item(r.u32(at + 28)),
			scaleX: r.f32(at + 32),
			scaleY: r.f32(at + 36),
			glyphs,
			lineHeight,
		};
	});
}

function readSounds(r: BinaryReader, chunk: Chunk): Sound[] {
	return r.pointerList(chunk.offset).map((at, index) => {
		// Flag bit 0: stored in data.win; bit 1: compressed and stored. Otherwise it's a file next to data.win.
		const embedded = (r.u32(at + 4) & 0x3) !== 0;
		return {
			index,
			name: r.string(r.u32(at)),
			file: r.string(r.u32(at + 12)),
			volume: r.f32(at + 20),
			pitch: r.f32(at + 24),
			audioId: embedded ? r.i32(at + 32) : -1,
		};
	});
}

function readObjects(r: BinaryReader, chunk: Chunk): GameObject[] {
	return r.pointerList(chunk.offset).map((at, index) => {
		const vertexCount = r.i32(at + 64);
		const eventsAt = at + 80 + 8 * Math.max(0, vertexCount);
		const events: ObjectEvents = new Map();
		r.pointerList(eventsAt).forEach((listPtr, type) => {
			const byType = new Map<number, number>();
			for (const eventPtr of r.pointerList(listPtr)) {
				const subtype = r.u32(eventPtr);
				const actions = r.pointerList(eventPtr + 4);
				// Code actions carry the code id; a GMS1 event has one code action.
				for (const action of actions) {
					const codeId = r.i32(action + 32);
					if (codeId >= 0) byType.set(subtype, codeId);
				}
			}
			if (byType.size) events.set(type, byType);
		});
		return {
			index,
			name: r.string(r.u32(at)),
			sprite: r.i32(at + 4),
			visible: r.u32(at + 8) !== 0,
			solid: r.u32(at + 12) !== 0,
			depth: r.i32(at + 16),
			persistent: r.u32(at + 20) !== 0,
			parent: r.i32(at + 24),
			mask: r.i32(at + 28),
			events,
		};
	});
}

function readRooms(r: BinaryReader, chunk: Chunk): Room[] {
	return r.pointerList(chunk.offset).map((at, index) => ({
		index,
		name: r.string(r.u32(at)),
		width: r.u32(at + 8),
		height: r.u32(at + 12),
		speed: r.u32(at + 16),
		persistent: r.u32(at + 20) !== 0,
		backgroundColor: r.u32(at + 24),
		drawBackgroundColor: r.u32(at + 28) !== 0,
		creationCode: r.i32(at + 32),
		flags: r.u32(at + 36),
		backgrounds: r.pointerList(r.u32(at + 40)).map((b) => ({
			enabled: r.u32(b) !== 0,
			foreground: r.u32(b + 4) !== 0,
			background: r.i32(b + 8),
			x: r.i32(b + 12),
			y: r.i32(b + 16),
			tileX: r.u32(b + 20) !== 0,
			tileY: r.u32(b + 24) !== 0,
			speedX: r.i32(b + 28),
			speedY: r.i32(b + 32),
			stretch: r.u32(b + 36) !== 0,
		})),
		views: r.pointerList(r.u32(at + 44)).map((v) => ({
			enabled: r.u32(v) !== 0,
			viewX: r.i32(v + 4),
			viewY: r.i32(v + 8),
			viewW: r.i32(v + 12),
			viewH: r.i32(v + 16),
			portX: r.i32(v + 20),
			portY: r.i32(v + 24),
			portW: r.i32(v + 28),
			portH: r.i32(v + 32),
			borderX: r.u32(v + 36),
			borderY: r.u32(v + 40),
			speedX: r.i32(v + 44),
			speedY: r.i32(v + 48),
			object: r.i32(v + 52),
		})),
		instances: r.pointerList(r.u32(at + 48)).map((o) => ({
			x: r.i32(o),
			y: r.i32(o + 4),
			object: r.i32(o + 8),
			id: r.u32(o + 12),
			creationCode: r.i32(o + 16),
			scaleX: r.f32(o + 20),
			scaleY: r.f32(o + 24),
			color: r.u32(o + 28),
			rotation: r.f32(o + 32),
			preCreateCode: r.i32(o + 36),
		})),
		tiles: r.pointerList(r.u32(at + 52)).map((t) => ({
			x: r.i32(t),
			y: r.i32(t + 4),
			background: r.i32(t + 8),
			sourceX: r.u32(t + 12),
			sourceY: r.u32(t + 16),
			width: r.u32(t + 20),
			height: r.u32(t + 24),
			depth: r.i32(t + 28),
			id: r.u32(t + 32),
			scaleX: r.f32(t + 36),
			scaleY: r.f32(t + 40),
			color: r.u32(t + 44),
		})),
	}));
}

/** GEN8 ends with the room order: a u32 count and that many room indices. */
function readRoomOrder(r: BinaryReader, gen8: Chunk, roomCount: number): number[] {
	for (let at = gen8.offset + gen8.size - 4; at >= gen8.offset; at -= 4) {
		const count = r.u32(at);
		if (count > 0 && count <= roomCount && at + 4 + 4 * count === gen8.offset + gen8.size) {
			return Array.from({ length: count }, (_, i) => r.u32(at + 4 + 4 * i));
		}
	}
	throw new Error('data.win: room order not found');
}

function readPaths(r: BinaryReader, chunk: Chunk): Path[] {
	return r.pointerList(chunk.offset).map((at, index) => {
		const count = r.u32(at + 16);
		return {
			index,
			name: r.string(r.u32(at)),
			smooth: r.u32(at + 4) !== 0,
			closed: r.u32(at + 8) !== 0,
			precision: r.u32(at + 12),
			points: Array.from({ length: count }, (_, i) => ({
				x: r.f32(at + 20 + 12 * i),
				y: r.f32(at + 24 + 12 * i),
				speed: r.f32(at + 28 + 12 * i),
			})),
		};
	});
}

function readCode(r: BinaryReader, chunk: Chunk): CodeEntry[] {
	return r.pointerList(chunk.offset).map((at, index) => {
		// The bytecode address is stored relative to the field itself.
		const relative = r.i32(at + 12);
		return {
			index,
			name: r.string(r.u32(at)),
			length: r.u32(at + 4),
			locals: r.u16(at + 8),
			arguments: r.u16(at + 10) & 0x7fff,
			start: at + 12 + relative + r.u32(at + 16),
		};
	});
}

/**
 * Each variable lists the first instruction that references it; each reference's operand holds the
 * distance to the next one. Walk those chains to map instruction addresses to variables.
 */
function readVariableRefs(r: BinaryReader, chunk: Chunk): Map<number, Variable> {
	const refs = new Map<number, Variable>();
	const count = Math.floor((chunk.size - 12) / 20);
	for (let i = 0; i < count; i++) {
		const at = chunk.offset + 12 + 20 * i;
		const variable: Variable = { name: r.string(r.u32(at)), instanceType: r.i32(at + 4), varId: r.i32(at + 8) };
		let address = r.i32(at + 16);
		for (let n = r.u32(at + 12); n > 0; n--) {
			refs.set(address, variable);
			address += r.u32(address + 4) & 0x07ffffff;
		}
	}
	return refs;
}

function readFunctionRefs(r: BinaryReader, chunk: Chunk): Map<number, string> {
	const refs = new Map<number, string>();
	const count = r.u32(chunk.offset);
	for (let i = 0; i < count; i++) {
		const at = chunk.offset + 4 + 12 * i;
		const name = r.string(r.u32(at));
		let address = r.i32(at + 8);
		for (let n = r.u32(at + 4); n > 0; n--) {
			refs.set(address, name);
			address += r.u32(address + 4) & 0x07ffffff;
		}
	}
	return refs;
}
