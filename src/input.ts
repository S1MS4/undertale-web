// Keys the page should not react to (scrolling, find-as-you-type) while the game has focus.
const CAPTURED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'z', 'x', 'c']);

// WASD work like the arrow keys on the launcher too.
const WASD: Record<string, string> = { w: 'ArrowUp', a: 'ArrowLeft', s: 'ArrowDown', d: 'ArrowRight' };

/** Letters are lower-cased so Shift or Caps Lock don't change which key is reported. */
function keyName(e: KeyboardEvent): string {
	const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
	return WASD[key] ?? key;
}

/** Keyboard state sampled once per game frame. */
export class Keyboard {
	private readonly down = new Set<string>();
	private pressedThisFrame = new Set<string>();

	constructor(target: Window) {
		target.addEventListener('keydown', (e) => {
			const key = keyName(e);
			if (CAPTURED.has(key)) e.preventDefault();
			if (!e.repeat) this.pressedThisFrame.add(key);
			this.down.add(key);
		});
		target.addEventListener('keyup', (e) => this.down.delete(keyName(e)));
		target.addEventListener('blur', () => this.down.clear());
	}

	isDown(...keys: string[]): boolean {
		return keys.some((k) => this.down.has(k));
	}

	pressed(...keys: string[]): boolean {
		return keys.some((k) => this.pressedThisFrame.has(k));
	}

	endFrame(): void {
		this.pressedThisFrame = new Set();
	}
}

/** Mouse or touch position in game pixels, whatever size the canvas is shown at. */
export class Pointer {
	x = -1;
	y = -1;
	moved = false;
	clicked = false;
	private readonly canvas: HTMLCanvasElement;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		canvas.addEventListener('pointermove', (e) => {
			this.locate(e);
			this.moved = true;
		});
		canvas.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			this.locate(e);
			this.clicked = true;
		});
		canvas.addEventListener('pointerleave', () => {
			this.x = this.y = -1;
		});
	}

	endFrame(): void {
		this.moved = this.clicked = false;
	}

	private locate(e: PointerEvent): void {
		const rect = this.canvas.getBoundingClientRect();
		this.x = ((e.clientX - rect.left) * this.canvas.width) / rect.width;
		this.y = ((e.clientY - rect.top) * this.canvas.height) / rect.height;
	}
}
