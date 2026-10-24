// Development-only autoplayer for finding engine bugs: plays the game as fast as the machine allows.
// Dialogue: presses Z. When stalled, talks to everyone near the furthest point twice, taking the first
// and then the second option at choices. Battles: FIGHT with HP kept full. Rooms: walks to the exit that
// leads furthest along the story (passing through walls, so story triggers on the way still fire),
// learning which doors lead forward. Logs room changes, battles, stalls and engine warnings.
import type { GameScene } from './gameScene.ts';
import type { Instance } from './vm/Instance.ts';
import { GMArray } from './vm/values.ts';

const VK_Z = 90;
const VK_X = 88;
const VK_RIGHT = 39;
const VK_DOWN = 40;
const STEP_PX = 3;
/** Steps without new story ground before talking to people, and before giving up and warping. */
const STALL_TALK = 2500;
const STALL_WARP = 30 * 60 * 9;
/** Objects that stop the player when touched, like the invisible electric maze: walked around, not through. */
const HAZARDS = new Set(['obj_shockblock']);
/** Rooms of the last fights and the endings, which move on by themselves (the autoplayer never warps out). */
const SELF_RUNNING_ROOMS = /^room_(f_|flowey|empty|castle_exit|undertale_end|end_|credits)/;
/** In battle, things the heart is steered onto, and the hearts that can be steered (most specific first). */
const HEART_TARGETS = /^(obj_answernodule|obj_anybt|obj_6\w*_act|obj_flowey_fightbt)$/;
const HEARTS = ['obj_fakeheart', 'obj_vsflowey_heart', 'obj_heart'];
/** Battle turns where FIGHT doesn't lower the monsters' HP before trying other actions, then the rotation (buttons: 0 FIGHT, 1 ACT, 3 MERCY; ACT options numbered as the game lays them out). */
const FIGHT_TURNS = 6;
// Spare straight after each ACT: one ACT can make a monster spareable and the next undo it.
const BATTLE_PLAN = [
	...[0, 3, 1, 4, 2, 5].flatMap((act) => [
		{ button: 1, act },
		{ button: 3, act: 0 },
	]),
	{ button: 0, act: 0 },
];
/** MERCY's second option, Flee: every other turn once a battle has gone on this long (one that can't be spared). */
const FLEE = { button: 3, act: 1 };
const FLEE_AFTER_TURNS = 30;
/** In spare mode: never FIGHT; each ACT option in turn, then MERCY's Spare. */
const SPARE_PLAN = BATTLE_PLAN.filter((p) => p.button !== 0);
/** Things that carry the player across the room (Snowdin's igloo): stepped around like doors not taken. */
const TELEPORTERS = new Set(['obj_teleigloo']);
/** obj_doorparent descendants that aren't exits. Ice tiles stop the player for a moment as they slide. */
const NOT_DOORS = new Set(['obj_iceevent']);
/** Grid size for paths around hazards. */
const PATH_CELL = 2;
/** Talks per person per story stage: the first takes the first option at choices, the second the second. */
const TALKS_EACH = 2;

interface DoorMemory {
	/** Story position (room order index) the door led to, once tried. */
	leadsTo: number;
	/** How often it has been taken; repeats are penalised so dead ends aren't revisited forever. */
	uses: number;
}

interface DoorPlace {
	object: number;
	x: number;
	y: number;
}

export function createAutoplay(getScene: () => GameScene) {
	const scene = () => getScene();
	const game = () => scene().game;
	const log: string[] = [];
	const doors = new Map<string, DoorMemory>();
	let room = '';
	let roomSteps = 0;
	let target: Instance | null = null;
	let targetKey = '';
	/** Keys of every stacked piece of the target door: what one piece leads to, they all do. */
	let targetGroup: string[] = [];
	let entranceKey = '';
	/** The door we came in by (object index and position), kept across a battle in the room. */
	let entrance: DoorPlace | null = null;
	let entranceBeforeBattle: { room: string; door: DoorPlace | null } | null = null;
	let blocked = new Set<string>();
	let lastProgress = 0;
	let steps = 0;
	let battles = 0;
	let warningsSeen = 0;
	let maxOrder = 0;
	let wasFighting = false;
	let choiceSteps = 0;
	let saveMenuSteps = 0;
	let sawEnding = false;
	/** Last step the player touched the door it was heading for. */
	let touchedTarget = -1;
	let sidestep: number[] | null = null;
	/** Arrow key held while sliding on ice. */
	let iceKey = 0;
	/** The arrow key (left 37, up 38, right 39, down 40) for the larger part of a move. */
	const arrowFor = (dx: number, dy: number) => (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 39 : 37) : dy > 0 ? 40 : 38);
	const holdIceKey = (key: number) => {
		if (key === iceKey) return;
		if (iceKey) game().input.release(iceKey);
		if (key) game().input.press(key);
		iceKey = key;
	};
	/** Where the player stood before this step's move; the move itself is handed to the game (ghostMove). */
	let ghost: { inst: Instance; x: number; y: number } | null = null;

	const order = (name: string) => game().data.roomOrder.indexOf(game().data.roomNames.indexOf(name));
	const global = (name: string) => {
		const v = game().globals.get(name);
		return typeof v === 'number' ? v : 0;
	};
	const has = (name: string) => game().instances.some((i) => !i.destroyed && i.object.name === name);
	/** The player; the last fight's fake overworld has a stand-in that works the same way. */
	const player = () =>
		game().instances.find((i) => !i.destroyed && i.object.name === 'obj_mainchara') ??
		game().instances.find((i) => !i.destroyed && i.object.name === 'obj_mainchara_fake');
	const doorKey = (d: Instance) => `${room}:${d.object.name}@${d.x},${d.y}`;
	const doorParent = () => game().data.objects.findIndex((o) => o.name === 'obj_doorparent');
	/** Exits: descendants of obj_doorparent, except floor tiles that share the parent (like ice). */
	const isDoor = (i: Instance) => !i.destroyed && !NOT_DOORS.has(i.object.name) && game().isA(i, doorParent());
	/** What the ghost walk passes through: walls, diagonal walls and solid people. */
	let wallObjects: number[] | null = null;
	const walls = () =>
		(wallObjects ??= ['obj_solidparent', 'obj_solidnpcparent', 'obj_diagoparent'].map((n) => game().data.objects.findIndex((o) => o.name === n)).filter((i) => i >= 0));
	/** What a walk steps around: doors (other than the one it's heading for) and teleporters. */
	const inTheWay = (i: Instance) => isDoor(i) || (!i.destroyed && TELEPORTERS.has(i.object.name));
	const onIce = (p: Instance) => game().instances.some((i) => !i.destroyed && i.object.name === 'obj_iceevent' && game().collide(p, i));
	const stalled = () => steps - lastProgress > STALL_TALK;
	const talkStage = () => `${global('plot')}`;
	/** Rooms where everyone has been talked to at the current story stage. */
	const talkedOut = new Set<string>();
	const roomAt = (o: number) => game().data.roomNames[game().data.roomOrder[o]] ?? '';

	function frame(): void {
		const s = scene();
		const r = game().renderer;
		s.update();
		r.begin();
		s.draw();
		r.end();
		steps++;
	}

	function center(i: Instance) {
		const b = game().bounds(i);
		return b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } : { x: i.x, y: i.y };
	}

	/** Places the autoplayer couldn't get past by itself. */
	const warps: string[] = [];

	/** Rooms reached (story positions), and side rooms found to lead nowhere new. */
	const visited = new Set<number>();
	/** The story stage (global.plot) on the first visit to each room, for the coverage sweep. */
	const plotAt = new Map<number, number>();
	const deadEnds = new Set<number>();
	/** The furthest room reached that isn't a dead end. */
	const frontier = () => Math.max(0, ...[...visited].filter((o) => !deadEnds.has(o)));

	/** The door we came in by; doors are often several stacked instances, and every piece counts. */
	const isEntrance = (d: Instance) => !!entrance && d.object.index === entrance.object && Math.hypot(d.x - entrance.x, d.y - entrance.y) <= 60;

	/** Doors in the room, best first: unknown or forward-leading ones, never the one we came in by. */
	function pickDoor(): Instance | null {
		const g = game();
		const here = order(room);
		const candidates = g.instances.filter(isDoor);
		// A door into a dead end doesn't count as leading forward.
		const forward = (mem: DoorMemory) => mem.leadsTo > here && !deadEnds.has(mem.leadsTo);
		// Every door known and none leads forward: a dead end, so the frontier moves back.
		if (candidates.length && candidates.every((d) => doors.has(doorKey(d)) && !forward(doors.get(doorKey(d))!))) {
			deadEnds.add(here);
		}
		const atFrontier = here >= frontier();
		const score = (d: Instance) => {
			const key = doorKey(d);
			if (blocked.has(key)) return -1000;
			const mem = doors.get(key);
			// Stalled and done talking here: look for rooms with people not yet talked to at this stage.
			if (stalled() && talkedOut.has(`${room}:${talkStage()}`)) {
				// Untried doors first: one look is cheap, and the way on may simply be one not taken yet.
				if (!mem) return 320 - (isEntrance(d) ? 400 : 0);
				// Rooms nearest the furthest point reached first: whoever moves the story on is likely close by.
				if (talkedOut.has(`${roomAt(mem.leadsTo)}:${talkStage()}`) || mem.leadsTo > order('room_outsideworld')) return -5 * mem.uses;
				return 300 - 10 * Math.abs(maxOrder - mem.leadsTo) - mem.uses;
			}
			if (mem) {
				// Behind the frontier: head back toward it by the door that leads furthest.
				if (!atFrontier) return forward(mem) ? 400 + mem.leadsTo : -100 + mem.leadsTo / 1000;
				// At the frontier: known doors only if nothing new is left; forward ones first, the nearest next room
				// first (a door that jumps far ahead may skip a stretch of the story), repeats cost.
				return (forward(mem) ? 200 - Math.min(100, mem.leadsTo - here) : -50) - 150 * mem.uses;
			}
			// Unknown doors are explored at the frontier only; prefer the usual "onward" letters.
			const letter = d.object.name.replace('obj_door', '').replace('musicfade', '').replace('_musfade', '');
			const pref: Record<string, number> = { A: 50, X: 40, C: 30, D: 20 };
			return (atFrontier ? 250 : 0) + (pref[letter] ?? 10) - (isEntrance(d) ? 400 : 0);
		};
		candidates.sort((a, b) => score(b) - score(a));
		const best = candidates[0];
		return best && score(best) > -1000 ? best : null;
	}

	/** How often each person or sign has been talked to, per story stage. */
	const talked = new Map<string, number>();
	const talkedEnough = (key: string) => (talked.get(key) ?? 0) >= TALKS_EACH;
	let talkTarget: Instance | null = null;
	let talkSteps = 0;
	/** Which option to take at the next choice: 0 for the first talk with someone, 1 for the second. */
	let talkPick = 0;

	/** Moves the player one step toward (dx, dy) without touching any of `avoid` (doors), sidestepping them. */
	function stepToward(p: Instance, dx: number, dy: number, avoid: Instance[]): void {
		const g = game();
		ghost = { inst: p, x: p.x, y: p.y };
		const sx = Math.max(-STEP_PX, Math.min(STEP_PX, dx));
		const sy = Math.max(-STEP_PX, Math.min(STEP_PX, dy));
		const ox = p.x;
		const oy = p.y;
		// Once sidestepping, keep the same direction until clear, or it can bob back and forth forever.
		const moves = [[sx, sy], [sx, 0], ...(sidestep ? [sidestep] : []), [0, sy], [0, STEP_PX], [0, -STEP_PX], [STEP_PX, 0], [-STEP_PX, 0]];
		for (const [k, [mx, my]] of moves.entries()) {
			if (mx === 0 && my === 0) continue;
			p.x = ox + mx;
			p.y = oy + my;
			if (!avoid.some((d) => g.collide(p, d))) {
				sidestep = k < 2 ? null : [mx, my];
				return;
			}
		}
		// Hemmed in by doors on every side: go straight on rather than standing still forever.
		p.x = ox + sx;
		p.y = oy + sy;
	}

	/** Path around hazards to the target door, as player positions; recomputed for each new target. */
	let hazardPath: { x: number; y: number }[] = [];
	let hazardPathFor = '';

	/**
	 * Breadth-first search over player positions that touch none of `hazards` (walls are ignored, as when
	 * walking straight), ending where the player's centre is on (gx, gy). Empty if there is no way.
	 */
	function planPath(p: Instance, gx: number, gy: number, hazards: Instance[]): { x: number; y: number }[] {
		const g = game();
		const ox = p.x;
		const oy = p.y;
		const pc = center(p);
		const offX = pc.x - p.x;
		const offY = pc.y - p.y;
		const cols = Math.ceil(g.roomWidth / PATH_CELL) + 1;
		const rows = Math.ceil(g.roomHeight / PATH_CELL) + 1;
		const free = (cx: number, cy: number) => {
			p.x = ox + (cx - Math.round(ox / PATH_CELL)) * PATH_CELL;
			p.y = oy + (cy - Math.round(oy / PATH_CELL)) * PATH_CELL;
			return !hazards.some((h) => g.collide(p, h));
		};
		const start = [Math.round(ox / PATH_CELL), Math.round(oy / PATH_CELL)];
		const at = (cx: number, cy: number) => ({ x: ox + (cx - start[0]) * PATH_CELL, y: oy + (cy - start[1]) * PATH_CELL });
		const prev = new Map<number, number>([[start[1] * cols + start[0], -1]]);
		const queue = [start];
		let goal = -1;
		for (let q = 0; q < queue.length && goal < 0; q++) {
			const [cx, cy] = queue[q];
			for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
				const key = ny * cols + nx;
				if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || prev.has(key) || !free(nx, ny)) continue;
				prev.set(key, cy * cols + cx);
				const pos = at(nx, ny);
				if (Math.abs(pos.x + offX - gx) <= PATH_CELL && Math.abs(pos.y + offY - gy) <= PATH_CELL) {
					goal = key;
					break;
				}
				queue.push([nx, ny]);
			}
		}
		p.x = ox;
		p.y = oy;
		const path: { x: number; y: number }[] = [];
		for (let k = goal; k >= 0 && prev.get(k) !== -1; k = prev.get(k)!) path.unshift(at(k % cols, Math.floor(k / cols)));
		return path;
	}

	/** Walks below the next untried interactable, faces it and presses Z. Returns true while busy. */
	function talk(p: Instance): boolean {
		const g = game();
		const root = g.data.objects.findIndex((o) => o.name === 'obj_interactable');
		const keyOf = (i: Instance) => `${room}:${i.object.name}@${Math.round(i.x)},${Math.round(i.y)}:${talkStage()}`;
		if (!talkTarget || talkTarget.destroyed || talkedEnough(keyOf(talkTarget))) {
			talkTarget = g.instances.find((i) => !i.destroyed && root >= 0 && g.isA(i, root) && !talkedEnough(keyOf(i))) ?? null;
			talkSteps = 0;
			if (talkTarget) sidestep = null;
			else {
				// Everyone here is done: let the door picker move on to rooms not yet talked out.
				if (!talkedOut.has(`${room}:${talkStage()}`)) target = null;
				talkedOut.add(`${room}:${talkStage()}`);
				return false;
			}
		}
		const t = talkTarget;
		const tb = g.bounds(t);
		const pb = g.bounds(p);
		if (!tb || !pb) {
			talked.set(keyOf(t), TALKS_EACH);
			return true;
		}
		// Stand just below it, centred.
		const wantX = (tb.left + tb.right) / 2 - (pb.right - pb.left) / 2 - (pb.left - p.x);
		const wantY = tb.bottom + 1 - (pb.top - p.y);
		const dx = wantX - p.x;
		const dy = wantY - p.y;
		talkSteps++;
		if ((Math.abs(dx) > 2 || Math.abs(dy) > 2) && talkSteps < 400) {
			stepToward(p, dx, dy, g.instances.filter(inTheWay));
			return true;
		}
		talkPick = talked.get(keyOf(t)) ?? 0;
		talked.set(keyOf(t), talkPick + 1);
		talkSteps = 0;
		log.push(`[${steps}] talk to ${t.object.name} in ${room}${talkPick ? ' (second option)' : ''}`);
		g.input.tap(38); // face up
		for (let n = 0; n < 2; n++) frame();
		g.input.tap(VK_Z);
		return true;
	}

	function onRoomChange(from: string, to: string): void {
		const fromOrder = order(from);
		const toOrder = order(to);
		// Only learn the door if we were on it: a cutscene can also move the player to another room.
		if (targetKey && steps - touchedTarget < 30) {
			for (const key of targetGroup) doors.set(key, { leadsTo: toOrder, uses: (doors.get(key)?.uses ?? 0) + 1 });
		}
		log.push(`[${steps}] ${from}(${fromOrder}) -> ${to}(${toOrder})${toOrder < fromOrder ? ' (back)' : ''}`);
		room = to;
		roomSteps = 0;
		talkTarget = null;
		talkPick = 0;
		target = null;
		targetKey = '';
		targetGroup = [];
		hazardPathFor = '';
		blocked = new Set();
		// Battles and other special rooms sit after the story rooms; coming back from one isn't using a door.
		const special = (o: number) => o > order('room_outsideworld');
		if (special(toOrder) && !special(fromOrder)) entranceBeforeBattle = { room: from, door: entrance };
		const back = special(fromOrder) && entranceBeforeBattle?.room === to ? entranceBeforeBattle : null;
		entrance = back ? back.door : null;
		entranceKey = back ? 'kept' : '';
		// Only main-story rooms count as progress (battle and special rooms sit later in the room list).
		if (toOrder >= 0 && toOrder <= order('room_outsideworld')) {
			const before = frontier();
			visited.add(toOrder);
			if (!plotAt.has(toOrder)) plotAt.set(toOrder, global('plot'));
			if (toOrder > maxOrder) maxOrder = toOrder;
			if (frontier() > before) lastProgress = steps;
		}
	}

	function act(): void {
		const g = game();
		// Keep HP high: bug-hunting, not dodging. At least 99, since some hits take more than a full bar
		// in one step and the game checks for death before the next.
		const maxhp = global('maxhp');
		if (maxhp > 0 && global('hp') < Math.max(maxhp, 99)) g.globals.set('hp', Math.max(maxhp, 99));
		// The last fight keeps its own HP.
		if (g.globals.has('my_hp') && global('my_hp') < 99) g.globals.set('my_hp', 99);

		const name = g.data.roomNames[g.roomIndex] ?? '';
		if (name !== room) onRoomChange(room, name);
		roomSteps++;

		const fighting = global('inbattle') !== 0;
		if (fighting && !wasFighting) {
			battles++;
			log.push(`[${steps}] battle in ${room}`);
		}
		wasFighting = fighting;
		if (fighting) {
			// Choices made by moving the heart (quiz answers, the fake buttons at the end of the king's fight, the
			// buttons the souls drop in the last fight): steer it onto the first one on screen and confirm.
			// Any will do; HP is kept full.
			const onScreen = (i: Instance) => {
				const c = center(i);
				return c.y >= 0 && c.y <= g.roomHeight && c.x >= 0 && c.x <= g.roomWidth;
			};
			// In spare mode the rightmost choice (SPARE beside FIGHT at the end of the king's fight); else the first.
			const choices = g.instances.filter((i) => !i.destroyed && HEART_TARGETS.test(i.object.name) && onScreen(i));
			const answer = mode === 'spare' ? choices.sort((p, q) => q.x - p.x)[0] : choices[0];
			const heart = HEARTS.map((n) => g.instances.find((i) => !i.destroyed && i.object.name === n)).find((i) => i);
			if (answer && heart) {
				const ac = center(answer);
				const hc = center(heart);
				const dx = ac.x - hc.x;
				const dy = ac.y - hc.y;
				heart.x += Math.max(-STEP_PX, Math.min(STEP_PX, dx));
				heart.y += Math.max(-STEP_PX, Math.min(STEP_PX, dy));
				// Z all along: text between the buttons needs it too, and a choice only counts with the heart on it.
				if (steps % 4 === 0) g.input.tap(VK_Z);
				return;
			}
			if (chooseBattleAction(g)) return;
			if (steps % 4 === 0) g.input.tap(VK_Z);
			return;
		}
		battleTurns = 0;
		idleTurns = 0;
		lastMonsterHp = Infinity;
		// Shops are a menu room: back out of any submenu, go down to Exit and take it, then read the
		// goodbye (Z alone keeps shopping).
		if (/^room_shop/.test(room)) {
			const k = roomSteps % 60;
			if (k === 0 || k === 6) g.input.tap(VK_X);
			if (k === 12 || k === 16 || k === 20) g.input.tap(40);
			if (k >= 26 && k % 6 === 2) g.input.tap(VK_Z);
			return;
		}
		// At a choice, wait for it to accept input, then take the option for this talk.
		if (has('obj_choicer')) {
			choiceSteps++;
			if (choiceSteps === 8 && talkPick === 1) g.input.tap(VK_RIGHT);
			if (choiceSteps === 12) g.input.tap(VK_Z);
			return;
		}
		choiceSteps = 0;
		const talking = has('OBJ_WRITER') || has('obj_dialoguer');
		const interact = global('interact');
		const p = player();
		if (talking || interact === 1 || !p) {
			if (steps % 4 === 0) g.input.tap(VK_Z);
			return;
		}
		if (interact !== 0) {
			// The save point's menu (5): save, as a player would (the game relies on file0 existing, e.g. when
			// it closes itself mid-story), then close it. Other values are transitions.
			if (interact === 5) {
				saveMenuSteps++;
				if (saveMenuSteps === 6) g.input.tap(VK_Z);
				if (saveMenuSteps > 20 && saveMenuSteps % 8 === 0) g.input.tap(VK_X);
			}
			return;
		}
		saveMenuSteps = 0;

		// Stuck for a while: the story may need a conversation. Talk to each person or sign twice per story
		// stage, in every room, since the one who moves the story on may be behind the frontier.
		if (stalled() && talk(p)) return;

		if (!entranceKey) {
			const near = g.instances.filter(isDoor).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
			entrance = near && Math.hypot(near.x - p.x, near.y - p.y) < 80 ? { object: near.object.index, x: near.x, y: near.y } : null;
			entranceKey = near && entrance ? doorKey(near) : '-';
		}
		if (!target || target.destroyed) {
			sidestep = null;
			target = pickDoor();
			targetKey = target ? doorKey(target) : '';
			const t = target;
			targetGroup = t ? g.instances.filter((i) => !i.destroyed && i.object === t.object && Math.hypot(i.x - t.x, i.y - t.y) <= 60).map(doorKey) : [];
			roomSteps = Math.min(roomSteps, 1);
		}
		if (!target) {
			// No usable door: try talking to whatever is around.
			if (steps % 8 === 0) g.input.tap(VK_Z);
			return;
		}
		// Walk straight at the door, through anything in the way. If the move sets off a cutscene,
		// the player is put back where they stood (see run()), as a solid trigger would do in real play.
		const c = center(target);
		const pc = center(p);
		const dx = c.x - pc.x;
		const dy = c.y - pc.y;
		// Don't brush past other doors on the way (like the stairs we came in by): sidestep them.
		// Doors are often several stacked instances; neighbouring pieces of the target count as the target.
		const t = target;
		const others = g.instances.filter(
			(i) => i !== t && inTheWay(i) && !(i.object === t.object && Math.hypot(i.x - t.x, i.y - t.y) <= 60),
		);
		const hazards = g.instances.filter((i) => !i.destroyed && HAZARDS.has(i.object.name));
		if (hazards.length && hazardPathFor !== targetKey) {
			hazardPath = planPath(p, c.x, c.y, hazards);
			hazardPathFor = targetKey;
			if (!hazardPath.length) log.push(`[${steps}] ${room}: no way around ${hazards[0].object.name} to ${t.object.name}`);
		}
		if (hazards.length && hazardPath.length) {
			// Follow the path exactly; a sidestep could touch the hazard.
			while (hazardPath.length && Math.hypot(hazardPath[0].x - p.x, hazardPath[0].y - p.y) < 0.5) hazardPath.shift();
			const next = hazardPath[0] ?? { x: p.x, y: p.y };
			ghost = { inst: p, x: p.x, y: p.y };
			p.x += Math.max(-STEP_PX, Math.min(STEP_PX, next.x - p.x));
			p.y += Math.max(-STEP_PX, Math.min(STEP_PX, next.y - p.y));
		} else stepToward(p, dx, dy, others);
		if (g.instances.some((i) => !i.destroyed && i.object === t.object && Math.hypot(i.x - t.x, i.y - t.y) <= 60 && g.collide(p, i))) touchedTarget = steps;
		if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && roomSteps > 300) {
			// Standing on it with nothing happening: this door doesn't work right now.
			blocked.add(targetKey);
			log.push(`[${steps}] ${room}: ${target.object.name} did nothing`);
			target = null;
		}
	}

	/**
	 * Moves to `roomIndex` at once, entering by the usual first marker. The change is made right away so the
	 * old room can't run another step first (a door touched in it would change global.entrance, and a cutscene
	 * could set global.interact again). A cutscene cut short this way would otherwise leave the player frozen.
	 */
	function jump(roomIndex: number): void {
		const g = game();
		g.globals.set('entrance', 1);
		g.globals.set('interact', 0);
		g.gotoRoom(roomIndex);
		g.afterFrame();
		g.globals.set('interact', 0);
	}

	/** Player turns taken in the current battle, and how long the current menu has been open. */
	let battleTurns = 0;
	/** Player turns since FIGHT last lowered the monsters' HP (summed over global.monsterhp). */
	let idleTurns = 0;
	let lastMonsterHp = Infinity;
	/** When the monsters' HP last went down: a battle still being worn down isn't stuck. */
	let lastHpChange = 0;
	const monsterHp = (g: ReturnType<typeof game>) => {
		const hp = g.globals.get('monsterhp');
		if (!(hp instanceof GMArray)) return 0;
		let sum = 0;
		for (let k = 0; k < 3; k++) sum += Number(hp.get(k)) || 0;
		return sum;
	};
	/** 'fight' wins battles with FIGHT first; 'spare' never fights, to play the routes that spare everyone. */
	let mode: 'fight' | 'spare' = 'fight';
	let menuLevel = -1;
	let menuSteps = 0;

	/**
	 * On the player's turn, picks the button and ACT option for this turn; Z presses do the rest. FIGHT
	 * first; a battle that FIGHT doesn't end (a boss that has to be talked down, say) then gets each ACT
	 * option, MERCY's Spare and FIGHT in turn. global.bmenuno is the menu level (0 the buttons, 10 the ACT
	 * list) and bmenucoord[0] the button. ACT options are reached with the arrow keys, as a player would,
	 * so the game keeps the cursor on options that exist. Returns true while Z should wait.
	 */
	function chooseBattleAction(g: ReturnType<typeof game>): boolean {
		const coord = g.globals.get('bmenucoord');
		if (!(coord instanceof GMArray)) return false;
		const level = global('bmenuno');
		if (global('myfight') !== 0 || global('mnfight') !== 0) {
			menuLevel = -1;
			return false;
		}
		if (level !== menuLevel) {
			if (level === 0) {
				battleTurns++;
				// FIGHT stays the choice while it wears the monsters down; only turns where it doesn't count.
				const hp = monsterHp(g);
				if (hp < lastMonsterHp) {
					idleTurns = 0;
					lastHpChange = steps;
				} else idleTurns++;
				lastMonsterHp = hp;
			}
			menuLevel = level;
			menuSteps = 0;
		}
		menuSteps++;
		const t = mode === 'spare' ? battleTurns - 1 : idleTurns - 1 - FIGHT_TURNS;
		const rotation = mode === 'spare' ? SPARE_PLAN : BATTLE_PLAN;
		// A long battle: Flee every other turn; in spare mode FIGHT on the others, since some can only be ended
		// that way (the king breaks the MERCY button) and the end of them still offers a choice to spare.
		const long = battleTurns > FLEE_AFTER_TURNS;
		const plan = long && battleTurns % 2 === 0 ? FLEE : long && mode === 'spare' ? { button: 0, act: 0 } : t < 0 ? { button: 0, act: 0 } : rotation[t % rotation.length];
		if (level === 0) coord.set(0, plan.button);
		if (level === 10) {
			// The options sit in two columns of three: 0-2 down the left, 3-5 down the right. The game skips
			// positions with no option, so a missing one just lands on a neighbour.
			const row = plan.act % 3;
			if (menuSteps === 2 && plan.act >= 3) g.input.tap(VK_RIGHT);
			if (row >= 1 && menuSteps === 6) g.input.tap(VK_DOWN);
			if (row >= 2 && menuSteps === 10) g.input.tap(VK_DOWN);
			return menuSteps < 14;
		}
		if (level === 4 && plan.act === 1) {
			if (menuSteps === 2) g.input.tap(VK_DOWN);
			return menuSteps < 6;
		}
		return false;
	}

	/** What the room looked like when the autoplayer gave up on it, for working out why. */
	const warpInfo: unknown[] = [];
	function snapshot() {
		const g = game();
		const p = player();
		return {
			steps,
			room,
			plot: global('plot'),
			interact: global('interact'),
			player: p ? [Math.round(p.x), Math.round(p.y)] : null,
			target: targetKey,
			doors: g.instances.filter(isDoor).map((d) => `${d.object.name}@${d.x},${d.y} -> ${doors.get(doorKey(d))?.leadsTo ?? '?'}${blocked.has(doorKey(d)) ? ' blocked' : ''}`),
			objects: [...new Set(g.instances.filter((i) => !i.destroyed).map((i) => i.object.name))],
		};
	}

	const tap = (key: number, times = 1, gap = 4) => {
		for (let k = 0; k < times; k++) {
			game().input.tap(key);
			for (let n = 0; n < gap; n++) frame();
		}
	};

	return {
		log,
		/** What each door was found to lead to, by `room:object@x,y`. */
		doors,
		/** A snapshot of each room the autoplayer warped out of. */
		warpInfo,
		/**
		 * Coverage for rooms the run never reached: visits each with the story stage of the nearest earlier
		 * room that was reached, plays it for `stepsEach` steps and reports the engine warnings seen there.
		 * Rooms are entered directly, so the story around them may not be what a player would have, and a battle
		 * the autoplayer can't win (one that needs aiming, say) can still strand the rest of the sweep: start a
		 * new game and carry on from the next room if that happens.
		 */
		sweep(names: string[], stepsEach = 3000) {
			const report: { room: string; plot: number; warnings: string[]; reached: string }[] = [];
			for (const name of names) {
				const g = game();
				if (!g || g.ended) break;
				const o = order(name);
				let near = -1;
				for (const v of plotAt.keys()) if (v < o && v > near) near = v;
				const plot = near >= 0 ? plotAt.get(near)! : 0;
				g.globals.set('plot', plot);
				jump(g.data.roomNames.indexOf(name));
				const before = g.warnings.length;
				lastProgress = steps;
				this.run(60000, stepsEach);
				// Let a battle finish before moving on: leaving one mid-way strands the room it started in, which
				// the battle had made persistent, and a later visit restores it half-used (doors already touched).
				for (let k = 0; k < 60 && game() === g && (global('inbattle') !== 0 || room === 'room_battle'); k++) this.run(5000, 1000);
				if (game() !== g) break;
				report.push({ room: name, plot, warnings: g.warnings.slice(before), reached: room });
			}
			return report;
		},
		/** Story rooms (by room-order position) never reached. */
		unvisited: () => {
			const last = order('room_outsideworld');
			const names: string[] = [];
			for (let o = 0; o <= last; o++) if (!visited.has(o)) names.push(game().data.roomNames[game().data.roomOrder[o]]);
			return names;
		},
		/**
		 * From the start of a fresh game: skips the story, names the player and reaches the first room.
		 * The random seed and clock are fixed, and the page loop is held, so a run can be replayed step
		 * for step.
		 */
		newGame(seed = 1, battleMode: 'fight' | 'spare' = 'fight') {
			mode = battleMode;
			(window as { __holdLoop?: boolean }).__holdLoop = true;
			game().audio.lockMute();
			game().setRandomSeed(seed);
			game().fixedClockFrom = game().frameCount;
			for (let n = 0; n < 30; n++) frame();
			// Hold Enter (the skip key) through the opening story.
			game().input.skipHeld = true;
			for (let n = 0; n < 32; n++) frame();
			game().input.skipHeld = false;
			for (let n = 0; n < 400 && scene().skipping; n++) frame();
			for (let n = 0; n < 30; n++) frame();
			tap(VK_Z, 1, 30); // title
			tap(VK_Z, 1, 20); // Begin Game
			tap(VK_Z, 4); // name: AAAA
			tap(40, 8); // down to the bottom row
			tap(39, 2); // Done
			tap(VK_Z, 1, 40);
			tap(39); // Yes
			tap(VK_Z);
			for (let n = 0; n < 600 && game().data.roomNames[game().roomIndex] !== 'room_area1'; n++) frame();
			return game().data.roomNames[game().roomIndex];
		},
		/** Plays for up to `ms` milliseconds or `maxSteps` steps; stops at the ending or when stuck. */
		run(ms = 15000, maxSteps = 1_000_000) {
			// Test runs are silent.
			const started = game();
			started.audio.lockMute();
			const end = performance.now() + ms;
			const startSteps = steps;
			let reason = 'time';
			while (performance.now() < end && steps - startSteps < maxSteps) {
				// The game can close itself (game_end); the page then goes back to the launcher.
				if (game() !== started || started.ended) {
					reason = 'game ended';
					break;
				}
				ghost = null;
				act();
				// act() moved the player where it should go; put it back and let the game make the move at the
				// point in the step where walking happens, passing through walls. A trigger that stops the
				// player then puts it back itself, as in real play.
				const moved = ghost as { inst: Instance; x: number; y: number } | null;
				// Ice slides the player the way an arrow key is held: hold one while stepping onto ice and while
				// sliding, or the ice just puts the player back.
				const p = player();
				if (moved && !moved.inst.destroyed) {
					const { inst } = moved;
					const dx = inst.x - moved.x;
					const dy = inst.y - moved.y;
					holdIceKey(onIce(inst) ? arrowFor(dx, dy) : 0);
					game().ghostMove = { inst, dx, dy, through: walls() };
					inst.x = moved.x;
					inst.y = moved.y;
				} else if (!(p && global('interact') === 1 && onIce(p))) holdIceKey(0);
				frame();
				if (game() !== started) continue;
				const w = game().warnings;
				while (warningsSeen < w.length) log.push(`[${steps}] WARNING ${w[warningsSeen++]} (in ${room})`);
				// The ending plays out, then the game goes back to its title by itself: that is the finish.
				if (room === 'room_undertale_end') sawEnding = true;
				if (sawEnding && /^room_(start|introstory|introimage|intromenu)$/.test(room)) {
					reason = 'finished: the ending played and the game returned to its title';
					sawEnding = false;
					break;
				}
				// No new story ground for ~9 minutes of game time: warp to the next story room and log it as
				// a place that needs a player action (a puzzle, a specific choice) or is a bug.
				// The last fights and the endings move on by themselves: no warping out of those.
				if (steps - lastProgress > STALL_WARP && global('inbattle') === 0 && !SELF_RUNNING_ROOMS.test(room)) {
					const g = game();
					// The first story room after the frontier not yet visited, so stretches skipped by a shortcut still
					// get played; one past the furthest room reached if there is none.
					const last = order('room_outsideworld');
					let next = frontier() + 1;
					while (next < last && visited.has(next)) next++;
					if (visited.has(next)) next = Math.min(maxOrder + 1, last);
					const nextName = g.data.roomNames[g.data.roomOrder[next]];
					warps.push(`${g.data.roomNames[g.data.roomOrder[frontier()]]} -> ${nextName}`);
					warpInfo.push(snapshot());
					log.push(`[${steps}] WARP (stalled at ${room}) -> ${nextName}`);
					jump(g.data.roomOrder[next]);
					lastProgress = steps;
				}
				// A battle that never ends (the last fights have rooms of their own and run longer); time spent
				// wearing a monster down doesn't count.
				const limit = room === 'room_battle' ? 10 : 40;
				if (global('inbattle') !== 0 && Math.min(roomSteps, steps - lastHpChange) > 30 * 60 * limit) {
					reason = `battle in ${room} has run ${limit} game minutes without progress`;
					break;
				}
			}
			return {
				reason,
				steps,
				gameMinutes: +(steps / 30 / 60).toFixed(1),
				room,
				furthest: started.data.roomNames[started.data.roomOrder[maxOrder]],
				battles,
				warps,
				lv: started.globals.get('lv'),
				plot: started.globals.get('plot'),
				recent: log.slice(-25),
			};
		},
		/** For testing: acts as if no progress has been made for `n` steps. */
		stall(n = STALL_TALK + 1) {
			lastProgress = steps - n;
		},
		status: () => ({ room, steps, maxOrder, battles, plot: global('plot'), interact: global('interact'), inbattle: global('inbattle'), target: targetKey }),
	};
}
