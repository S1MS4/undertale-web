import type { DataWin, Room, Sprite, TexturePageItem } from '../data/DataWin.ts';
import type { Renderer, Surface } from '../render/Renderer.ts';
import type { AudioEngine } from './audio.ts';
import { BUILTINS } from './builtins.ts';
import { GLOBAL_VARS, INSTANCE_VARS } from './builtinVars.ts';
import type { GameFiles } from './files.ts';
import type { GameInput } from './input.ts';
import { Instance } from './Instance.ts';
import { type Frame, type Host, Interpreter } from './Interpreter.ts';
import { GMArray, toNumber, type Value } from './values.ts';

// Instance-type operands and keywords.
export const SELF = -1;
export const OTHER = -2;
export const ALL = -3;
export const NOONE = -4;
export const GLOBAL = -5;
export const LOCAL = -7;

// Event types and the "other" event numbers the runtime raises.
export const EV = { CREATE: 0, DESTROY: 1, ALARM: 2, STEP: 3, COLLISION: 4, KEYBOARD: 5, MOUSE: 6, OTHER: 7, DRAW: 8, KEYPRESS: 9, KEYRELEASE: 10 };
export const OTHER_EV = { OUTSIDE: 0, GAME_START: 2, GAME_END: 3, ROOM_START: 4, ROOM_END: 5, ANIMATION_END: 7, PATH_END: 8, USER0: 10 };
export const DRAW_EV = { DRAW: 0, GUI: 64, BEGIN: 72, END: 73, GUI_BEGIN: 74, GUI_END: 75, PRE: 76, POST: 77 };

const FIRST_DYNAMIC_ID = 100000;
const VIEW_COUNT = 8;

interface EventRef {
	code: number;
	/** The object that defines the event, for event_inherited(). */
	owner: number;
}

/** Merged event table of an object and its ancestors: type -> subtype -> event. */
type EventTable = Map<number, Map<number, EventRef>>;

export interface View {
	visible: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	portX: number;
	portY: number;
	portW: number;
	portH: number;
	angle: number;
	borderX: number;
	borderY: number;
	speedX: number;
	speedY: number;
	object: number;
}

export interface RoomBackgroundState {
	visible: boolean;
	foreground: boolean;
	index: number;
	x: number;
	y: number;
	tileX: boolean;
	tileY: boolean;
	xscale: number;
	yscale: number;
	hspeed: number;
	vspeed: number;
	blend: number;
	alpha: number;
}

export interface TileState {
	x: number;
	y: number;
	background: number;
	sourceX: number;
	sourceY: number;
	width: number;
	height: number;
	depth: number;
	scaleX: number;
	scaleY: number;
	color: number;
	alpha: number;
	visible: boolean;
}

/** view x, y, w, h, then port x, y, w, h, as passed to Renderer.setView. */
type ViewTransform = [number, number, number, number, number, number, number, number];

export interface Bounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface GameServices {
	renderer: Renderer;
	audio: AudioEngine;
	files: GameFiles;
	input: GameInput;
	/** game_end(): back to the launcher. */
	onEnd: () => void;
}

/** A running game: rooms, instances, events, and the per-step order GameMaker 1.4 uses. */
export class Game implements Host {
	readonly data: DataWin;
	readonly renderer: Renderer;
	readonly audio: AudioEngine;
	readonly files: GameFiles;
	readonly input: GameInput;
	readonly interp: Interpreter;
	readonly globals = new Map<string, Value>();

	instances: Instance[] = [];
	private readonly byId = new Map<number, Instance>();
	private readonly descendants: Set<number>[];
	private readonly eventTables: (EventTable | undefined)[] = [];
	/** Global scope for room creation code and the like. */
	private readonly globalSelf: Instance;
	private nextId: number;
	private nextOrder = 0;

	room!: Room;
	roomIndex = -1;
	roomSpeed = 30;
	roomWidth = 0;
	roomHeight = 0;
	roomPersistent = false;
	private readonly persistentRooms = new Map<number, Instance[]>();
	private pendingRoom: number | null = null;
	private pendingRestart = false;
	ended = false;
	private readonly onEnd: () => void;

	backgroundColor = 0;
	showBackgroundColor = true;
	viewsEnabled = false;
	viewCurrent = 0;
	views: View[] = [];
	backgrounds: RoomBackgroundState[] = [];
	tiles: TileState[] = [];

	// Draw state.
	drawColor = 0xffffff;
	drawAlpha = 1;
	drawFont = -1;
	halign = 0;
	valign = 0;
	circlePrecision = 24;

	readonly surfaces = new Map<number, Surface>();
	private nextSurface = 1;
	/** application_surface: the frame is drawn here, then copied to the canvas. */
	readonly appSurfaceId = 0;
	appSurfaceEnabled = true;
	appSurfaceDraw = true;
	/** Object indices whose instances' Draw events are measured: each frame `measured` holds the canvas area each drew. */
	measureObjects: number[] = [];
	readonly measured = new Map<number, Bounds>();
	/** How the last frame mapped the room onto the canvas (its first view), for placing overlays on objects. */
	private sceneView: ViewTransform | null = null;

	readonly dsMaps = new Map<number, Map<string | number, Value>>();
	nextDsMap = 0;
	actionRelative = false;
	/** Tile layers hidden or shifted by depth. */
	readonly hiddenTileDepths = new Set<number>();

	/** random_set_seed / random_get_seed: the game's random numbers come from this seeded generator. */
	randomSeed = (Math.random() * 0x100000000) >>> 0;
	private randomState = this.randomSeed;

	/**
	 * Development hook for the autoplayer: moves one instance at the start of the next step, just after
	 * xprevious is recorded (as walking does), and skips its collisions with `through` (walls), so
	 * triggers that push it back to xprevious, or carry it off, behave as in real play.
	 */
	ghostMove: { inst: Instance; dx: number; dy: number; through: number[] } | null = null;

	/** current_time and get_timer: tests count them in game steps (30 a second) from this step, so runs repeat exactly. */
	fixedClockFrom: number | null = null;
	private readonly startTime = performance.now();

	private readonly warned = new Set<string>();
	frameCount = 0;
	private readonly outside = new WeakSet<Instance>();

	/** Milliseconds since the game started. */
	elapsedMs(): number {
		return this.fixedClockFrom !== null ? ((this.frameCount - this.fixedClockFrom) * 1000) / 30 : performance.now() - this.startTime;
	}

	setRandomSeed(seed: number): void {
		this.randomSeed = seed >>> 0;
		this.randomState = this.randomSeed;
	}

	/** A number in [0, 1) (mulberry32). */
	random(): number {
		let t = (this.randomState = (this.randomState + 0x6d2b79f5) >>> 0);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
	}

	constructor(data: DataWin, services: GameServices) {
		this.data = data;
		this.renderer = services.renderer;
		this.audio = services.audio;
		this.files = services.files;
		this.input = services.input;
		this.onEnd = services.onEnd;
		this.interp = new Interpreter(data, this);

		this.descendants = data.objects.map(() => new Set<number>());
		for (const obj of data.objects) {
			for (let o = obj.index, guard = 0; o >= 0 && guard < 64; o = data.objects[o].parent, guard++) this.descendants[o].add(obj.index);
		}
		const maxRoomId = Math.max(FIRST_DYNAMIC_ID, ...data.rooms.flatMap((r) => r.instances.map((i) => i.id)));
		this.nextId = maxRoomId + 1;
		this.globalSelf = new Instance(-1, { index: -1, name: '<global>', sprite: -1, visible: false, solid: false, depth: 0, persistent: false, parent: -1, mask: -1, events: new Map() }, 0, 0, -1);

		for (let i = 0; i < VIEW_COUNT; i++) this.views.push(blankView());
		for (let i = 0; i < 8; i++) this.backgrounds.push(blankBackground());

		const appSurface = this.renderer.createSurface(this.renderer.width, this.renderer.height);
		this.surfaces.set(this.appSurfaceId, appSurface);
	}

	start(): void {
		this.enterRoom(this.data.roomOrder[0], true);
	}

	// ---------------------------------------------------------------- variables

	getVar(frame: Frame, target: Value, name: string, index?: number): Value {
		const t = typeof target === 'number' ? target : toNumber(target);
		if (t === LOCAL) return element(frame.locals.get(name), index);
		if (t === GLOBAL) return element(this.globals.get(name), index);

		const global = GLOBAL_VARS[name];
		if (global) return global.get(this, frame, index);
		if (name.startsWith('argument')) {
			if (name === 'argument') return frame.args[index ?? 0];
			if (name === 'argument_count') return frame.args.length;
			const n = Number(name.slice(8));
			if (Number.isInteger(n)) return frame.args[n] ?? 0;
		}

		const inst = this.resolveOne(frame, t);
		if (!inst) {
			this.warn(`read ${name} on missing instance ${t}`);
			// GameMaker stops with an error here. For a position, keep the reader's own so code like
			// `x = obj_markerX.x` (a room entered by a door it has no marker for) leaves the player in the
			// room instead of at 0,0 outside it.
			if (name === 'x' || name === 'y') return INSTANCE_VARS[name].get(frame.self, this, index);
			return 0;
		}
		const builtin = INSTANCE_VARS[name];
		if (builtin) return builtin.get(inst, this, index);
		const value = inst.vars.get(name);
		if (value === undefined && !inst.vars.has(name)) {
			this.warn(`read of unset variable ${name} (${inst.object.name})`);
			return 0;
		}
		return element(value, index);
	}

	setVar(frame: Frame, target: Value, name: string, value: Value, index?: number): void {
		if (value instanceof GMArray && index === undefined) value = value.clone();
		const t = typeof target === 'number' ? target : toNumber(target);
		if (t === LOCAL) return assign(frame.locals, name, value, index);
		if (t === GLOBAL) return assign(this.globals, name, value, index);

		const global = GLOBAL_VARS[name];
		if (global) {
			if (global.set) global.set(this, frame, value, index);
			return;
		}
		if (name.startsWith('argument')) {
			const n = name === 'argument' ? (index ?? 0) : Number(name.slice(8));
			if (Number.isInteger(n)) frame.args[n] = value;
			return;
		}

		const builtin = INSTANCE_VARS[name];
		for (const inst of this.resolveAll(frame, t)) {
			if (builtin) builtin.set?.(inst, value, this, index);
			else assign(inst.vars, name, value, index);
		}
	}

	withTargets(frame: Frame, target: Value): Instance[] {
		return this.resolveAll(frame, toNumber(target));
	}

	/** The single instance a variable read refers to. */
	resolveOne(frame: Frame, t: number): Instance | null {
		if (t === SELF) return frame.self;
		if (t === OTHER) return frame.other;
		if (t === ALL) return this.instances.find((i) => i.active && !i.destroyed) ?? null;
		if (t >= FIRST_DYNAMIC_ID) {
			const inst = this.byId.get(t);
			return inst && !inst.destroyed ? inst : null;
		}
		if (t >= 0 && t < this.data.objects.length) return this.instancesOf(t)[0] ?? null;
		return null;
	}

	/** Every instance a write or `with` refers to. */
	resolveAll(frame: Frame, t: number): Instance[] {
		if (t === SELF) return [frame.self];
		if (t === OTHER) return [frame.other];
		if (t === ALL) return this.instances.filter((i) => i.active && !i.destroyed);
		if (t >= FIRST_DYNAMIC_ID) {
			const inst = this.byId.get(t);
			return inst && !inst.destroyed && inst.active ? [inst] : [];
		}
		if (t >= 0 && t < this.data.objects.length) return this.instancesOf(t);
		return [];
	}

	instancesOf(objectIndex: number): Instance[] {
		const set = this.descendants[objectIndex];
		if (!set) return [];
		return this.instances.filter((i) => i.active && !i.destroyed && set.has(i.object.index));
	}

	isA(inst: Instance, objectIndex: number): boolean {
		return this.descendants[objectIndex]?.has(inst.object.index) ?? false;
	}

	findInstance(id: number): Instance | null {
		const inst = this.byId.get(id);
		return inst && !inst.destroyed ? inst : null;
	}

	// ---------------------------------------------------------------- calls and events

	call(frame: Frame, name: string, args: Value[]): Value {
		const script = this.data.scripts.get(name);
		if (script !== undefined) return this.callScript(frame, script, args);
		const fn = BUILTINS[name];
		if (fn) return fn(this, frame, args) as Value;
		this.warn(`unimplemented function ${name}`);
		return 0;
	}

	callScript(frame: Frame, codeId: number, args: Value[]): Value {
		return this.interp.run(codeId, { self: frame.self, other: frame.other, locals: new Map(), args, event: frame.event });
	}

	/** Runs top-level code (an event, creation code), reporting errors without stopping the game. */
	runCode(codeId: number, self: Instance, other: Instance, event: Frame['event'] = null): Value {
		try {
			return this.interp.run(codeId, { self, other, locals: new Map(), args: [], event });
		} catch (err) {
			this.warn(`error in ${this.data.code[codeId]?.name}: ${(err as Error).message}`);
			return undefined;
		}
	}

	eventTable(objectIndex: number): EventTable {
		let table = this.eventTables[objectIndex];
		if (table) return table;
		const obj = this.data.objects[objectIndex];
		table = new Map();
		if (obj.parent >= 0) {
			for (const [type, subs] of this.eventTable(obj.parent)) table.set(type, new Map(subs));
		}
		for (const [type, subs] of obj.events) {
			let merged = table.get(type);
			if (!merged) table.set(type, (merged = new Map()));
			for (const [subtype, code] of subs) merged.set(subtype, { code, owner: objectIndex });
		}
		this.eventTables[objectIndex] = table;
		return table;
	}

	hasEvent(inst: Instance, type: number, subtype: number): boolean {
		return this.eventTable(inst.object.index).get(type)?.has(subtype) ?? false;
	}

	runEvent(inst: Instance, type: number, subtype: number, other: Instance = inst): boolean {
		if (inst.destroyed && type !== EV.DESTROY) return false;
		const ev = this.eventTable(inst.object.index).get(type)?.get(subtype);
		if (!ev) return false;
		this.runCode(ev.code, inst, other, { type, subtype, owner: ev.owner });
		return true;
	}

	/** event_inherited(): the parent's version of the event being run. */
	runInherited(frame: Frame): void {
		const ev = frame.event;
		if (!ev) return;
		const parent = this.data.objects[ev.owner]?.parent ?? -1;
		if (parent < 0) return;
		const inherited = this.eventTable(parent).get(ev.type)?.get(ev.subtype);
		if (!inherited) return;
		this.interp.run(inherited.code, {
			self: frame.self,
			other: frame.other,
			locals: new Map(),
			args: [],
			event: { type: ev.type, subtype: ev.subtype, owner: inherited.owner },
		});
	}

	// ---------------------------------------------------------------- instances

	createInstance(x: number, y: number, objectIndex: number, id = this.nextId++): Instance {
		const obj = this.data.objects[objectIndex];
		const inst = new Instance(id, obj, x, y, this.nextOrder++);
		this.instances.push(inst);
		this.byId.set(inst.id, inst);
		return inst;
	}

	/** instance_create: create, then run the create event straight away. */
	spawn(x: number, y: number, objectIndex: number): Instance | null {
		if (!this.data.objects[objectIndex]) return null;
		const inst = this.createInstance(x, y, objectIndex);
		this.runEvent(inst, EV.CREATE, 0);
		return inst;
	}

	destroy(inst: Instance, runEvent = true): void {
		if (inst.destroyed) return;
		inst.destroyed = true;
		if (runEvent) this.runEvent(inst, EV.DESTROY, 0);
	}

	/** instance_change: become another object, optionally running destroy/create. */
	changeInstance(inst: Instance, objectIndex: number, perform: boolean): void {
		if (perform) this.runEvent(inst, EV.DESTROY, 0);
		const obj = this.data.objects[objectIndex];
		if (!obj) return;
		inst.object = obj;
		inst.sprite = obj.sprite;
		inst.mask = obj.mask;
		inst.depth = obj.depth;
		inst.visible = obj.visible;
		inst.solid = obj.solid;
		inst.persistent = obj.persistent;
		if (perform) this.runEvent(inst, EV.CREATE, 0);
	}

	private sweep(): void {
		if (!this.instances.some((i) => i.destroyed)) return;
		this.instances = this.instances.filter((i) => {
			if (i.destroyed) this.byId.delete(i.id);
			return !i.destroyed;
		});
	}

	/** Live instances at this moment; events may add or destroy instances while it's iterated. */
	private live(): Instance[] {
		return this.instances.filter((i) => i.active && !i.destroyed);
	}

	// ---------------------------------------------------------------- rooms

	gotoRoom(index: number): void {
		if (this.data.rooms[index]) this.pendingRoom = index;
	}

	restart(): void {
		this.pendingRestart = true;
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const inst of this.live()) this.runEvent(inst, EV.OTHER, OTHER_EV.GAME_END);
		this.audio.stopAll();
		this.onEnd();
	}

	private enterRoom(index: number, first: boolean): void {
		if (this.roomIndex >= 0) {
			for (const inst of this.live()) this.runEvent(inst, EV.OTHER, OTHER_EV.ROOM_END);
			if (this.roomPersistent) {
				this.persistentRooms.set(this.roomIndex, this.instances.filter((i) => !i.persistent && !i.destroyed));
			}
		}
		const kept = this.instances.filter((i) => i.persistent && !i.destroyed);
		this.instances = kept;
		this.byId.clear();
		for (const inst of kept) this.byId.set(inst.id, inst);

		const room = this.data.rooms[index];
		this.room = room;
		this.roomIndex = index;
		this.roomSpeed = room.speed || 30;
		this.roomWidth = room.width;
		this.roomHeight = room.height;
		this.roomPersistent = room.persistent || this.persistentRooms.has(index);
		this.backgroundColor = room.backgroundColor & 0xffffff;
		this.showBackgroundColor = room.drawBackgroundColor;
		this.viewsEnabled = (room.flags & 1) !== 0 || room.views.some((v) => v.enabled);
		this.views = room.views.map((v) => ({
			visible: v.enabled,
			x: v.viewX,
			y: v.viewY,
			w: v.viewW,
			h: v.viewH,
			portX: v.portX,
			portY: v.portY,
			portW: v.portW,
			portH: v.portH,
			angle: 0,
			borderX: v.borderX,
			borderY: v.borderY,
			speedX: v.speedX,
			speedY: v.speedY,
			object: v.object,
		}));
		while (this.views.length < VIEW_COUNT) this.views.push(blankView());
		this.backgrounds = room.backgrounds.map((b) => ({
			visible: b.enabled,
			foreground: b.foreground,
			index: b.background,
			x: b.x,
			y: b.y,
			tileX: b.tileX,
			tileY: b.tileY,
			xscale: 1,
			yscale: 1,
			hspeed: b.speedX,
			vspeed: b.speedY,
			blend: 0xffffff,
			alpha: 1,
		}));
		while (this.backgrounds.length < 8) this.backgrounds.push(blankBackground());
		room.backgrounds.forEach((b, i) => {
			const bg = this.data.backgrounds[b.background];
			if (b.stretch && bg?.item) {
				this.backgrounds[i].xscale = room.width / bg.item.boundingWidth;
				this.backgrounds[i].yscale = room.height / bg.item.boundingHeight;
			}
		});
		this.tiles = room.tiles.map((t) => ({
			x: t.x,
			y: t.y,
			background: t.background,
			sourceX: t.sourceX,
			sourceY: t.sourceY,
			width: t.width,
			height: t.height,
			depth: t.depth,
			scaleX: t.scaleX,
			scaleY: t.scaleY,
			color: t.color & 0xffffff,
			alpha: (t.color >>> 24) / 255 || 1,
			visible: true,
		}));
		this.hiddenTileDepths.clear();

		const saved = this.persistentRooms.get(index);
		if (saved) {
			this.persistentRooms.delete(index);
			for (const inst of saved) {
				this.instances.push(inst);
				this.byId.set(inst.id, inst);
			}
		} else {
			const created: [Instance, (typeof room.instances)[number]][] = [];
			for (const ri of room.instances) {
				if (this.byId.has(ri.id) || !this.data.objects[ri.object]) continue;
				const inst = this.createInstance(ri.x, ri.y, ri.object, ri.id);
				inst.imageXscale = ri.scaleX;
				inst.imageYscale = ri.scaleY;
				inst.imageAngle = ri.rotation;
				inst.imageBlend = ri.color & 0xffffff;
				inst.imageAlpha = (ri.color >>> 24) / 255 || 1;
				created.push([inst, ri]);
			}
			for (const [inst, ri] of created) {
				if (ri.preCreateCode >= 0) this.runCode(ri.preCreateCode, inst, inst);
				this.runEvent(inst, EV.CREATE, 0);
				if (ri.creationCode >= 0 && !inst.destroyed) this.runCode(ri.creationCode, inst, inst);
			}
			if (room.creationCode >= 0) this.runCode(room.creationCode, this.globalSelf, this.globalSelf);
		}

		if (first) for (const inst of this.live()) this.runEvent(inst, EV.OTHER, OTHER_EV.GAME_START);
		for (const inst of this.live()) this.runEvent(inst, EV.OTHER, OTHER_EV.ROOM_START);
		this.sweep();
	}

	// ---------------------------------------------------------------- step

	/** One game step, in GameMaker 1.4's event order. */
	step(): void {
		if (this.ended) return;
		this.frameCount++;

		// xprevious/yprevious hold the position from before this step's events move anything; solid
		// collisions put instances back there, which is how walls stop the player.
		for (const inst of this.live()) {
			inst.xprevious = inst.x;
			inst.yprevious = inst.y;
		}
		const ghost = this.ghostMove;
		if (ghost && !ghost.inst.destroyed) {
			ghost.inst.x += ghost.dx;
			ghost.inst.y += ghost.dy;
		}

		for (const inst of this.live()) this.runEvent(inst, EV.STEP, 1);

		for (const inst of this.live()) {
			for (let a = 0; a < inst.alarm.length; a++) {
				if (inst.alarm[a] > 0) {
					inst.alarm[a] -= 1;
					if (inst.alarm[a] <= 0) {
						inst.alarm[a] = -1;
						this.runEvent(inst, EV.ALARM, a);
					}
				}
			}
		}

		this.keyboardEvents();

		for (const inst of this.live()) this.runEvent(inst, EV.STEP, 0);

		for (const inst of this.live()) this.move(inst);
		for (const inst of this.live()) this.checkOutside(inst);
		this.collisionEvents();

		for (const inst of this.live()) this.runEvent(inst, EV.STEP, 2);

		for (const inst of this.live()) this.animate(inst);
		for (const bg of this.backgrounds) {
			bg.x += bg.hspeed;
			bg.y += bg.vspeed;
		}
		this.followViews();
		this.sweep();
		this.ghostMove = null;
	}

	/** Room changes requested during the step happen once the frame has been drawn. */
	afterFrame(): void {
		if (this.pendingRestart) {
			this.pendingRestart = false;
			this.pendingRoom = null;
			this.audio.stopAll();
			for (const inst of this.instances) inst.destroyed = true;
			this.instances = [];
			this.byId.clear();
			this.globals.clear();
			this.persistentRooms.clear();
			this.roomIndex = -1;
			this.enterRoom(this.data.roomOrder[0], true);
			return;
		}
		if (this.pendingRoom !== null) {
			const next = this.pendingRoom;
			this.pendingRoom = null;
			this.enterRoom(next, false);
		}
	}

	private keyboardEvents(): void {
		const input = this.input;
		const kinds: [number, Iterable<number>, boolean][] = [
			[EV.KEYBOARD, input.keysDown(), true],
			[EV.KEYPRESS, input.keysPressed(), false],
			[EV.KEYRELEASE, input.keysReleased(), false],
		];
		for (const [type, keys, held] of kinds) {
			const list = [...keys];
			for (const inst of this.live()) {
				const events = this.eventTable(inst.object.index).get(type);
				if (!events) continue;
				for (const key of list) this.runEvent(inst, type, key);
				if (list.length) this.runEvent(inst, type, 1);
				else if (held) this.runEvent(inst, type, 0);
			}
		}
	}

	private move(inst: Instance): void {
		if (inst.friction !== 0) {
			const speed = inst.speed;
			if (speed > 0) {
				const next = Math.max(0, speed - inst.friction);
				inst.hspeed *= next / speed;
				inst.vspeed *= next / speed;
			}
		}
		if (inst.gravity !== 0) {
			const rad = (inst.gravityDirection * Math.PI) / 180;
			inst.hspeed += Math.cos(rad) * inst.gravity;
			inst.vspeed -= Math.sin(rad) * inst.gravity;
		}
		if (inst.path >= 0) this.followPath(inst);
		inst.x += inst.hspeed;
		inst.y += inst.vspeed;
	}

	private followPath(inst: Instance): void {
		const path = this.data.paths[inst.path];
		if (!path || path.points.length === 0) {
			inst.path = -1;
			return;
		}
		const length = pathLength(path.points, path.closed);
		if (length <= 0) return;
		inst.pathPosition += inst.pathSpeed / length;
		if (inst.pathPosition >= 1 || inst.pathPosition < 0) {
			const action = inst.pathEndAction;
			if (action === 1) inst.pathPosition = ((inst.pathPosition % 1) + 1) % 1;
			else if (action === 2) {
				// Continue: the path starts again from where it ended, so the walk carries on in the same
				// direction (Toriel heading off down the long Ruins hall until she leaves the room).
				const start = pointOnPath(path.points, path.closed, 0);
				const end = pointOnPath(path.points, path.closed, 1);
				const sign = inst.pathPosition >= 1 ? 1 : -1;
				inst.pathOrigin = { x: inst.pathOrigin.x + sign * (end.x - start.x), y: inst.pathOrigin.y + sign * (end.y - start.y) };
				inst.pathPosition = ((inst.pathPosition % 1) + 1) % 1;
			} else if (action === 3) {
				inst.pathSpeed = -inst.pathSpeed;
				inst.pathPosition = Math.min(1, Math.max(0, inst.pathPosition));
			} else {
				inst.pathPosition = Math.min(1, Math.max(0, inst.pathPosition));
				const p = pointOnPath(path.points, path.closed, inst.pathPosition);
				inst.x = p.x + inst.pathOrigin.x;
				inst.y = p.y + inst.pathOrigin.y;
				inst.path = -1;
				this.runEvent(inst, EV.OTHER, OTHER_EV.PATH_END);
				return;
			}
		}
		const p = pointOnPath(path.points, path.closed, inst.pathPosition);
		inst.x = p.x + inst.pathOrigin.x;
		inst.y = p.y + inst.pathOrigin.y;
	}

	private checkOutside(inst: Instance): void {
		if (!this.hasEvent(inst, EV.OTHER, OTHER_EV.OUTSIDE)) return;
		const b = this.bounds(inst);
		const out = b
			? b.right < 0 || b.bottom < 0 || b.left > this.roomWidth || b.top > this.roomHeight
			: inst.x < 0 || inst.y < 0 || inst.x > this.roomWidth || inst.y > this.roomHeight;
		if (out && !this.outside.has(inst)) {
			this.outside.add(inst);
			this.runEvent(inst, EV.OTHER, OTHER_EV.OUTSIDE);
		} else if (!out) {
			this.outside.delete(inst);
		}
	}

	private collisionEvents(): void {
		const ghost = this.ghostMove;
		for (const inst of this.live()) {
			const events = this.eventTable(inst.object.index).get(EV.COLLISION);
			if (!events) continue;
			for (const [target, ev] of events) {
				for (const other of this.instancesOf(target)) {
					if (other === inst || inst.destroyed || other.destroyed) continue;
					if (ghost && (inst === ghost.inst || other === ghost.inst) && ghost.through.some((o) => this.isA(inst === ghost.inst ? other : inst, o))) continue;
					if (!this.collide(inst, other)) continue;
					if (inst.solid || other.solid) {
						inst.x = inst.xprevious;
						inst.y = inst.yprevious;
						other.x = other.xprevious;
						other.y = other.yprevious;
					}
					this.runCode(ev.code, inst, other, { type: EV.COLLISION, subtype: target, owner: ev.owner });
				}
			}
		}
	}

	private animate(inst: Instance): void {
		const sprite = this.data.spriteList[inst.sprite];
		if (!sprite || inst.imageSpeed === 0) return;
		const count = sprite.frames.length;
		inst.imageIndex += inst.imageSpeed;
		if (inst.imageIndex >= count) {
			inst.imageIndex -= count;
			this.runEvent(inst, EV.OTHER, OTHER_EV.ANIMATION_END);
		} else if (inst.imageIndex < 0) {
			inst.imageIndex += count;
			this.runEvent(inst, EV.OTHER, OTHER_EV.ANIMATION_END);
		}
	}

	private followViews(): void {
		if (!this.viewsEnabled) return;
		for (const view of this.views) {
			if (!view.visible || view.object < 0) continue;
			const target = this.resolveAll(this.dummyFrame(), view.object)[0];
			if (!target) continue;
			let x = view.x;
			let y = view.y;
			if (target.x - x < view.borderX) x = target.x - view.borderX;
			if (x + view.w - target.x < view.borderX) x = target.x - view.w + view.borderX;
			if (target.y - y < view.borderY) y = target.y - view.borderY;
			if (y + view.h - target.y < view.borderY) y = target.y - view.h + view.borderY;
			x = Math.max(0, Math.min(x, this.roomWidth - view.w));
			y = Math.max(0, Math.min(y, this.roomHeight - view.h));
			if (view.speedX >= 0) x = view.x + Math.max(-view.speedX, Math.min(view.speedX, x - view.x));
			if (view.speedY >= 0) y = view.y + Math.max(-view.speedY, Math.min(view.speedY, y - view.y));
			view.x = x;
			view.y = y;
		}
	}

	dummyFrame(): Frame {
		return { self: this.globalSelf, other: this.globalSelf, locals: new Map(), args: [], event: null };
	}

	// ---------------------------------------------------------------- collisions

	/** Bounding box in room coordinates, or null without a sprite or mask. */
	/** Where a room position appeared on the canvas in the last frame drawn, or null before the first. */
	toCanvas(x: number, y: number): { x: number; y: number } | null {
		const v = this.sceneView;
		if (!v) return null;
		const [vx, vy, vw, vh, px, py, pw, ph] = v;
		return { x: (x - vx) * (vw ? pw / vw : 1) + px, y: (y - vy) * (vh ? ph / vh : 1) + py };
	}

	bounds(inst: Instance): Bounds | null {
		const sprite = this.data.spriteList[inst.mask >= 0 ? inst.mask : inst.sprite];
		if (!sprite) return null;
		const sx = inst.imageXscale;
		const sy = inst.imageYscale;
		const corners = [
			[sprite.bboxLeft - sprite.originX, sprite.bboxTop - sprite.originY],
			[sprite.bboxRight + 1 - sprite.originX, sprite.bboxTop - sprite.originY],
			[sprite.bboxLeft - sprite.originX, sprite.bboxBottom + 1 - sprite.originY],
			[sprite.bboxRight + 1 - sprite.originX, sprite.bboxBottom + 1 - sprite.originY],
		];
		const rad = (-inst.imageAngle * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (const [cx, cy] of corners) {
			const px = cx * sx;
			const py = cy * sy;
			const x = inst.x + px * cos - py * sin;
			const y = inst.y + px * sin + py * cos;
			left = Math.min(left, x);
			right = Math.max(right, x);
			top = Math.min(top, y);
			bottom = Math.max(bottom, y);
		}
		return { left, top, right, bottom };
	}

	/** Whether a room point is inside the instance's mask (precise masks checked per pixel). */
	pointInside(inst: Instance, x: number, y: number, precise = true): boolean {
		const b = this.bounds(inst);
		if (!b || x < b.left || x >= b.right || y < b.top || y >= b.bottom) return false;
		const sprite = this.data.spriteList[inst.mask >= 0 ? inst.mask : inst.sprite];
		if (!precise || !sprite || sprite.collisionKind !== 1 || sprite.masks.length === 0) return true;
		return maskHit(sprite, inst, x, y);
	}

	collide(a: Instance, b: Instance): boolean {
		const ba = this.bounds(a);
		const bb = this.bounds(b);
		if (!ba || !bb) return false;
		const left = Math.max(ba.left, bb.left);
		const right = Math.min(ba.right, bb.right);
		const top = Math.max(ba.top, bb.top);
		const bottom = Math.min(ba.bottom, bb.bottom);
		if (left >= right || top >= bottom) return false;
		const sa = this.data.spriteList[a.mask >= 0 ? a.mask : a.sprite];
		const sb = this.data.spriteList[b.mask >= 0 ? b.mask : b.sprite];
		const preciseA = sa?.collisionKind === 1 && sa.masks.length > 0;
		const preciseB = sb?.collisionKind === 1 && sb.masks.length > 0;
		if (!preciseA && !preciseB) return true;
		for (let y = Math.floor(top); y < bottom; y++) {
			for (let x = Math.floor(left); x < right; x++) {
				const px = x + 0.5;
				const py = y + 0.5;
				if (px < left || py < top) continue;
				if ((!preciseA || maskHit(sa, a, px, py)) && (!preciseB || maskHit(sb, b, px, py))) return true;
			}
		}
		return false;
	}

	/** First instance of `objectIndex` matching `test`, for the collision_* functions. */
	findCollision(frame: Frame, objectIndex: number, notMe: boolean, test: (inst: Instance) => boolean): number {
		for (const inst of this.resolveAll(frame, objectIndex)) {
			if (notMe && inst === frame.self) continue;
			if (test(inst)) return inst.id;
		}
		return NOONE;
	}

	// ---------------------------------------------------------------- drawing

	/**
	 * The canvas follows the window's shape; the game still thinks in its own 640x480. Views are drawn
	 * widened by the extra space on each side, so the game's own layout stays centred and the sides show
	 * more of the room instead of stretching the picture.
	 */
	draw(): void {
		const r = this.renderer;
		this.measured.clear();
		this.sceneView = null;
		const logicalW = this.data.windowWidth;
		const logicalH = this.data.windowHeight;
		const extraX = Math.max(0, (r.width - logicalW) / 2);
		const extraY = Math.max(0, (r.height - logicalH) / 2);
		const screen: ViewTransform = [-extraX, -extraY, r.width, r.height, 0, 0, r.width, r.height];

		let appSurface = this.surfaces.get(this.appSurfaceId)!;
		if (appSurface.width !== r.width || appSurface.height !== r.height) {
			r.freeSurface(appSurface);
			appSurface = r.createSurface(r.width, r.height);
			this.surfaces.set(this.appSurfaceId, appSurface);
		}
		const useApp = this.appSurfaceEnabled;

		const screenArea: [number, number, number, number] = [0, 0, logicalW, logicalH];
		r.setTarget(null);
		this.activeTransform = screen;
		this.logicalArea = screenArea;
		this.applyView();
		this.drawEvent(DRAW_EV.PRE);

		r.setTarget(useApp ? appSurface : null);
		if (this.showBackgroundColor) r.clear(this.backgroundColor, 1);
		const views = this.viewsEnabled ? this.views.map((v, i) => [v, i] as const).filter(([v]) => v.visible) : [];
		if (views.length === 0) {
			this.viewCurrent = 0;
			this.activeTransform = screen;
			this.logicalArea = screenArea;
			this.applyView();
			this.sceneView = screen;
			this.drawScene();
		} else {
			for (const [view, index] of views) {
				this.viewCurrent = index;
				const sx = view.w ? view.portW / view.w : 1;
				const sy = view.h ? view.portH / view.h : 1;
				const mx = extraX / sx;
				const my = extraY / sy;
				this.activeTransform = [view.x - mx, view.y - my, view.w + 2 * mx, view.h + 2 * my, view.portX, view.portY, view.portW + 2 * extraX, view.portH + 2 * extraY];
				this.logicalArea = [view.x, view.y, view.w, view.h];
				this.applyView();
				this.sceneView ??= this.activeTransform;
				this.drawScene();
			}
		}
		this.targetStack.length = 0;
		r.setTarget(null);
		r.resetView();

		if (useApp && this.appSurfaceDraw) {
			r.drawPage(appSurface, 0, 0, appSurface.width, appSurface.height, 0, 0, r.width, r.height, 0xffffff, 1);
		}
		this.activeTransform = screen;
		this.logicalArea = screenArea;
		this.applyView();
		this.drawEvent(DRAW_EV.POST);
		this.drawEvent(DRAW_EV.GUI_BEGIN);
		this.drawEvent(DRAW_EV.GUI);
		this.drawEvent(DRAW_EV.GUI_END);
		this.activeTransform = null;
		this.logicalArea = null;
		r.resetView();
	}

	private drawEvent(subtype: number): void {
		for (const inst of this.sortedForDraw()) {
			if (inst.visible) this.runEvent(inst, EV.DRAW, subtype);
		}
	}

	private sortedForDraw(): Instance[] {
		return this.live().sort((a, b) => b.depth - a.depth || a.order - b.order);
	}

	private drawScene(): void {
		this.drawBackgrounds(false);
		const items: { depth: number; order: number; draw: () => void }[] = [];
		for (const inst of this.live()) {
			if (!inst.visible) continue;
			items.push({
				depth: inst.depth,
				order: inst.order,
				draw: () => {
					const measure = this.measureObjects.find((o) => this.isA(inst, o));
					if (measure !== undefined) {
						let area = this.measured.get(measure);
						if (!area) this.measured.set(measure, (area = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }));
						this.renderer.bounds = area;
					}
					if (!this.runEvent(inst, EV.DRAW, DRAW_EV.DRAW)) this.drawSelf(inst);
					this.renderer.bounds = null;
				},
			});
		}
		for (const tile of this.tiles) {
			if (!tile.visible || this.hiddenTileDepths.has(tile.depth)) continue;
			items.push({ depth: tile.depth, order: -1, draw: () => this.drawTile(tile) });
		}
		items.sort((a, b) => b.depth - a.depth || a.order - b.order);
		for (const inst of this.sortedForDraw()) if (inst.visible) this.runEvent(inst, EV.DRAW, DRAW_EV.BEGIN);
		for (const item of items) item.draw();
		for (const inst of this.sortedForDraw()) if (inst.visible) this.runEvent(inst, EV.DRAW, DRAW_EV.END);
		this.drawBackgrounds(true);
	}

	drawSelf(inst: Instance): void {
		const sprite = this.data.spriteList[inst.sprite];
		if (!sprite) return;
		this.drawSprite(sprite, inst.imageIndex, inst.x, inst.y, inst.imageXscale, inst.imageYscale, inst.imageAngle, inst.imageBlend, inst.imageAlpha);
	}

	drawSprite(sprite: Sprite, frame: number, x: number, y: number, xs: number, ys: number, angle: number, color: number, alpha: number): void {
		if (sprite.frames.length === 0) return;
		const n = sprite.frames.length;
		const item = sprite.frames[((Math.floor(frame) % n) + n) % n];
		this.drawItem(item, x, y, sprite.originX, sprite.originY, xs, ys, angle, color, alpha);
	}

	/** A texture item placed with an origin, scale and rotation, like draw_sprite_ext. */
	drawItem(item: TexturePageItem, x: number, y: number, ox: number, oy: number, xs: number, ys: number, angle: number, color: number, alpha: number): void {
		const left = (item.targetX - ox) * xs;
		const top = (item.targetY - oy) * ys;
		const right = (item.targetX + item.targetWidth - ox) * xs;
		const bottom = (item.targetY + item.targetHeight - oy) * ys;
		// A small sprite (a fader's solid square) stretched over the whole view is a fade or a flash: widen
		// it to the window's sides like full-screen rectangles, sampling one texel so it stays a flat fill.
		if (angle === 0 && item.sourceWidth <= 32 && item.sourceHeight <= 32) {
			const box: [number, number, number, number] = [x + Math.min(left, right), y + Math.min(top, bottom), x + Math.max(left, right), y + Math.max(top, bottom)];
			const [l, t, r, b] = this.coverArea(...box);
			if (l !== box[0] || t !== box[1] || r !== box[2] || b !== box[3]) {
				const sx = item.sourceX + item.sourceWidth / 2;
				const sy = item.sourceY + item.sourceHeight / 2;
				this.renderer.quad(item.page, sx, sy, 0.01, 0.01, [{ x: l, y: t }, { x: r, y: t }, { x: l, y: b }, { x: r, y: b }], [color, color, color, color], alpha);
				return;
			}
		}
		const corners = [
			[left, top],
			[right, top],
			[left, bottom],
			[right, bottom],
		].map(([px, py]) => rotate(x, y, px, py, angle));
		this.renderer.quad(item.page, item.sourceX, item.sourceY, item.sourceWidth, item.sourceHeight, corners, [color, color, color, color], alpha);
	}

	private drawTile(tile: TileState): void {
		const bg = this.data.backgrounds[tile.background];
		if (!bg?.item) return;
		const item = bg.item;
		this.renderer.drawRegion(
			item.page,
			item.sourceX + tile.sourceX - item.targetX,
			item.sourceY + tile.sourceY - item.targetY,
			tile.width,
			tile.height,
			tile.x,
			tile.y,
			tile.width * tile.scaleX,
			tile.height * tile.scaleY,
			tile.color,
			tile.alpha,
		);
	}

	private drawBackgrounds(foreground: boolean): void {
		for (const bg of this.backgrounds) {
			if (!bg.visible || bg.foreground !== foreground) continue;
			const def = this.data.backgrounds[bg.index];
			if (!def?.item) continue;
			const item = def.item;
			const w = item.boundingWidth * bg.xscale;
			const h = item.boundingHeight * bg.yscale;
			if (w <= 0 || h <= 0) continue;
			// Tile across the area actually on screen (the widened view).
			const t = this.activeTransform;
			const areaX = t ? t[0] : 0;
			const areaY = t ? t[1] : 0;
			const areaW = t ? t[2] : this.roomWidth;
			const areaH = t ? t[3] : this.roomHeight;
			const startX = bg.tileX ? bg.x - Math.ceil((bg.x - areaX) / w) * w : bg.x;
			const startY = bg.tileY ? bg.y - Math.ceil((bg.y - areaY) / h) * h : bg.y;
			for (let y = startY; y < (bg.tileY ? areaY + areaH : startY + 1); y += h) {
				for (let x = startX; x < (bg.tileX ? areaX + areaW : startX + 1); x += w) {
					this.drawItem(item, x, y, 0, 0, bg.xscale, bg.yscale, 0, bg.blend, bg.alpha);
				}
			}
		}
	}

	// ---------------------------------------------------------------- surfaces

	/** The transform being drawn with, so it can be restored after drawing to a surface. */
	private activeTransform: ViewTransform | null = null;
	/** The game's own visible area (x, y, w, h) while drawing, before widening to the window's shape. */
	private logicalArea: [number, number, number, number] | null = null;

	/**
	 * A filled rectangle covering the whole of the game's visible area is a full-screen fill (a flash or
	 * a fade). Widen it to the window's sides too, so they don't stay uncovered.
	 */
	coverArea(left: number, top: number, right: number, bottom: number): [number, number, number, number] {
		const area = this.logicalArea;
		const t = this.activeTransform;
		if (!area || !t || this.targetStack.length) return [left, top, right, bottom];
		const [x, y, w, h] = area;
		if (left > x + 1 || top > y + 1 || right < x + w - 1 || bottom < y + h - 1) return [left, top, right, bottom];
		return [Math.min(left, t[0]), Math.min(top, t[1]), Math.max(right, t[0] + t[2]), Math.max(bottom, t[1] + t[3])];
	}
	private readonly targetStack: (Surface | null)[] = [];

	/** surface_set_target: draw in the surface's own coordinates until reset. */
	pushTarget(surface: Surface): void {
		this.targetStack.push(this.renderer.getTarget());
		this.renderer.setTarget(surface);
		this.renderer.resetView();
	}

	popTarget(): void {
		if (!this.targetStack.length) return;
		this.renderer.setTarget(this.targetStack.pop() ?? null);
		if (this.targetStack.length === 0) this.applyView();
	}

	private applyView(): void {
		const t = this.activeTransform;
		if (t) this.renderer.setView(...t);
		else this.renderer.resetView();
	}

	/** sprite_create_from_surface: copies part of a surface into a new single-frame sprite. */
	spriteFromSurface(id: number, x: number, y: number, w: number, h: number, ox: number, oy: number): number {
		const source = this.surfaces.get(id);
		if (!source || w <= 0 || h <= 0) return -1;
		const copy = this.renderer.createSurface(Math.floor(w), Math.floor(h));
		const previous = this.renderer.getTarget();
		this.renderer.setTarget(copy);
		this.renderer.resetView();
		this.renderer.drawPage(source, x, y, w, h, 0, 0, w, h, 0xffffff, 1);
		this.renderer.setTarget(previous);
		this.applyView();
		const page = this.renderer.registerPage(copy);
		const index = this.data.spriteList.length;
		const item: TexturePageItem = { sourceX: 0, sourceY: 0, sourceWidth: w, sourceHeight: h, targetX: 0, targetY: 0, targetWidth: w, targetHeight: h, boundingWidth: w, boundingHeight: h, page };
		this.data.spriteList.push({ index, name: `__surface_sprite_${index}`, width: w, height: h, originX: ox, originY: oy, bboxLeft: 0, bboxRight: w - 1, bboxTop: 0, bboxBottom: h - 1, bboxMode: 1, collisionKind: 0, frames: [item], masks: [] });
		return index;
	}

	deleteSprite(index: number): void {
		const sprite = this.data.spriteList[index];
		// Only sprites made at runtime can be deleted; their slot stays so indices don't shift.
		if (sprite?.name.startsWith('__surface_sprite_')) sprite.frames = [];
	}

	/** First instance of `objectIndex` the caller would touch at (x, y). */
	placeCollision(frame: Frame, x: number, y: number, objectIndex: number, solidOnly = false): number {
		const self = frame.self;
		const ox = self.x;
		const oy = self.y;
		self.x = x;
		self.y = y;
		try {
			return this.findCollision(frame, objectIndex, true, (o) => (!solidOnly || o.solid) && this.collide(self, o));
		} finally {
			self.x = ox;
			self.y = oy;
		}
	}

	/**
	 * collision_rectangle's test. The rectangle is inclusive (it covers pixels left..right, top..bottom);
	 * bounds are exclusive on the right and bottom, so touching edges don't count as overlapping.
	 */
	rectOverlaps(inst: Instance, left: number, top: number, right: number, bottom: number, precise: boolean): boolean {
		const bb = this.bounds(inst);
		if (!bb || bb.left >= right + 1 || bb.right <= left || bb.top >= bottom + 1 || bb.bottom <= top) return false;
		const sprite = this.data.spriteList[inst.mask >= 0 ? inst.mask : inst.sprite];
		if (!precise || !sprite || sprite.collisionKind !== 1 || sprite.masks.length === 0) return true;
		for (let y = Math.max(Math.floor(top), Math.floor(bb.top)); y <= Math.min(bottom, bb.bottom - 1); y++) {
			for (let x = Math.max(Math.floor(left), Math.floor(bb.left)); x <= Math.min(right, bb.right - 1); x++) {
				if (maskHit(sprite, inst, x + 0.5, y + 0.5)) return true;
			}
		}
		return false;
	}

	createSurface(w: number, h: number): number {
		const id = this.nextSurface++;
		this.surfaces.set(id, this.renderer.createSurface(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))));
		return id;
	}

	freeSurface(id: number): void {
		const s = this.surfaces.get(id);
		if (!s || id === this.appSurfaceId) return;
		this.renderer.freeSurface(s);
		this.surfaces.delete(id);
	}

	// ---------------------------------------------------------------- diagnostics

	warn(message: string): void {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		if (this.warned.size < 400) console.warn(`[game] ${message}`);
	}

	get warnings(): string[] {
		return [...this.warned];
	}
}

function element(value: Value, index: number | undefined): Value {
	if (index === undefined) return value;
	if (value instanceof GMArray) return value.get(index) ?? 0;
	return index === 0 ? value : 0;
}

function assign(map: Map<string, Value>, name: string, value: Value, index: number | undefined): void {
	if (index === undefined) {
		map.set(name, value);
		return;
	}
	let arr = map.get(name);
	if (!(arr instanceof GMArray)) {
		const scalar = arr;
		arr = new GMArray();
		if (scalar !== undefined) arr.set(0, scalar);
		map.set(name, arr);
	}
	arr.set(index, value);
}

function blankView(): View {
	return { visible: false, x: 0, y: 0, w: 640, h: 480, portX: 0, portY: 0, portW: 640, portH: 480, angle: 0, borderX: 0, borderY: 0, speedX: -1, speedY: -1, object: -1 };
}

function blankBackground(): RoomBackgroundState {
	return { visible: false, foreground: false, index: -1, x: 0, y: 0, tileX: false, tileY: false, xscale: 1, yscale: 1, hspeed: 0, vspeed: 0, blend: 0xffffff, alpha: 1 };
}

/** (px, py) relative to (x, y), rotated counter-clockwise by `angle` degrees (y down). */
function rotate(x: number, y: number, px: number, py: number, angle: number): { x: number; y: number } {
	if (angle === 0) return { x: x + px, y: y + py };
	const rad = (-angle * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return { x: x + px * cos - py * sin, y: y + px * sin + py * cos };
}

function maskHit(sprite: Sprite, inst: Instance, x: number, y: number): boolean {
	let dx = x - inst.x;
	let dy = y - inst.y;
	if (inst.imageAngle !== 0) {
		const rad = (inst.imageAngle * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		[dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos];
	}
	const lx = Math.floor(dx / inst.imageXscale + sprite.originX);
	const ly = Math.floor(dy / inst.imageYscale + sprite.originY);
	if (lx < 0 || ly < 0 || lx >= sprite.width || ly >= sprite.height) return false;
	const n = sprite.masks.length;
	const mask = sprite.masks[n === 1 ? 0 : ((Math.floor(inst.imageIndex) % n) + n) % n];
	const stride = (sprite.width + 7) >> 3;
	return (mask[ly * stride + (lx >> 3)] & (0x80 >> (lx & 7))) !== 0;
}

function pathLength(points: { x: number; y: number }[], closed: boolean): number {
	let length = 0;
	const n = closed ? points.length : points.length - 1;
	for (let i = 0; i < n; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		length += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return length;
}

function pointOnPath(points: { x: number; y: number }[], closed: boolean, t: number): { x: number; y: number } {
	if (points.length === 1) return points[0];
	const total = pathLength(points, closed);
	let remaining = t * total;
	const n = closed ? points.length : points.length - 1;
	for (let i = 0; i < n; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		const seg = Math.hypot(b.x - a.x, b.y - a.y);
		if (remaining <= seg || i === n - 1) {
			const f = seg > 0 ? Math.min(1, remaining / seg) : 0;
			return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
		}
		remaining -= seg;
	}
	return points[points.length - 1];
}
