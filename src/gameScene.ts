import type { DataWin, Font } from './data/DataWin.ts';
import { C_WHITE, drawText } from './render/draw.ts';
import type { Renderer } from './render/Renderer.ts';
import type { SaveStore } from './saves.ts';
import type { Scene } from './scenes.ts';
import { AudioEngine, SilentAudio } from './vm/audio.ts';
import { GameFiles } from './vm/files.ts';
import { Game } from './vm/Game.ts';
import { INSTANCE_VARS } from './vm/builtinVars.ts';
import { GameInput } from './vm/input.ts';
import type { Instance } from './vm/Instance.ts';

const HOLD_MS = 1000;
/** Frames for the fade to black before a skip, and back in after it. */
const FADE_STEPS = 15;
/** Game steps run (out of sight) per displayed frame while skipping. */
const SKIP_STEPS_PER_FRAME = 60;
/** Give up after this much game time, in case the scene never hands control back. */
const SKIP_LIMIT_STEPS = 30 * 180;
const VK_Z = 90;
/** The Space hint: a key outline this many logical pixels wide and tall, this far inside the box's corner. */
const HINT_W = 26;
const HINT_H = 11;
const HINT_GAP = 12; // clears the box's white border
/** How long to wait for the game's start-up to reach the intro before giving up on loading straight in. */
const LOAD_LIMIT_STEPS = 30 * 10;

type SkipPhase = 'none' | 'fadeOut' | 'skipping' | 'fadeIn';

/**
 * Runs the game. Holding Enter during a cutscene fills a bar; when it's full the screen fades to black,
 * the game runs ahead out of sight (muted, advancing dialogue) until the player is needed again, and
 * the screen fades back in. Releasing Enter early resets the bar.
 */
export class GameScene implements Scene {
	readonly game: Game;
	private readonly input: GameInput;
	private readonly audio: AudioEngine;
	private readonly renderer: Renderer;
	private readonly font: Font | undefined;
	private readonly objectIndex: (name: string) => number;
	hold = 0;
	private phase: SkipPhase = 'none';
	private fade = 0;
	private skipSteps = 0;
	/** Steps left to wait for the intro, when the save should load without it; 0 once done. */
	private loadWait = 0;

	/** The player's volume, 0 to 1. */
	setVolume(volume: number): void {
		this.audio.setVolume(volume);
	}

	/**
	 * `loadSave` goes straight to the saved spot instead of the intro story and title menu.
	 * `silent` (automated tests) never opens the sound device at all.
	 */
	constructor(
		renderer: Renderer,
		data: DataWin,
		musicUrl: (file: string) => string | null,
		saves: SaveStore,
		onExit: () => void,
		loadSave = false,
		silent = false,
	) {
		this.renderer = renderer;
		this.input = new GameInput(window);
		this.audio = silent ? (new SilentAudio() as unknown as AudioEngine) : new AudioEngine(data, musicUrl);
		this.audio.resume();
		const files = new GameFiles(new Map(saves.files), (name, bytes) => saves.writeFile(name, bytes));
		this.font = data.fonts.get('fnt_small');
		const byName = new Map(data.objects.map((o) => [o.name, o.index]));
		this.objectIndex = (name) => byName.get(name) ?? -1;
		this.game = new Game(data, {
			renderer,
			audio: this.audio,
			files,
			input: this.input,
			onEnd: () => {
				this.dispose();
				onExit();
			},
		});
		// The overworld dialogue box, the battle box's borders, and the text itself, for placing the Space hint.
		this.game.measureObjects = ['obj_dialoguer', 'obj_borderparent', 'obj_base_writer'].map(this.objectIndex).filter((o) => o >= 0);
		this.game.start();
		if (loadSave) this.loadWait = LOAD_LIMIT_STEPS;
	}

	get frameMs(): number {
		return 1000 / this.game.roomSpeed;
	}

	/**
	 * Dialogue has finished typing and waits for a confirm key: a text writer is halted (1: more text follows,
	 * 2: the box closes next) and no choice is on screen.
	 */
	get awaitingConfirm(): boolean {
		if (this.phase !== 'none' || this.game.ended || this.exists('obj_choicer')) return false;
		const writer = this.objectIndex('obj_base_writer');
		return writer >= 0 && this.game.instancesOf(writer).some((w) => w.vars.get('halt') === 1 || w.vars.get('halt') === 2);
	}

	/** True from the moment the fade starts until the game is visible again (tests use this). */
	get skipping(): boolean {
		return this.phase !== 'none';
	}

	update(): void {
		switch (this.phase) {
			case 'fadeOut':
				// The game holds still while the screen darkens.
				if (++this.fade >= FADE_STEPS) {
					this.phase = 'skipping';
					this.skipSteps = 0;
					this.audio.setMuted(true);
				}
				return;
			case 'skipping':
				this.skipBatch();
				return;
			case 'fadeIn':
				// Hold until the screen is back, so the player sees where they are before moving.
				if (--this.fade <= 0) this.phase = 'none';
				return;
		}

		if (this.input.skipHeld && this.canSkip()) {
			// One update is one game step, so the bar fills in HOLD_MS of game time.
			this.hold = Math.min(1, this.hold + this.frameMs / HOLD_MS);
			if (this.hold >= 1) {
				this.hold = 0;
				this.phase = 'fadeOut';
				this.fade = 0;
			}
		} else {
			this.hold = 0;
		}

		this.input.beginStep();
		this.game.step();
		if (this.loadWait > 0) this.loadOnceStarted();
	}

	draw(): void {
		if (this.phase === 'skipping') {
			// The screen stays black while the game runs ahead; only a small label shows.
			this.drawLabel('SKIPPING');
			return;
		}
		this.game.draw();
		if (this.fade > 0) {
			this.renderer.resetView();
			this.renderer.fillRect(0, 0, this.renderer.width, this.renderer.height, 0x000000, this.fade / FADE_STEPS);
		}
		this.drawSkipBar();
		this.drawConfirmHint();
		this.drawInteractHint();
		this.game.afterFrame();
	}

	dispose(): void {
		this.input.dispose();
		this.audio.close();
	}

	/**
	 * Saves the current spot with the game's own save routine (what a save star does), so Export can
	 * be used any time. Only while the player is free to walk: not in cutscenes, menus or battles.
	 * Returns whether it saved.
	 */
	saveNow(): boolean {
		const g = this.game;
		if (this.phase !== 'none' || g.ended || this.global('interact') !== 0 || this.global('inbattle') !== 0) return false;
		const player = g.instances.find((i) => i.object.name === 'obj_mainchara' && !i.destroyed);
		const save = g.data.scripts.get('scr_save');
		if (!player || save === undefined) return false;
		g.runCode(save, player, player);
		return true;
	}

	/**
	 * The start room sets up the game, then moves on to the intro story. At that point (before it's drawn),
	 * do what the title menu's Continue does: stop the music and run the game's load script, which goes to
	 * the saved room. Any other first room (a special state after an ending) is left to play as usual.
	 */
	private loadOnceStarted(): void {
		const g = this.game;
		const room = g.data.roomNames[g.roomIndex];
		if (room === 'room_start' && --this.loadWait > 0) return;
		this.loadWait = 0;
		const load = g.data.scripts.get('scr_load');
		const self = g.instances.find((i) => !i.destroyed);
		if (g.ended || room !== 'room_introstory' || load === undefined || !self || !g.files.exists('file0')) return;
		this.audio.stopAll();
		g.runCode(load, self, self);
	}

	// ---- skipping

	private global(name: string): number {
		const v = this.game.globals.get(name);
		return typeof v === 'number' ? v : 0;
	}

	private exists(objectName: string): boolean {
		const index = this.objectIndex(objectName);
		return index >= 0 && this.game.instancesOf(index).length > 0;
	}

	/** The opening story is a cutscene without a player; the title screen after it waits for a key. */
	private inIntro(): boolean {
		return this.game.data.roomNames[this.game.roomIndex] === 'room_introstory';
	}

	/**
	 * A cutscene: dialogue or a scripted scene (interact 1), with no choice or battle waiting on the
	 * player. Room transitions (interact 3) and menus are left alone.
	 */
	private canSkip(): boolean {
		if (this.game.ended || this.global('inbattle') !== 0 || this.exists('obj_choicer')) return false;
		return this.global('interact') === 1 || this.inIntro();
	}

	/**
	 * Runs whole frames (step and draw), because Undertale runs some cutscene and text logic in its
	 * draw events. The drawing goes to the canvas, which is cleared before anything is shown.
	 */
	private skipBatch(): void {
		for (let k = 0; k < SKIP_STEPS_PER_FRAME; k++) {
			if (!this.canSkip() || this.skipSteps >= SKIP_LIMIT_STEPS) {
				this.finishSkip();
				return;
			}
			// Advance text while a writer is on screen; every other step so each press registers.
			if (this.skipSteps % 2 === 0 && this.exists('OBJ_WRITER')) this.input.tap(VK_Z);
			this.input.beginStep();
			this.game.step();
			this.game.draw();
			this.game.afterFrame();
			this.skipSteps++;
		}
	}

	private finishSkip(): void {
		// Let any taps from the skip run out so they can't carry into the player's control.
		this.input.beginStep();
		this.phase = 'fadeIn';
		this.fade = FADE_STEPS;
		this.audio.setMuted(false);
	}

	private drawLabel(text: string): void {
		if (!this.font) return;
		const r = this.renderer;
		r.resetView();
		drawText(r, this.font, text, r.width - 16, r.height - 30, { scale: 2, align: 'right', color: C_WHITE });
	}

	/**
	 * A small Space key in the bottom-right corner of the box the waiting text is in (the overworld dialogue
	 * box or the battle box), or its bottom-left corner when the box reaches the right edge of the screen.
	 * Text outside any box (a monster's speech bubble) gets it just after the text instead, never on top of it.
	 * White on a dark plate so it shows on any background.
	 */
	private drawConfirmHint(): void {
		if (!this.awaitingConfirm) return;
		const measured = (name: string) => this.game.measured.get(this.objectIndex(name));
		const text = measured('obj_base_writer');
		if (!text) return;
		const r = this.renderer;
		const s = Math.max(1, Math.round(r.height / this.game.data.windowHeight));
		const w = HINT_W * s;
		const h = HINT_H * s;
		const gap = HINT_GAP * s;
		const cx = (text.left + text.right) / 2;
		const cy = (text.top + text.bottom) / 2;
		const box = [measured('obj_dialoguer'), measured('obj_borderparent')].find(
			(b) => b && cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom,
		);
		let x: number;
		let y: number;
		if (box) {
			x = box.right > r.width - gap ? box.left + gap : box.right - gap - w;
			y = Math.min(box.bottom, r.height) - gap - h;
		} else {
			x = text.right + s * 4 + w > r.width ? text.left - s * 4 - w : text.right + s * 4;
			y = text.bottom - h;
		}
		this.drawSpaceKey(Math.round(x), Math.round(y), s);
	}

	/**
	 * What a confirm press would check or talk to right now: the interactable in front of the player, found
	 * with the same rectangle per facing as the player's own check (obj_mainchara's user event 0).
	 */
	interactTarget(): Instance | null {
		const g = this.game;
		if (this.phase !== 'none' || g.ended || this.global('interact') !== 0 || this.global('inbattle') !== 0 || this.exists('obj_itemswapper')) return null;
		const root = this.objectIndex('obj_interactable');
		const player = g.instances.find((i) => i.object.name === 'obj_mainchara' && i.active && !i.destroyed);
		if (root < 0 || !player || Number(player.vars.get('uncan') ?? 0) !== 0) return null;
		const { x, y } = player;
		const w = Number(INSTANCE_VARS.sprite_width.get(player, g));
		const h = Number(INSTANCE_VARS.sprite_height.get(player, g));
		const rects: Record<number, [number, number, number, number]> = {
			0: [x + 4, y + 20, x + w - 4, y + h + 15], // down
			1: [x + w / 2, y + h / 2, x + w + 15, y + h], // right
			2: [x + 4, y + h - 5, x + w - 4, y + 8], // up
			3: [x + w / 2, y + 3 + h / 2, x - 15, y + h + 3], // left
		};
		const rect = rects[this.global('facing')];
		if (!rect) return null;
		const [l, t, r, b] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
		return g.instancesOf(root).find((o) => o !== player && g.rectOverlaps(o, l, t, r, b, false)) ?? null;
	}

	/** The Space key above whatever the player can check or talk to, so it's clear the key does something there. */
	private drawInteractHint(): void {
		const target = this.interactTarget();
		if (!target) return;
		const g = this.game;
		// Above the picture when it has one (a sign's collision box is often only its lower part), else its box.
		const sprite = target.visible ? g.data.spriteList[target.sprite] : undefined;
		const box = sprite
			? {
					left: target.x - sprite.originX * target.imageXscale,
					right: target.x + (sprite.width - sprite.originX) * target.imageXscale,
					top: target.y - sprite.originY * target.imageYscale,
				}
			: (g.bounds(target) ?? { left: target.x, top: target.y, right: target.x });
		const top = g.toCanvas((box.left + box.right) / 2, box.top);
		if (!top) return;
		const r = this.renderer;
		const s = Math.max(1, Math.round(r.height / g.data.windowHeight));
		const gap = 4 * s;
		const x = Math.round(Math.min(Math.max(top.x - (HINT_W * s) / 2, gap), r.width - HINT_W * s - gap));
		const y = Math.round(Math.max(top.y - gap - HINT_H * s, gap));
		this.drawSpaceKey(x, y, s);
	}

	/** A small space bar outline at canvas (x, y), `s` canvas pixels per logical pixel, white on a dark plate. */
	private drawSpaceKey(x: number, y: number, s: number): void {
		const r = this.renderer;
		const w = HINT_W * s;
		const h = HINT_H * s;
		// Fades gently in and out, like a blinking prompt.
		const alpha = 0.65 + 0.35 * Math.sin(performance.now() / 250);
		r.resetView();
		r.fillRect(x - s, y - s, w + 2 * s, h + 2 * s, 0x000000, 0.8 * alpha);
		const line = (lx: number, ly: number, lw: number, lh: number) => r.fillRect(x + lx * s, y + ly * s, lw * s, lh * s, C_WHITE, alpha);
		// The key's outline, then the bracket printed on a space bar.
		line(0, 0, HINT_W, 1);
		line(0, HINT_H - 1, HINT_W, 1);
		line(0, 0, 1, HINT_H);
		line(HINT_W - 1, 0, 1, HINT_H);
		line(7, 6, 1, 2);
		line(HINT_W - 8, 6, 1, 2);
		line(7, 7, HINT_W - 14, 1);
	}

	private drawSkipBar(): void {
		if (this.hold <= 0) return;
		const r = this.renderer;
		r.resetView();
		const w = 120;
		const h = 6;
		const x = r.width - w - 16;
		const y = r.height - 24;
		r.fillRect(x - 2, y - 2, w + 4, h + 4, 0x000000, 0.7);
		r.fillRect(x, y, w, h, 0x404040, 1);
		r.fillRect(x, y, Math.round(w * this.hold), h, C_WHITE, 1);
		if (this.font) drawText(r, this.font, 'HOLD TO SKIP', x + w, y - 16, { scale: 2, align: 'right', color: C_WHITE });
	}
}
