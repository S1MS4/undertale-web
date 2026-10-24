/**
 * The files Undertale keeps in %LOCALAPPDATA%\UNDERTALE: settings, the save (file0), the save made after
 * the king's fight that the game loads when it is reopened (file8), the last fight's own save (file9),
 * story flags, and two marker files for later routes.
 */
export const SAVE_FILES = [
	'config.ini',
	'file0',
	'file8',
	'file9',
	'undertale.ini',
	'system_information_962',
	'system_information_963',
] as const;
export type SaveFileName = (typeof SAVE_FILES)[number];

// Real save files are about 2 KB each. These caps leave plenty of room while bounding memory and CPU.
export const MAX_SAVE_FILE_BYTES = 64 * 1024;
const MAX_LINES = 4096;
const MAX_LINE_LENGTH = 512;

// GameMaker writes INI files as [Section] and key="value" lines.
const INI_SECTION = /^\[[A-Za-z0-9_ ]{1,64}\]$/;
const INI_ENTRY = /^[A-Za-z0-9_ ]{1,64}="[^"]{0,256}"$/;

// C0 controls other than tab/LF/CR, DEL, C1 controls, and bidirectional overrides that can disguise text.
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export function isSaveFileName(name: string): name is SaveFileName {
	return (SAVE_FILES as readonly string[]).includes(name);
}

/**
 * Returns why `bytes` is not a plausible Undertale save file, or null when it is.
 * Save files are only ever treated as text data: nothing here (or anywhere) evaluates them.
 */
export function checkSaveFile(name: SaveFileName, bytes: Uint8Array): string | null {
	if (bytes.length > MAX_SAVE_FILE_BYTES) return 'too large';
	let text: string;
	try {
		text = strictUtf8.decode(bytes);
	} catch {
		return 'not UTF-8 text';
	}
	if (FORBIDDEN_CHARS.test(text)) return 'contains control characters';
	const lines = text.split(/\r?\n/);
	if (lines.length > MAX_LINES) return 'too many lines';
	const ini = name.endsWith('.ini');
	for (const line of lines) {
		if (line.length > MAX_LINE_LENGTH) return 'line too long';
		if (ini && line !== '' && !INI_SECTION.test(line) && !INI_ENTRY.test(line)) return 'not in INI format';
	}
	return null;
}
