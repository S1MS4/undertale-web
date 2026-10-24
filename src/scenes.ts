import type { DataWin, Font, Sprite } from './data/DataWin.ts';
import type { Keyboard, Pointer } from './input.ts';
import { C_GRAY, C_WHITE, C_YELLOW, drawSprite, drawText, textWidth } from './render/draw.ts';
import type { Renderer } from './render/Renderer.ts';

export interface Scene {
	update(): void;
	draw(): void;
	/** Milliseconds per update; defaults to Undertale's 30 steps a second. */
	readonly frameMs?: number;
}

export type LaunchAction = 'continue' | 'import' | 'new';

const LABELS: Record<LaunchAction, string> = {
	continue: 'Continue',
	import: 'Import Save',
	new: 'Start New Game',
};

const ROW_GAP = 44;
const CONFIRM_KEYS = ['z', 'Enter'];

/** Assets the scenes draw with, all read from the player's data.win. */
export interface UiAssets {
	menuFont: Font;
	smallFont: Font;
	heart: Sprite;
}

export function uiAssets(data: DataWin): UiAssets {
	const menuFont = data.fonts.get('fnt_main');
	const smallFont = data.fonts.get('fnt_small');
	const heart = data.sprites.get('spr_heart');
	if (!menuFont || !smallFont || !heart) throw new Error('data.win is missing fnt_main, fnt_small or spr_heart');
	return { menuFont, smallFont, heart };
}

export function uiPages(ui: UiAssets): Set<number> {
	return new Set([ui.menuFont.item.page, ui.smallFont.item.page, ...ui.heart.frames.map((f) => f.page)]);
}

/** The screen before the game boots: pick between the browser's save, uploading one, or a new game. */
export class Launcher implements Scene {
	private actions: LaunchAction[] = [];
	private selected = 0;
	private newGameInProgress = false;
	private confirmingNew = false;
	private message = '';
	private messageColor = C_WHITE;
	private readonly r: Renderer;
	private readonly ui: UiAssets;
	private readonly keyboard: Keyboard;
	private readonly pointer: Pointer;
	private readonly onAction: (action: LaunchAction) => void;

	constructor(r: Renderer, ui: UiAssets, keyboard: Keyboard, pointer: Pointer, onAction: (action: LaunchAction) => void) {
		this.r = r;
		this.ui = ui;
		this.keyboard = keyboard;
		this.pointer = pointer;
		this.onAction = onAction;
	}

	/**
	 * Call whenever the stored saves change. "Continue" only appears when the active slot has progress.
	 * Starting a new game over a new game already in progress asks for confirmation first.
	 */
	reset(canContinue: boolean, newGameInProgress: boolean): void {
		this.newGameInProgress = newGameInProgress;
		this.actions = canContinue ? ['continue', 'import', 'new'] : ['import', 'new'];
		this.selected = this.actions.indexOf('new');
		this.confirmingNew = false;
		this.say('');
	}

	say(message: string, color = C_WHITE): void {
		this.message = message;
		this.messageColor = color;
	}

	update(): void {
		const { keyboard, pointer } = this;
		if (keyboard.pressed('ArrowUp')) this.select(this.selected - 1);
		if (keyboard.pressed('ArrowDown')) this.select(this.selected + 1);

		const hovered = this.rowAt(pointer.x, pointer.y);
		if (pointer.moved && hovered >= 0) this.select(hovered);

		if (keyboard.pressed(...CONFIRM_KEYS) || (pointer.clicked && hovered >= 0)) this.activate();
	}

	draw(): void {
		const { r, ui } = this;
		const top = this.rowsTop();
		this.actions.forEach((action, i) => {
			const label = LABELS[action];
			const y = top + i * ROW_GAP;
			const selected = i === this.selected;
			drawText(r, ui.menuFont, label, r.width / 2, y, { color: selected ? C_YELLOW : C_WHITE, align: 'center' });
			if (selected) {
				const x = r.width / 2 - textWidth(ui.menuFont, label) / 2 - ui.heart.width - 12;
				drawSprite(r, ui.heart, 0, x, y + Math.round((ui.menuFont.lineHeight - ui.heart.height) / 2));
			}
		});

		if (this.message) {
			drawText(r, ui.smallFont, this.message, r.width / 2, r.height / 2 + 120, { color: this.messageColor, scale: 2, align: 'center' });
		}
		drawText(r, ui.smallFont, 'Arrows or WASD: move     Enter: select', r.width / 2, r.height - 40, {
			color: C_GRAY,
			scale: 2,
			align: 'center',
		});
	}

	private select(index: number): void {
		const next = Math.max(0, Math.min(this.actions.length - 1, index));
		if (next === this.selected) return;
		this.selected = next;
		if (this.confirmingNew) {
			this.confirmingNew = false;
			this.say('');
		}
	}

	private activate(): void {
		const action = this.actions[this.selected];
		if (action === 'new' && this.newGameInProgress && !this.confirmingNew) {
			this.confirmingNew = true;
			this.say('This restarts your new game from the beginning.\nAn imported save is kept. Select again to confirm.', C_YELLOW);
			return;
		}
		this.onAction(action);
	}

	private rowsTop(): number {
		return Math.round(this.r.height / 2 - (this.actions.length * ROW_GAP) / 2) - 20;
	}

	private rowAt(x: number, y: number): number {
		if (x < 0) return -1;
		const row = Math.floor((y - this.rowsTop()) / ROW_GAP);
		if (row < 0 || row >= this.actions.length) return -1;
		const half = textWidth(this.ui.menuFont, LABELS[this.actions[row]]) / 2 + this.ui.heart.width + 16;
		return Math.abs(x - this.r.width / 2) <= half ? row : -1;
	}
}
