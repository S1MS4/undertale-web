// Development-only helpers for driving the game from the browser console (window.__dev).
// Loaded only by the dev server; the production build never includes them.
// Everything is measured in game steps (30 per second) and advances the game directly, so tests
// behave the same whether or not the browser is throttling the tab.
import type { GameScene } from './gameScene.ts';

export function installDevtools(getScene: () => unknown): void {
	const scene = () => getScene() as GameScene;
	const game = () => scene().game;
	const input = () => game().input;
	const player = () => game().instances.find((i) => i.object.name === 'obj_mainchara');

	/** Runs `steps` frames: update (step) and draw, like the page loop does. */
	const advance = (steps = 1) => {
		const r = game().renderer;
		for (let k = 0; k < steps; k++) {
			scene().update();
			r.begin();
			scene().draw();
			r.end();
		}
	};

	const dev = {
		advance,
		room: () => game().data.roomNames[game().roomIndex],
		tap(key: number, times = 1, gap = 4) {
			for (let k = 0; k < times; k++) {
				input().tap(key);
				advance(gap);
			}
		},
		hold(key: number, steps: number) {
			input().press(key);
			advance(steps);
			input().release(key);
			advance(1);
		},
		/** Walks toward (x, y) with the arrow keys; returns where the player ended up. */
		walkTo(x: number, y: number, maxSteps = 600) {
			const startRoom = dev.room();
			for (let n = 0; n < maxSteps && dev.room() === startRoom; n += 2) {
				const p = player();
				if (!p) break;
				const dx = x - p.x;
				const dy = y - p.y;
				if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) break;
				const keys = [];
				if (dx > 3) keys.push(39);
				if (dx < -3) keys.push(37);
				if (dy > 3) keys.push(40);
				if (dy < -3) keys.push(38);
				for (const k of keys) input().press(k);
				advance(2);
				for (const k of keys) input().release(k);
			}
			advance(1);
			return dev.status();
		},
		/** Holds Space until skipping starts, then runs until it finishes. */
		skip() {
			input().press(32);
			advance(32);
			input().release(32);
			for (let t = 0; t < 400 && scene().skipping; t++) advance(1);
			return dev.status();
		},
		/** Runs until `test()` is true or `maxSteps` pass; returns whether it became true. */
		until(test: () => boolean, maxSteps = 900) {
			for (let n = 0; n < maxSteps; n++) {
				if (test()) return true;
				advance(1);
			}
			return test();
		},
		status() {
			const g = game();
			const p = player();
			return {
				room: dev.room(),
				frame: g.frameCount,
				player: p ? [Math.round(p.x), Math.round(p.y)] : null,
				interact: g.globals.get('interact'),
				inbattle: g.globals.get('inbattle'),
				objects: [...new Set(g.instances.map((i) => i.object.name))],
				warnings: g.warnings,
			};
		},
		find: (name: string) => game().instances.filter((i) => i.object.name === name),

		/**
		 * Walks the player to (x, y) along a path found with a grid search over the room, using the
		 * engine's own collision checks against walls and slopes. Stops early if a cutscene starts.
		 */
		navigateTo(x: number, y: number, maxSteps = 1500) {
			const g = game();
			const p = player();
			if (!p) return { reached: false, reason: 'no player', ...dev.status() };
			// Whatever the player has collision events with (walls, solid NPCs, slopes) blocks movement.
			const blocking = [...(g.eventTable(p.object.index).get(4)?.keys() ?? [])];
			const blockers = g.instances.filter((i) => i !== p && blocking.some((obj) => g.isA(i, obj)));
			const cell = 4;
			const cols = Math.ceil(g.roomWidth / cell);
			const rows = Math.ceil(g.roomHeight / cell);
			const ox = p.x;
			const oy = p.y;
			const free = (cx: number, cy: number) => {
				p.x = cx * cell;
				p.y = cy * cell;
				return !blockers.some((b) => g.collide(p, b));
			};
			const start = [Math.round(ox / cell), Math.round(oy / cell)];
			const goal = [Math.round(x / cell), Math.round(y / cell)];
			const prev = new Map<number, number>();
			const key = (cx: number, cy: number) => cy * cols + cx;
			const queue = [start];
			prev.set(key(start[0], start[1]), -1);
			let found = false;
			while (queue.length) {
				const [cx, cy] = queue.shift()!;
				if (Math.abs(cx - goal[0]) <= 1 && Math.abs(cy - goal[1]) <= 1) {
					goal[0] = cx;
					goal[1] = cy;
					found = true;
					break;
				}
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || prev.has(key(nx, ny)) || !free(nx, ny)) continue;
					prev.set(key(nx, ny), key(cx, cy));
					queue.push([nx, ny]);
				}
			}
			p.x = ox;
			p.y = oy;
			if (!found) return { reached: false, reason: 'no path', ...dev.status() };
			const path: number[][] = [];
			for (let k = key(goal[0], goal[1]); k !== -1; k = prev.get(k)!) path.unshift([(k % cols) * cell, Math.floor(k / cols) * cell]);

			let steps = 0;
			for (const [wx, wy] of path) {
				while (steps < maxSteps) {
					if (g.globals.get('interact') !== 0) return { reached: false, reason: 'cutscene', ...dev.status() };
					const q = player();
					if (!q) return { reached: false, reason: 'player gone', ...dev.status() };
					const dx = wx - q.x;
					const dy = wy - q.y;
					if (Math.abs(dx) < 3 && Math.abs(dy) < 3) break;
					const keys = [];
					if (Math.abs(dx) >= 3) keys.push(dx > 0 ? 39 : 37);
					if (Math.abs(dy) >= 3) keys.push(dy > 0 ? 40 : 38);
					for (const k of keys) input().press(k);
					advance(1);
					for (const k of keys) input().release(k);
					steps++;
				}
			}
			advance(2);
			return { reached: steps < maxSteps, ...dev.status() };
		},
	};
	(window as unknown as { __dev: typeof dev }).__dev = dev;
}
