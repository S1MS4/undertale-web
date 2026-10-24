/**
 * Where the game's own files come from. None of them ship with this site: the player picks their
 * installed Undertale folder once, the page reads data.win and the music from it, and keeps copies in
 * this browser's private storage (OPFS) so later visits start straight away. Nothing is uploaded.
 * In development the dev server serves the files from the install instead (vite.config.ts).
 */

export interface GameSource {
	data: Uint8Array;
	/** A playable URL for a music file that sits next to data.win, or null when it's missing. */
	musicUrl(file: string): string | null;
}

/** A rejected folder. The message is fixed text, safe to show. */
export class SetupError extends Error {}

const CACHE_DIR = 'undertale-game';
/** Plain file names only, the same rule the dev server uses. */
const PLAIN_NAME = /^[\w-][\w.-]*$/;
const isDataWin = (f: File) => f.name.toLowerCase() === 'data.win';
const isMusic = (f: File) => f.name.toLowerCase().endsWith('.ogg') && PLAIN_NAME.test(f.name);

async function fetchBytes(url: string, onProgress: (fraction: number) => void): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
	const total = Number(res.headers.get('Content-Length')) || 0;
	const parts: Uint8Array[] = [];
	let received = 0;
	for (const reader = res.body.getReader(); ; ) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		received += value.length;
		if (total) onProgress(received / total);
	}
	const bytes = new Uint8Array(received);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

/** Development: the dev server's /game/ route, straight from the install folder. */
export async function devSource(onProgress: (fraction: number) => void): Promise<GameSource> {
	return {
		data: await fetchBytes('/game/data.win', onProgress),
		musicUrl: (file) => `/game/${encodeURIComponent(file)}`,
	};
}

/** data.win and the music files, already narrowed to the game folder. */
async function fromFiles(files: File[]): Promise<GameSource> {
	const dataWin = files.find(isDataWin);
	if (!dataWin) throw new SetupError('No data.win found.');
	// Windows file names ignore case, and so did the original game.
	const music = new Map(files.filter(isMusic).map((f) => [f.name.toLowerCase(), f]));
	const urls = new Map<string, string>();
	return {
		data: new Uint8Array(await dataWin.arrayBuffer()),
		musicUrl(file) {
			const key = file.toLowerCase();
			let url = urls.get(key);
			if (!url) {
				const f = music.get(key);
				if (!f) return null;
				url = URL.createObjectURL(f);
				urls.set(key, url);
			}
			return url;
		},
	};
}

/** The files kept by an earlier visit, or null when there are none or this browser can't keep them. */
export async function cachedSource(): Promise<GameSource | null> {
	try {
		const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR);
		const files: File[] = [];
		for await (const handle of dir.values()) {
			if (handle.kind === 'file') files.push(await (handle as FileSystemFileHandle).getFile());
		}
		return files.some(isDataWin) ? await fromFiles(files) : null;
	} catch {
		return null;
	}
}

/**
 * The game files in a picked folder: data.win and the .ogg files beside it. Picking a folder above the
 * game folder works too; the shallowest data.win wins.
 */
export async function pickedSource(selection: File[]): Promise<{ source: GameSource; files: File[] }> {
	// Folder picks report "<folder>/.../<file>".
	const path = (f: File) => f.webkitRelativePath || f.name;
	const folderOf = (f: File) => path(f).slice(0, Math.max(0, path(f).lastIndexOf('/')));
	const dataWin = selection.filter(isDataWin).sort((a, b) => path(a).split('/').length - path(b).split('/').length)[0];
	if (!dataWin) throw new SetupError("That folder has no data.win in it. Pick the folder Undertale is installed in.");
	const folder = folderOf(dataWin);
	const files = selection.filter((f) => folderOf(f) === folder && (f === dataWin || isMusic(f)));
	return { source: await fromFiles(files), files };
}

/**
 * Copies the game files into this browser's storage for next time. Returns false when the browser
 * won't keep them (no OPFS, out of space); the game still runs from the picked folder this time.
 */
export async function rememberGame(files: File[], onProgress: (fraction: number) => void): Promise<boolean> {
	let root: FileSystemDirectoryHandle | undefined;
	try {
		root = await navigator.storage.getDirectory();
		await root.removeEntry(CACHE_DIR, { recursive: true }).catch(() => undefined);
		const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
		// data.win goes last: a copy cut short has no data.win, so it's never taken for a complete one.
		const ordered = [...files.filter((f) => !isDataWin(f)), ...files.filter(isDataWin)];
		const total = ordered.reduce((sum, f) => sum + f.size, 0);
		let copied = 0;
		for (const file of ordered) {
			const writable = await (await dir.getFileHandle(file.name, { create: true })).createWritable();
			await writable.write(file);
			await writable.close();
			copied += file.size;
			onProgress(copied / total);
		}
		// Ask the browser not to clear the copies when space runs low; fine if it says no.
		void navigator.storage.persist?.().catch(() => false);
		return true;
	} catch (err) {
		console.warn('Could not keep the game files in this browser:', err);
		await root?.removeEntry(CACHE_DIR, { recursive: true }).catch(() => undefined);
		return false;
	}
}

/** Removes the kept copies; the next visit asks for the folder again. */
export async function forgetGame(): Promise<void> {
	await (await navigator.storage.getDirectory()).removeEntry(CACHE_DIR, { recursive: true }).catch(() => undefined);
}
