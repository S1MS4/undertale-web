import { type DataWin, parseDataWin } from './data/DataWin.ts';
import { saveExportFolder } from './exportFolder.ts';
import { setupHelpPanel } from './helpPanel.ts';
import { setupToolbar } from './toolbar.ts';
import { Keyboard, Pointer } from './input.ts';
import { patchKeyText } from './keyText.ts';
import { C_RED } from './render/draw.ts';
import { Renderer } from './render/Renderer.ts';
import { buildExport, ImportError, readExport } from './saveBundle.ts';
import { SaveStore } from './saves.ts';
import { GameScene } from './gameScene.ts';
import { cachedSource, devSource, forgetGame, type GameSource, pickedSource, rememberGame, SetupError } from './gameSource.ts';
import { Launcher, type Scene, uiAssets, uiPages } from './scenes.ts';

const FRAME_MS = 1000 / 30; // Undertale's room speed

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const status = document.querySelector<HTMLElement>('#status')!;
const picker = document.querySelector<HTMLInputElement>('#picker')!;
const exportButton = document.querySelector<HTMLButtonElement>('#export')!;
const exportStatus = document.querySelector<HTMLElement>('#export-status')!;
const volumeSlider = document.querySelector<HTMLInputElement>('#volume')!;
const volumeValue = document.querySelector<HTMLOutputElement>('#volume-value')!;
const audioToggle = document.querySelector<HTMLButtonElement>('#audio-toggle')!;
const setup = document.querySelector<HTMLElement>('#setup')!;
const gamePick = document.querySelector<HTMLButtonElement>('#game-pick')!;
const gamePicker = document.querySelector<HTMLInputElement>('#game-picker')!;
const setupStatus = document.querySelector<HTMLElement>('#setup-status')!;
const forgetButton = document.querySelector<HTMLButtonElement>('#forget-game')!;
const VOLUME_KEY = 'undertale-web-volume';

/** The volume slider's position (0-100), remembered in this browser. */
function storedVolume(): number {
	try {
		const v = Number(localStorage.getItem(VOLUME_KEY));
		return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
	} catch {
		return 100;
	}
}

/** Slider position to gain: squared, so the low end of the slider is as fine-grained as the ear is. */
const volumeGain = (position: number) => (position / 100) ** 2;

/**
 * Fills the window: the canvas takes the window's shape, at least 640x480 game pixels (Undertale's
 * native size), and is scaled up with sharp pixels.
 */
function fitCanvas(renderer: Renderer): void {
	const availW = Math.max(320, innerWidth);
	const availH = Math.max(240, innerHeight);
	const aspect = availW / availH;
	const width = aspect >= 4 / 3 ? Math.round(480 * aspect) : 640;
	const height = aspect >= 4 / 3 ? 480 : Math.round(640 / aspect);
	renderer.resize(width, height);
	canvas.style.width = `${availW}px`;
	canvas.style.height = `${availH}px`;
}

/** Parses data.win and checks it really is Undertale, the one game this engine runs. */
function parseGame(source: GameSource): DataWin {
	let data: DataWin;
	try {
		data = parseDataWin(source.data);
	} catch {
		throw new SetupError("That data.win couldn't be read. Pick the folder of an unmodified Undertale install.");
	}
	if (data.displayName !== 'UNDERTALE') throw new SetupError(`That folder holds "${data.displayName}", not Undertale.`);
	return data;
}

/** Shows the setup screen until the player picks their Undertale folder, then keeps its files for next time. */
function askForGame(): Promise<{ source: GameSource; data: DataWin }> {
	status.hidden = true;
	canvas.hidden = true;
	setup.hidden = false;
	gamePick.focus();
	gamePick.addEventListener('click', () => gamePicker.click());
	return new Promise((resolve) => {
		gamePicker.addEventListener('change', async () => {
			const selection = [...(gamePicker.files ?? [])];
			gamePicker.value = '';
			if (!selection.length) return;
			gamePick.disabled = true;
			setupStatus.textContent = 'Reading data.win…';
			try {
				const { source, files } = await pickedSource(selection);
				const data = parseGame(source);
				const kept = await rememberGame(files, (f) => {
					setupStatus.textContent = `Keeping a copy in this browser… ${Math.round(f * 100)}%`;
				});
				if (!kept) console.warn('This browser will ask for the folder again next time.');
				setup.hidden = true;
				canvas.hidden = false;
				resolve({ source, data });
			} catch (err) {
				if (!(err instanceof SetupError)) console.error(err);
				setupStatus.textContent = err instanceof SetupError ? err.message : 'Could not read that folder.';
				gamePick.disabled = false;
			}
		});
	});
}

/** The game files: from the install in development, otherwise from this browser's copy or the player's folder. */
async function loadGame(): Promise<{ source: GameSource; data: DataWin }> {
	if (import.meta.env.DEV) {
		const source = await devSource((f) => {
			status.textContent = `Loading data.win… ${Math.round(f * 100)}%`;
		});
		return { source, data: parseDataWin(source.data) };
	}
	forgetButton.hidden = false;
	status.textContent = 'Loading data.win…';
	const cached = await cachedSource();
	if (cached) {
		try {
			return { source: cached, data: parseGame(cached) };
		} catch {
			// A damaged copy: ask for the folder again, which replaces it.
		}
	}
	return askForGame();
}

async function start(): Promise<void> {
	// Save signing uses WebCrypto, which browsers only offer on https:// or localhost pages.
	if (!isSecureContext || !crypto.subtle) throw new Error('Open the game over https:// so saves can be signed.');

	const { source, data } = await loadGame();
	patchKeyText(data);
	status.hidden = false;
	status.textContent = 'Starting…';
	const renderer = new Renderer(canvas, data);
	const ui = uiAssets(data);
	const [saves] = await Promise.all([SaveStore.open(), renderer.loadPages(uiPages(ui))]);
	fitCanvas(renderer);
	addEventListener('resize', () => fitCanvas(renderer));

	const keyboard = new Keyboard(window);
	const pointer = new Pointer(canvas);
	let scene: Scene;

	// The game listens for keys on the window: keep the slider's arrow keys from moving the player too.
	volumeSlider.value = String(storedVolume());
	const showVolume = () => {
		volumeValue.value = `${volumeSlider.value}%`;
		audioToggle.classList.toggle('muted', volumeSlider.value === '0');
		audioToggle.title = `Volume: ${volumeSlider.value}%`;
		if (scene instanceof GameScene) scene.setVolume(volumeGain(Number(volumeSlider.value)));
	};
	showVolume();
	volumeSlider.addEventListener('input', showVolume);
	volumeSlider.addEventListener('change', () => {
		try {
			localStorage.setItem(VOLUME_KEY, volumeSlider.value);
		} catch {
			// Not remembered this time (private window or blocked storage); the slider still works.
		}
	});
	for (const type of ['keydown', 'keyup'] as const) volumeSlider.addEventListener(type, (e) => e.stopPropagation());
	// Done with the mouse: hand the keyboard back to the game.
	volumeSlider.addEventListener('pointerup', () => volumeSlider.blur());

	// Export works any time a game is running (it saves the current spot first) or a save exists.
	const refreshExport = () => {
		exportButton.disabled = !(scene instanceof GameScene) && saves.files.size === 0;
	};
	const resetLauncher = () => launcher.reset(saves.hasProgress(), saves.hasProgress('new'));
	/** `loadSave`: go straight to the saved spot (Continue, Import) rather than through the intro and title menu. */
	const boot = (loadSave: boolean) => {
		// Development only: ?mute runs the game without opening the sound device (automated tests).
		const silent = import.meta.env.DEV && new URLSearchParams(location.search).has('mute');
		scene = new GameScene(
			renderer,
			data,
			source.musicUrl,
			saves,
			() => {
				refreshExport();
				resetLauncher();
				scene = launcher;
			},
			loadSave,
			silent,
		);
		showVolume();
		// Development only: lets the console inspect and drive the running game.
		if (import.meta.env.DEV) {
			(window as unknown as { __scene: Scene; __saves: SaveStore }).__scene = scene;
			(window as unknown as { __saves: SaveStore }).__saves = saves;
			// ?hold freezes the game from its first step, for autoplay runs that must repeat exactly.
			if (new URLSearchParams(location.search).has('hold')) (window as { __holdLoop?: boolean }).__holdLoop = true;
			void import('./devtools.ts').then((m) => m.installDevtools(() => scene));
			void import('./autoplay.ts').then((m) => {
				(window as unknown as { __auto: unknown }).__auto = m.createAutoplay(() => scene as GameScene);
			});
		}
	};
	const importFolder = async (selection: File[]) => {
		try {
			await saves.use('imported', await readExport(selection, saves.key));
			refreshExport();
			boot(true);
		} catch (err) {
			if (!(err instanceof ImportError)) console.error(err);
			launcher.say(err instanceof ImportError ? err.message : 'Could not read that folder.', C_RED);
		}
	};

	const launcher = new Launcher(renderer, ui, keyboard, pointer, (action) => {
		if (action === 'import') {
			picker.click();
		} else if (action === 'new') {
			// Always a blank slate: nothing carries over from an imported save.
			void saves.use('new', new Map()).then(() => {
				refreshExport();
				boot(false);
			});
		} else {
			boot(true);
		}
	});
	resetLauncher();
	scene = launcher;

	picker.addEventListener('change', () => {
		const selection = [...(picker.files ?? [])];
		picker.value = '';
		if (selection.length) void importFolder(selection);
	});
	forgetButton.addEventListener('click', async () => {
		forgetButton.disabled = true;
		await forgetGame();
		location.reload();
	});
	exportButton.addEventListener('click', async () => {
		exportButton.disabled = true;
		try {
			// Save the current spot first when the player is free to walk; otherwise export the last save.
			const savedNow = scene instanceof GameScene && scene.saveNow();
			if (saves.files.size === 0) {
				exportStatus.textContent = 'Nothing to export yet: walk around in the game first, then try again.';
				return;
			}
			const where = await saveExportFolder(await buildExport(saves.files, saves.key));
			exportStatus.textContent = savedNow ? `Saved your current spot. ${where}` : where;
		} catch (err) {
			if (!(err instanceof DOMException && err.name === 'AbortError')) {
				console.error(err);
				exportStatus.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		} finally {
			refreshExport();
			// The message sits over the game, so it goes away after a while.
			const shown = exportStatus.textContent;
			setTimeout(() => {
				if (exportStatus.textContent === shown) exportStatus.textContent = '';
			}, 8000);
		}
	});
	refreshExport();
	status.hidden = true;

	let last = performance.now();
	let pending = 0;
	const frame = (now: number) => {
		// The game sets its own speed (room_speed); the launcher runs at Undertale's 30.
		const frameMs = scene.frameMs ?? FRAME_MS;
		pending = Math.min(pending + now - last, frameMs * 4);
		last = now;
		// Development only: the autoplayer holds the page loop so it alone advances the game.
		if (import.meta.env.DEV && (window as { __holdLoop?: boolean }).__holdLoop) pending = 0;
		if (pending >= frameMs) {
			while (pending >= frameMs) {
				scene.update();
				keyboard.endFrame();
				pointer.endFrame();
				pending -= frameMs;
			}
			renderer.begin();
			scene.draw();
			renderer.end();
			refreshExport();
		}
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}

setupHelpPanel();
setupToolbar();
start().catch((err: unknown) => {
	console.error(err);
	status.hidden = false;
	status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
