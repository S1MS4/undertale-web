import { checkSaveFile, isSaveFileName, MAX_SAVE_FILE_BYTES, SAVE_FILES, type SaveFileName } from './saveFormat.ts';

/**
 * Exports are a folder: the save files plus this manifest, which lists each file's size and SHA-256
 * and is signed with an HMAC key that never leaves this browser. Import accepts nothing else.
 */
export const MANIFEST_NAME = 'undertale-web-save.json';
/**
 * Chrome refuses to create some file names in a picked folder ("Name is not allowed"). Such a file is written
 * as "<name>.txt" instead, and import reads it back under its real name.
 */
export const RENAMED_SUFFIX = '.txt';

const FORMAT = 'undertale-web-save';
const VERSION = 1;
const MAX_MANIFEST_BYTES = 4 * 1024;
// The manifest plus at most one of each save file. Bigger selections are rejected without reading them.
const MAX_SELECTED_FILES = SAVE_FILES.length + 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{43}=$/; // 32-byte HMAC-SHA-256
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const NOT_AN_EXPORT = 'That folder is not a save exported by this game.\nPick the folder that Export created.';
const TAMPERED = 'That save was changed after it was exported,\nor was exported from another browser. It was not loaded.';

export type SaveFiles = Map<SaveFileName, Uint8Array>;

interface ManifestEntry {
	name: SaveFileName;
	size: number;
	sha256: string;
}

interface Manifest {
	format: string;
	version: number;
	created: string;
	files: ManifestEntry[];
	signature: string;
}

/** A rejected import. The message is fixed text, safe to show, and never echoes the file contents. */
export class ImportError extends Error {}

/**
 * A browser-local HMAC key. It is non-extractable: this page can sign with it, but nobody can read it out,
 * so a valid export can only come from this browser.
 */
export async function createSigningKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function isSigningKey(value: unknown): value is CryptoKey {
	return (
		value instanceof CryptoKey &&
		value.algorithm.name === 'HMAC' &&
		!value.extractable &&
		value.usages.includes('sign') &&
		value.usages.includes('verify')
	);
}

/** The save files plus a signed manifest, keyed by file name. */
export async function buildExport(files: SaveFiles, key: CryptoKey): Promise<Map<string, Uint8Array>> {
	const entries: ManifestEntry[] = [];
	for (const name of [...files.keys()].sort()) {
		const bytes = files.get(name)!;
		entries.push({ name, size: bytes.length, sha256: await sha256Hex(bytes) });
	}
	const unsigned = { format: FORMAT, version: VERSION, created: new Date().toISOString(), files: entries };
	const signature = await crypto.subtle.sign('HMAC', key, signedBytes(unsigned));
	const manifest: Manifest = { ...unsigned, signature: toBase64(new Uint8Array(signature)) };

	const out = new Map<string, Uint8Array>(files);
	out.set(MANIFEST_NAME, new TextEncoder().encode(`${JSON.stringify(manifest, null, '\t')}\n`));
	return out;
}

/**
 * Verifies a folder picked for import and returns its save files.
 * Throws ImportError unless the folder is exactly what Export wrote, unchanged, signed by this browser's key.
 */
export async function readExport(selection: readonly File[], key: CryptoKey): Promise<SaveFiles> {
	if (selection.length === 0 || selection.length > MAX_SELECTED_FILES) throw new ImportError(NOT_AN_EXPORT);

	const byName = new Map<string, File>();
	for (const file of selection) {
		// Folder picks report "<folder>/<file>"; anything deeper is in a subfolder, which exports never have.
		const depth = file.webkitRelativePath ? file.webkitRelativePath.split('/').length : 2;
		const name = exportedName(file.name);
		if (depth !== 2 || name === null || byName.has(name)) throw new ImportError(NOT_AN_EXPORT);
		byName.set(name, file);
	}

	const manifestFile = byName.get(MANIFEST_NAME);
	if (!manifestFile || manifestFile.size > MAX_MANIFEST_BYTES) throw new ImportError(NOT_AN_EXPORT);
	const manifest = parseManifest(await manifestFile.arrayBuffer());
	if (!manifest) throw new ImportError(NOT_AN_EXPORT);

	const signature = fromBase64(manifest.signature);
	if (!(await crypto.subtle.verify('HMAC', key, signature, signedBytes(manifest)))) throw new ImportError(TAMPERED);
	if (byName.size !== manifest.files.length + 1) throw new ImportError(TAMPERED);

	const out: SaveFiles = new Map();
	for (const entry of manifest.files) {
		const file = byName.get(entry.name);
		// Check the declared size before reading, so an oversized file is never loaded into memory.
		if (!file || file.size !== entry.size) throw new ImportError(TAMPERED);
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.length !== entry.size || (await sha256Hex(bytes)) !== entry.sha256) throw new ImportError(TAMPERED);
		if (checkSaveFile(entry.name, bytes)) throw new ImportError(TAMPERED);
		out.set(entry.name, bytes);
	}
	if (!out.has('file0')) throw new ImportError('That export has no saved progress in it.');
	return out;
}

/** The real name of a file in an export folder (undoing a RENAMED_SUFFIX), or null if exports never have it. */
function exportedName(fileName: string): string | null {
	const name = fileName.endsWith(RENAMED_SUFFIX) ? fileName.slice(0, -RENAMED_SUFFIX.length) : fileName;
	return name === MANIFEST_NAME || isSaveFileName(name) ? name : null;
}

/** The bytes the signature covers: every manifest field, in a fixed order that doesn't depend on JSON key order. */
function signedBytes(m: Omit<Manifest, 'signature'>): Uint8Array<ArrayBuffer> {
	const files = m.files.map((f) => [f.name, f.size, f.sha256]);
	return new TextEncoder().encode(JSON.stringify([m.format, m.version, m.created, files]));
}

/** Strict schema check. Unknown keys, wrong types, or out-of-range values all reject the manifest. */
function parseManifest(buffer: ArrayBuffer): Manifest | null {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
	} catch {
		return null;
	}
	if (!isPlainRecord(value) || !hasExactKeys(value, ['format', 'version', 'created', 'files', 'signature'])) return null;
	const { format, version, created, files, signature } = value;
	if (format !== FORMAT || version !== VERSION) return null;
	if (typeof created !== 'string' || !ISO_DATE.test(created)) return null;
	if (typeof signature !== 'string' || !SIGNATURE_BASE64.test(signature)) return null;
	if (!Array.isArray(files) || files.length === 0 || files.length > SAVE_FILES.length) return null;

	const entries: ManifestEntry[] = [];
	for (const entry of files) {
		if (!isPlainRecord(entry) || !hasExactKeys(entry, ['name', 'size', 'sha256'])) return null;
		const { name, size, sha256 } = entry;
		if (typeof name !== 'string' || !isSaveFileName(name) || entries.some((e) => e.name === name)) return null;
		if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_SAVE_FILE_BYTES) return null;
		if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null;
		entries.push({ name, size, sha256 });
	}
	return { format, version, created, files: entries, signature };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
	const own = Object.keys(record);
	return own.length === keys.length && keys.every((k) => Object.hasOwn(record, k));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
	return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
