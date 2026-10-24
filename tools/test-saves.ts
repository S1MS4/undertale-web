// Attacks the save import with tampered, forged and malformed folders. Uses synthetic save data only.
// Usage: node tools/test-saves.ts
import { buildExport, createSigningKey, ImportError, MANIFEST_NAME, readExport, RENAMED_SUFFIX, type SaveFiles } from '../src/saveBundle.ts';
import { checkSaveFile } from '../src/saveFormat.ts';

const enc = new TextEncoder();
const key = await createSigningKey();
const otherKey = await createSigningKey();

const save: SaveFiles = new Map([
	['file0', enc.encode('TESTNAME\r\n20\r\n0\r\n')],
	['file9', enc.encode('TESTNAME\r\n20\r\n0\r\n')],
	['undertale.ini', enc.encode('[General]\r\nName="TESTNAME"\r\nLove="1.000000"\r\n')],
	['config.ini', enc.encode('[General]\r\nlang="en"\r\n')],
]);

/** Turns an export into what a folder picker hands the page. */
function asFolder(bundle: Map<string, Uint8Array>, folder = 'undertale-save-test'): File[] {
	return [...bundle].map(([name, bytes]) => withPath(new File([bytes.slice()], name), `${folder}/${name}`));
}

function withPath(file: File, path: string): File {
	Object.defineProperty(file, 'webkitRelativePath', { value: path });
	return file;
}

function edit(bundle: Map<string, Uint8Array>, name: string, change: (text: string) => string): Map<string, Uint8Array> {
	const copy = new Map(bundle);
	copy.set(name, enc.encode(change(new TextDecoder().decode(bundle.get(name)))));
	return copy;
}

let failures = 0;
async function expectRejected(label: string, selection: File[], signingKey = key): Promise<void> {
	try {
		await readExport(selection, signingKey);
		console.log(`FAIL  ${label}: was accepted`);
		failures++;
	} catch (err) {
		if (err instanceof ImportError) console.log(`ok    ${label}`);
		else {
			console.log(`FAIL  ${label}: crashed instead of rejecting: ${err}`);
			failures++;
		}
	}
}

const bundle = await buildExport(save, key);

// The one thing that must work.
const loaded = await readExport(asFolder(bundle), key);
const same = [...save].every(([n, b]) => loaded.get(n)?.join() === b.join()) && loaded.size === save.size;
console.log(same ? 'ok    untouched export imports' : 'FAIL  untouched export did not round-trip');
if (!same) failures++;

// Files Chrome wouldn't create under their own name are written with RENAMED_SUFFIX.
const renamed = new Map([...bundle].map(([n, b]) => [n === 'file0' || n === 'config.ini' ? n + RENAMED_SUFFIX : n, b]));
const loadedRenamed = await readExport(asFolder(renamed), key);
const sameRenamed = [...save].every(([n, b]) => loadedRenamed.get(n)?.join() === b.join()) && loadedRenamed.size === save.size;
console.log(sameRenamed ? 'ok    export with renamed files imports' : 'FAIL  export with renamed files did not round-trip');
if (!sameRenamed) failures++;

await expectRejected('file0 and file0.txt both present', [...asFolder(bundle), asFolder(renamed).find((f) => f.name === 'file0' + RENAMED_SUFFIX)!]);
await expectRejected('unknown file with the suffix', [...asFolder(bundle), withPath(new File(['x'], 'evil.js.txt'), 'undertale-save-test/evil.js.txt')]);
await expectRejected('one byte changed in file0', asFolder(edit(bundle, 'file0', (t) => t.replace('20', '99'))));
await expectRejected('LOVE raised in undertale.ini', asFolder(edit(bundle, 'undertale.ini', (t) => t.replace('1.000000', '20.000000'))));
await expectRejected('manifest hash edited to match a changed file', asFolder(edit(bundle, MANIFEST_NAME, (t) => t.replace(/"sha256": "[0-9a-f]/, '"sha256": "0'))));
await expectRejected('signature replaced', asFolder(edit(bundle, MANIFEST_NAME, (t) => t.replace(/"signature": "[^"]+"/, `"signature": "${'A'.repeat(43)}="`))));
await expectRejected('exported by another browser (different key)', asFolder(bundle), otherKey);
await expectRejected('forged export signed with the attacker\'s own key', asFolder(await buildExport(save, otherKey)));

const without = (name: string) => new Map([...bundle].filter(([n]) => n !== name));
await expectRejected('manifest missing', asFolder(without(MANIFEST_NAME)));
await expectRejected('file listed in manifest missing', asFolder(without('file9')));
await expectRejected('extra file added', [...asFolder(bundle), withPath(new File(['x'], 'evil.js'), 'undertale-save-test/evil.js')]);
await expectRejected('file in a subfolder', [...asFolder(without('config.ini')), withPath(new File([save.get('config.ini')!.slice()], 'config.ini'), 'undertale-save-test/sub/config.ini')]);
await expectRejected('duplicate file name', [...asFolder(bundle), asFolder(bundle)[0]]);
await expectRejected('5000 files selected', Array.from({ length: 5000 }, (_, i) => withPath(new File(['x'], `f${i}`), `big/f${i}`)));
await expectRejected('empty folder', []);
await expectRejected('50 MB file0', asFolder(new Map([...bundle, ['file0', new Uint8Array(50 * 1024 * 1024)]])));
await expectRejected('8 KB manifest', asFolder(edit(bundle, MANIFEST_NAME, (t) => t + ' '.repeat(8192))));
await expectRejected('manifest is not JSON', asFolder(edit(bundle, MANIFEST_NAME, () => '<script>alert(1)</script>')));
await expectRejected('manifest with __proto__ key', asFolder(edit(bundle, MANIFEST_NAME, (t) => t.replace('{', '{"__proto__": {"admin": true},'))));
await expectRejected('manifest with an extra key', asFolder(edit(bundle, MANIFEST_NAME, (t) => t.replace('{', '{"run": "rm -rf /",'))));
await expectRejected('manifest version changed', asFolder(edit(bundle, MANIFEST_NAME, (t) => t.replace('"version": 1', '"version": 2'))));
await expectRejected('deeply nested JSON', asFolder(new Map([...bundle, [MANIFEST_NAME, enc.encode('['.repeat(3000) + ']'.repeat(3000))]])));

// Defence in depth: even a correctly signed export must contain plausible save text.
for (const [label, name, text] of [
	['NUL bytes in file0', 'file0', 'TESTNAME\u0000\r\n'],
	['terminal escape codes in file0', 'file0', '\u001b[31mred\r\n'],
	['bidirectional override in file0', 'file0', 'abc‮def\r\n'],
	['invalid UTF-8', 'file0', '�'],
	['code in an INI file', 'undertale.ini', '[General]\r\n<script>alert(1)</script>\r\n'],
	['INI value with a quote break', 'config.ini', '[General]\r\nlang="en" onload="x"\r\n'],
	['a 10 KB line', 'file0', 'a'.repeat(10_000)],
] as const) {
	const forged = new Map(save);
	forged.set(name, label === 'invalid UTF-8' ? new Uint8Array([0xff, 0xfe, 0xfd]) : enc.encode(text));
	await expectRejected(`signed but invalid: ${label}`, asFolder(await buildExport(forged, key)));
}
console.log(checkSaveFile('file0', enc.encode('<script>alert(1)</script>')) === null
	? 'ok    HTML-looking text in file0 stays inert data (it is never parsed as HTML)'
	: 'note  HTML-looking text rejected');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exitCode = failures ? 1 : 0;
