import type { GameObject } from '../data/DataWin.ts';
import type { Value } from './values.ts';

export const ALARM_COUNT = 12;

/** One object instance. Built-in variables are fields; everything the game defines lives in `vars`. */
export class Instance {
	readonly id: number;
	object: GameObject;
	readonly vars = new Map<string, Value>();
	readonly alarm: number[] = new Array(ALARM_COUNT).fill(-1);

	x = 0;
	y = 0;
	xstart = 0;
	ystart = 0;
	xprevious = 0;
	yprevious = 0;
	hspeed = 0;
	vspeed = 0;
	friction = 0;
	gravity = 0;
	gravityDirection = 270;

	sprite = -1;
	mask = -1;
	imageIndex = 0;
	imageSpeed = 1;
	imageXscale = 1;
	imageYscale = 1;
	imageAngle = 0;
	imageAlpha = 1;
	imageBlend = 0xffffff;

	depth = 0;
	visible = true;
	solid = false;
	persistent = false;

	/** Following a path: index, speed, position (0..1), end action, absolute or relative to the start. */
	path = -1;
	pathSpeed = 0;
	pathPosition = 0;
	pathEndAction = 0;
	pathOrigin = { x: 0, y: 0 };

	destroyed = false;
	active = true;
	/** Creation order, used to break depth ties when drawing. */
	readonly order: number;

	constructor(id: number, object: GameObject, x: number, y: number, order: number) {
		this.id = id;
		this.object = object;
		this.order = order;
		this.x = this.xstart = this.xprevious = x;
		this.y = this.ystart = this.yprevious = y;
		this.sprite = object.sprite;
		this.mask = object.mask;
		this.depth = object.depth;
		this.visible = object.visible;
		this.solid = object.solid;
		this.persistent = object.persistent;
	}

	get speed(): number {
		return Math.hypot(this.hspeed, this.vspeed);
	}

	set speed(value: number) {
		const dir = this.direction;
		this.setMotion(dir, value);
	}

	get direction(): number {
		if (this.hspeed === 0 && this.vspeed === 0) return this.lastDirection;
		const d = (Math.atan2(-this.vspeed, this.hspeed) * 180) / Math.PI;
		return d < 0 ? d + 360 : d;
	}

	set direction(value: number) {
		this.lastDirection = ((value % 360) + 360) % 360;
		this.setMotion(this.lastDirection, this.speed);
	}

	private lastDirection = 0;

	setMotion(direction: number, speed: number): void {
		this.lastDirection = ((direction % 360) + 360) % 360;
		const rad = (direction * Math.PI) / 180;
		this.hspeed = Math.cos(rad) * speed;
		this.vspeed = -Math.sin(rad) * speed;
		// Avoid -0 and float dust on axis-aligned motion.
		if (Math.abs(this.hspeed) < 1e-10) this.hspeed = 0;
		if (Math.abs(this.vspeed) < 1e-10) this.vspeed = 0;
	}
}
