// The game's file system: its save files, kept by the page's save store. INI and text-file
// functions read and write them here, in the formats GameMaker uses on disk.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type IniData = Map<string, Map<string, string>>;

interface TextHandle {
	name: string;
	write: boolean;
	text: string;
	pos: number;
}

export class GameFiles {
	private readonly files: Map<string, Uint8Array>;
	private readonly persist: (name: string, bytes: Uint8Array | null) => void;
	private ini: { name: string | null; data: IniData; dirty: boolean } | null = null;
	private readonly handles = new Map<number, TextHandle>();
	private nextHandle = 1;

	/** `persist` is told about every change so the page can store it. */
	constructor(files: Map<string, Uint8Array>, persist: (name: string, bytes: Uint8Array | null) => void) {
		this.files = files;
		this.persist = persist;
	}

	/** Games pass paths like working_directory + "file0"; only the file name matters here. */
	static normalize(path: string): string {
		return path.replace(/^.*[\\/]/, '').toLowerCase();
	}

	exists(path: string): boolean {
		return this.files.has(GameFiles.normalize(path));
	}

	read(path: string): string | null {
		const bytes = this.files.get(GameFiles.normalize(path));
		return bytes ? decoder.decode(bytes) : null;
	}

	write(path: string, text: string): void {
		const name = GameFiles.normalize(path);
		const bytes = encoder.encode(text);
		this.files.set(name, bytes);
		this.persist(name, bytes);
	}

	delete(path: string): void {
		const name = GameFiles.normalize(path);
		if (this.files.delete(name)) this.persist(name, null);
	}

	rename(from: string, to: string): void {
		const text = this.read(from);
		if (text === null) return;
		this.delete(from);
		this.write(to, text);
	}

	// --- INI ---

	iniOpen(path: string): void {
		this.iniClose();
		this.ini = { name: GameFiles.normalize(path), data: parseIni(this.read(path) ?? ''), dirty: false };
	}

	iniOpenFromString(text: string): void {
		this.iniClose();
		this.ini = { name: null, data: parseIni(text), dirty: false };
	}

	/** Writes the file back if it changed; returns the INI text like GameMaker does. */
	iniClose(): string {
		if (!this.ini) return '';
		const text = formatIni(this.ini.data);
		if (this.ini.name && this.ini.dirty) this.write(this.ini.name, text);
		this.ini = null;
		return text;
	}

	iniRead(section: string, key: string): string | undefined {
		return this.ini?.data.get(section)?.get(key);
	}

	iniWrite(section: string, key: string, value: string): void {
		if (!this.ini) return;
		let entries = this.ini.data.get(section);
		if (!entries) this.ini.data.set(section, (entries = new Map()));
		entries.set(key, value);
		this.ini.dirty = true;
	}

	iniSectionExists(section: string): boolean {
		return this.ini?.data.has(section) ?? false;
	}

	// --- Text files ---

	textOpen(path: string, write: boolean): number {
		const text = write ? '' : this.read(path);
		if (text === null) return -1;
		const id = this.nextHandle++;
		this.handles.set(id, { name: GameFiles.normalize(path), write, text, pos: 0 });
		return id;
	}

	textClose(id: number): void {
		const h = this.handles.get(id);
		if (!h) return;
		if (h.write) this.write(h.name, h.text);
		this.handles.delete(id);
	}

	textWrite(id: number, text: string): void {
		const h = this.handles.get(id);
		if (h?.write) h.text += text;
	}

	/** Reads a number at the cursor, leaving the rest of the line. */
	textReadReal(id: number): number {
		const h = this.handles.get(id);
		if (!h) return 0;
		const match = /^[ \t]*([-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)/.exec(h.text.slice(h.pos));
		if (!match) return 0;
		h.pos += match[0].length;
		return Number(match[1]);
	}

	/** Reads to the end of the line, leaving the line break. */
	textReadString(id: number): string {
		const h = this.handles.get(id);
		if (!h) return '';
		let end = h.text.indexOf('\n', h.pos);
		if (end < 0) end = h.text.length;
		const line = h.text.slice(h.pos, end).replace(/\r$/, '');
		h.pos = end;
		return line;
	}

	/** Moves past the next line break and returns what was skipped. */
	textReadln(id: number): string {
		const h = this.handles.get(id);
		if (!h) return '';
		let end = h.text.indexOf('\n', h.pos);
		end = end < 0 ? h.text.length : end + 1;
		const skipped = h.text.slice(h.pos, end).replace(/\r?\n$/, '');
		h.pos = end;
		return skipped;
	}

	textEof(id: number): boolean {
		const h = this.handles.get(id);
		return !h || h.pos >= h.text.length;
	}
}

function parseIni(text: string): IniData {
	const data: IniData = new Map();
	let section: Map<string, string> | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(';')) continue;
		const header = /^\[(.*)\]$/.exec(line);
		if (header) {
			section = data.get(header[1]) ?? new Map();
			data.set(header[1], section);
			continue;
		}
		const eq = line.indexOf('=');
		if (eq < 0 || !section) continue;
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		section.set(line.slice(0, eq).trim(), value);
	}
	return data;
}

function formatIni(data: IniData): string {
	let out = '';
	for (const [section, entries] of data) {
		out += `[${section}]\r\n`;
		for (const [key, value] of entries) out += `${key}="${value}"\r\n`;
	}
	return out;
}
