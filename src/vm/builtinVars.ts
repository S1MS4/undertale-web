import type { Game, RoomBackgroundState, View } from './Game.ts';
import type { Instance } from './Instance.ts';
import type { Frame } from './Interpreter.ts';
import { toInt, toNumber, truthy, type Value } from './values.ts';

export interface InstanceVar {
	get(inst: Instance, game: Game, index?: number): Value;
	set?(inst: Instance, value: Value, game: Game, index?: number): void;
}

export interface GlobalVar {
	get(game: Game, frame: Frame, index?: number): Value;
	set?(game: Game, frame: Frame, value: Value, index?: number): void;
}

type NumberKey = { [K in keyof Instance]: Instance[K] extends number ? K : never }[keyof Instance];
type BoolKey = { [K in keyof Instance]: Instance[K] extends boolean ? K : never }[keyof Instance];

const num = (key: NumberKey): InstanceVar => ({
	get: (i) => i[key],
	set: (i, v) => {
		(i[key] as number) = toNumber(v);
	},
});

const bool = (key: BoolKey): InstanceVar => ({
	get: (i) => (i[key] ? 1 : 0),
	set: (i, v) => {
		(i[key] as boolean) = truthy(v);
	},
});

const readOnly = (get: InstanceVar['get']): InstanceVar => ({ get });

function spriteOf(i: Instance, g: Game) {
	return g.data.spriteList[i.sprite];
}

export const INSTANCE_VARS: Record<string, InstanceVar> = {
	x: num('x'),
	y: num('y'),
	xprevious: num('xprevious'),
	yprevious: num('yprevious'),
	xstart: num('xstart'),
	ystart: num('ystart'),
	hspeed: num('hspeed'),
	vspeed: num('vspeed'),
	speed: num('speed'),
	direction: num('direction'),
	friction: num('friction'),
	gravity: num('gravity'),
	gravity_direction: num('gravityDirection'),
	sprite_index: num('sprite'),
	mask_index: num('mask'),
	image_index: num('imageIndex'),
	image_speed: num('imageSpeed'),
	image_xscale: num('imageXscale'),
	image_yscale: num('imageYscale'),
	image_angle: num('imageAngle'),
	image_alpha: num('imageAlpha'),
	image_blend: num('imageBlend'),
	image_single: {
		get: (i) => (i.imageSpeed === 0 ? i.imageIndex : -1),
		set: (i, v) => {
			const n = toNumber(v);
			if (n >= 0) {
				i.imageSpeed = 0;
				i.imageIndex = n;
			} else {
				i.imageSpeed = 1;
			}
		},
	},
	image_number: readOnly((i, g) => spriteOf(i, g)?.frames.length ?? 0),
	sprite_width: readOnly((i, g) => (spriteOf(i, g)?.width ?? 0) * i.imageXscale),
	sprite_height: readOnly((i, g) => (spriteOf(i, g)?.height ?? 0) * i.imageYscale),
	sprite_xoffset: readOnly((i, g) => (spriteOf(i, g)?.originX ?? 0) * i.imageXscale),
	sprite_yoffset: readOnly((i, g) => (spriteOf(i, g)?.originY ?? 0) * i.imageYscale),
	depth: num('depth'),
	visible: bool('visible'),
	solid: bool('solid'),
	persistent: bool('persistent'),
	object_index: readOnly((i) => i.object.index),
	id: readOnly((i) => i.id),
	alarm: {
		get: (i, _g, index) => i.alarm[index ?? 0] ?? -1,
		set: (i, v, _g, index) => {
			const a = index ?? 0;
			if (a >= 0 && a < i.alarm.length) i.alarm[a] = toNumber(v);
		},
	},
	bbox_left: readOnly((i, g) => Math.round(g.bounds(i)?.left ?? i.x)),
	bbox_top: readOnly((i, g) => Math.round(g.bounds(i)?.top ?? i.y)),
	bbox_right: readOnly((i, g) => Math.round(g.bounds(i)?.right ?? i.x + 1) - 1),
	bbox_bottom: readOnly((i, g) => Math.round(g.bounds(i)?.bottom ?? i.y + 1) - 1),
	path_index: readOnly((i) => i.path),
	path_position: num('pathPosition'),
	path_positionprevious: readOnly((i) => i.pathPosition),
	path_speed: num('pathSpeed'),
	path_endaction: num('pathEndAction'),
	path_scale: readOnly(() => 1),
	path_orientation: readOnly(() => 0),
	timeline_index: readOnly(() => -1),
};

const viewVar = (key: keyof View): GlobalVar => ({
	get: (g, _f, index) => {
		const v = g.views[index ?? 0];
		const value = v?.[key] ?? 0;
		return typeof value === 'boolean' ? (value ? 1 : 0) : value;
	},
	set: (g, _f, value, index) => {
		const v = g.views[index ?? 0];
		if (!v) return;
		if (key === 'visible') v.visible = truthy(value);
		else (v[key] as number) = toNumber(value);
	},
});

const backgroundVar = (key: keyof RoomBackgroundState): GlobalVar => ({
	get: (g, _f, index) => {
		const value = g.backgrounds[index ?? 0]?.[key] ?? 0;
		return typeof value === 'boolean' ? (value ? 1 : 0) : value;
	},
	set: (g, _f, value, index) => {
		const b = g.backgrounds[index ?? 0];
		if (!b) return;
		if (key === 'visible' || key === 'foreground' || key === 'tileX' || key === 'tileY') (b[key] as boolean) = truthy(value);
		else (b[key] as number) = toNumber(value);
	},
});

/** Plain global built-ins (health, score...) that just hold a value. */
const stored = (initial: Value): GlobalVar => {
	const values = new WeakMap<Game, Value>();
	return {
		get: (g) => (values.has(g) ? values.get(g) : initial),
		set: (g, _f, v) => {
			values.set(g, v);
		},
	};
};

const constant = (value: Value): GlobalVar => ({ get: () => value });
const dateVar = (pick: (d: Date) => number): GlobalVar => ({ get: () => pick(new Date()) });

export const GLOBAL_VARS: Record<string, GlobalVar> = {
	room: {
		get: (g) => g.roomIndex,
		set: (g, _f, v) => g.gotoRoom(toInt(v)),
	},
	room_speed: {
		get: (g) => g.roomSpeed,
		set: (g, _f, v) => {
			g.roomSpeed = Math.max(1, toNumber(v));
		},
	},
	room_width: { get: (g) => g.roomWidth, set: (g, _f, v) => void (g.roomWidth = toNumber(v)) },
	room_height: { get: (g) => g.roomHeight, set: (g, _f, v) => void (g.roomHeight = toNumber(v)) },
	room_persistent: { get: (g) => (g.roomPersistent ? 1 : 0), set: (g, _f, v) => void (g.roomPersistent = truthy(v)) },
	room_first: { get: (g) => g.data.roomOrder[0] },
	room_last: { get: (g) => g.data.roomOrder[g.data.roomOrder.length - 1] },
	room_caption: stored(''),
	transition_kind: stored(0),
	transition_steps: stored(80),

	view_enabled: { get: (g) => (g.viewsEnabled ? 1 : 0), set: (g, _f, v) => void (g.viewsEnabled = truthy(v)) },
	view_current: { get: (g) => g.viewCurrent },
	view_visible: viewVar('visible'),
	view_xview: viewVar('x'),
	view_yview: viewVar('y'),
	view_wview: viewVar('w'),
	view_hview: viewVar('h'),
	view_xport: viewVar('portX'),
	view_yport: viewVar('portY'),
	view_wport: viewVar('portW'),
	view_hport: viewVar('portH'),
	view_angle: viewVar('angle'),
	view_hborder: viewVar('borderX'),
	view_vborder: viewVar('borderY'),
	view_hspeed: viewVar('speedX'),
	view_vspeed: viewVar('speedY'),
	view_object: viewVar('object'),

	background_color: { get: (g) => g.backgroundColor, set: (g, _f, v) => void (g.backgroundColor = toInt(v)) },
	background_colour: { get: (g) => g.backgroundColor, set: (g, _f, v) => void (g.backgroundColor = toInt(v)) },
	background_showcolor: { get: (g) => (g.showBackgroundColor ? 1 : 0), set: (g, _f, v) => void (g.showBackgroundColor = truthy(v)) },
	background_showcolour: { get: (g) => (g.showBackgroundColor ? 1 : 0), set: (g, _f, v) => void (g.showBackgroundColor = truthy(v)) },
	background_visible: backgroundVar('visible'),
	background_foreground: backgroundVar('foreground'),
	background_index: backgroundVar('index'),
	background_x: backgroundVar('x'),
	background_y: backgroundVar('y'),
	background_htiled: backgroundVar('tileX'),
	background_vtiled: backgroundVar('tileY'),
	background_xscale: backgroundVar('xscale'),
	background_yscale: backgroundVar('yscale'),
	background_hspeed: backgroundVar('hspeed'),
	background_vspeed: backgroundVar('vspeed'),
	background_blend: backgroundVar('blend'),
	background_alpha: backgroundVar('alpha'),
	background_width: { get: (g, _f, index) => g.data.backgrounds[g.backgrounds[index ?? 0]?.index ?? -1]?.item?.boundingWidth ?? 0 },
	background_height: { get: (g, _f, index) => g.data.backgrounds[g.backgrounds[index ?? 0]?.index ?? -1]?.item?.boundingHeight ?? 0 },

	keyboard_key: { get: (g) => g.input.currentKey, set: (g, _f, v) => void (g.input.currentKey = toInt(v)) },
	keyboard_lastkey: { get: (g) => g.input.lastKey, set: (g, _f, v) => void (g.input.lastKey = toInt(v)) },
	keyboard_lastchar: { get: (g) => g.input.lastChar, set: (g, _f, v) => void (g.input.lastChar = String(v ?? '')) },
	keyboard_string: { get: (g) => g.input.keyboardString, set: (g, _f, v) => void (g.input.keyboardString = String(v ?? '')) },
	mouse_x: constant(0),
	mouse_y: constant(0),
	mouse_button: constant(0),

	current_time: { get: (g) => Math.floor(g.elapsedMs()) },
	current_year: dateVar((d) => d.getFullYear()),
	current_month: dateVar((d) => d.getMonth() + 1),
	current_day: dateVar((d) => d.getDate()),
	current_weekday: dateVar((d) => d.getDay()),
	current_hour: dateVar((d) => d.getHours()),
	current_minute: dateVar((d) => d.getMinutes()),
	current_second: dateVar((d) => d.getSeconds()),
	fps: { get: (g) => g.roomSpeed },
	fps_real: { get: (g) => g.roomSpeed },
	delta_time: { get: (g) => 1_000_000 / g.roomSpeed },
	instance_count: { get: (g) => g.instances.filter((i) => i.active && !i.destroyed).length },

	health: stored(100),
	lives: stored(-1),
	score: stored(0),

	application_surface: { get: (g) => g.appSurfaceId },
	os_type: constant(0), // os_windows
	os_device: constant(0),
	os_browser: constant(-1), // browser_not_a_browser: behave like the Windows build
	os_version: constant(0),
	working_directory: constant(''),
	program_directory: constant(''),
	temp_directory: constant(''),
	game_id: constant(0),
	game_display_name: { get: (g) => g.data.displayName },
	debug_mode: constant(0),
	secure_mode: constant(0),
	cursor_sprite: stored(-1),
	browser_width: constant(640),
	browser_height: constant(480),

	event_type: { get: (_g, f) => f.event?.type ?? -1 },
	event_number: { get: (_g, f) => f.event?.subtype ?? -1 },
	event_object: { get: (_g, f) => f.event?.owner ?? -1 },
};
