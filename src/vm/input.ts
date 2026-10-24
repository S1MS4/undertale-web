// GameMaker key codes are Windows virtual-key codes, which match KeyboardEvent.keyCode.
export const VK_NOKEY = 0;
export const VK_ANYKEY = 1;
export const VK_SPACE = 32;

// Keys the page shouldn't react to (scrolling, browser shortcuts) while the game runs.
const CAPTURED = new Set([8, 9, 13, 16, 17, 18, 27, 32, 37, 38, 39, 40, 65, 67, 68, 83, 87, 88, 90]);

const VK_ENTER = 13;

/** WASD also drive the arrow keys: W up, A left, S down, D right. Space also works as Enter (confirm). */
const ALIASES = new Map([
	[87, 38],
	[65, 37],
	[83, 40],
	[68, 39],
	[VK_SPACE, VK_ENTER],
]);

/** The key the game sees held for a physical key that drives one (an arrow, or Enter for Space), if any. */
function aliasOf(code: number): number | undefined {
	return ALIASES.get(code) ?? (code >= 37 && code <= 40 ? code : undefined);
}

/**
 * Keyboard state for the game. Key events are collected as they arrive and become visible together
 * at the start of the next step, then stay visible for that whole frame (step and draw), as in GameMaker.
 */
export class GameInput {
	private readonly down = new Set<number>();
	private pressed = new Set<number>();
	private released = new Set<number>();
	private pendingPressed = new Set<number>();
	private pendingReleased = new Set<number>();
	/** Simulated taps: visible as held for one step, released at the start of the next. */
	private tapped = new Set<number>();
	private tappedNext = new Set<number>();
	/**
	 * The physical Enter key. It's the hold-to-skip key and never reaches the game, so it doesn't also
	 * confirm (Space and Z do that); the game's Enter is driven by Space instead.
	 */
	skipHeld = false;
	lastKey = 0;
	currentKey = 0;
	lastChar = '';
	keyboardString = '';

	private readonly target: Window;
	/** Which physical keys are holding each aliased key, so W + Up (or Space + Enter) released one at a time works. */
	private readonly holders = new Map<number, Set<number>>();

	private readonly onKeyDown = (e: KeyboardEvent) => {
		if (CAPTURED.has(e.keyCode)) e.preventDefault();
		if (e.keyCode === VK_ENTER) {
			this.skipHeld = true;
			return;
		}
		if (e.repeat) return;
		const alias = aliasOf(e.keyCode);
		if (alias !== undefined && alias !== e.keyCode) this.press(e.keyCode);
		if (alias !== undefined) this.hold(alias, e.keyCode);
		else this.press(e.keyCode);
		if (e.key.length === 1) {
			this.lastChar = e.key;
			this.keyboardString = (this.keyboardString + e.key).slice(-1024);
		}
	};
	private readonly onKeyUp = (e: KeyboardEvent) => {
		if (e.keyCode === VK_ENTER) {
			this.skipHeld = false;
			return;
		}
		const alias = aliasOf(e.keyCode);
		if (alias !== undefined && alias !== e.keyCode) this.release(e.keyCode);
		if (alias !== undefined) this.unhold(alias, e.keyCode);
		else this.release(e.keyCode);
	};
	private readonly onBlur = () => {
		this.skipHeld = false;
		this.holders.clear();
		for (const k of [...this.down]) this.release(k);
	};

	/** An aliased key stays down while any physical key holding it (the key itself, W/A/S/D, Space) is down. */
	private hold(key: number, source: number): void {
		let set = this.holders.get(key);
		if (!set) this.holders.set(key, (set = new Set()));
		set.add(source);
		this.press(key);
	}

	private unhold(key: number, source: number): void {
		const set = this.holders.get(key);
		set?.delete(source);
		if (!set?.size) this.release(key);
	}

	constructor(target: Window) {
		this.target = target;
		target.addEventListener('keydown', this.onKeyDown);
		target.addEventListener('keyup', this.onKeyUp);
		target.addEventListener('blur', this.onBlur);
	}

	dispose(): void {
		this.target.removeEventListener('keydown', this.onKeyDown);
		this.target.removeEventListener('keyup', this.onKeyUp);
		this.target.removeEventListener('blur', this.onBlur);
	}

	/** Call before each game step. */
	beginStep(): void {
		// Taps were visible as held for one step; release them now so the release shows this step.
		for (const key of this.tapped) this.release(key);
		this.tapped = this.tappedNext;
		this.tappedNext = new Set();
		this.pressed = this.pendingPressed;
		this.released = this.pendingReleased;
		this.pendingPressed = new Set();
		this.pendingReleased = new Set();
	}

	isDown(key: number): boolean {
		if (key === VK_ANYKEY) return this.down.size > 0;
		if (key === VK_NOKEY) return this.down.size === 0;
		return this.down.has(key);
	}

	wasPressed(key: number): boolean {
		if (key === VK_ANYKEY) return this.pressed.size > 0;
		if (key === VK_NOKEY) return this.pressed.size === 0;
		return this.pressed.has(key);
	}

	wasReleased(key: number): boolean {
		if (key === VK_ANYKEY) return this.released.size > 0;
		if (key === VK_NOKEY) return this.released.size === 0;
		return this.released.has(key);
	}

	/** Keys held, pressed or released this step, for keyboard events. */
	keysDown(): Iterable<number> {
		return this.down;
	}

	keysPressed(): Iterable<number> {
		return this.pressed;
	}

	keysReleased(): Iterable<number> {
		return this.released;
	}

	press(key: number): void {
		if (!this.down.has(key)) this.pendingPressed.add(key);
		this.down.add(key);
		this.lastKey = this.currentKey = key;
	}

	release(key: number): void {
		if (this.down.delete(key)) this.pendingReleased.add(key);
		if (this.currentKey === key) this.currentKey = 0;
	}

	/** keyboard_clear: forget the key entirely. */
	clear(key: number): void {
		this.down.delete(key);
		this.pressed.delete(key);
		this.released.delete(key);
		this.pendingPressed.delete(key);
	}

	/** A press that lasts exactly one step (used by cutscene skipping and tests). */
	tap(key: number): void {
		this.press(key);
		this.tappedNext.add(key);
	}
}
