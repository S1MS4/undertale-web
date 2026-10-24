import { RENAMED_SUFFIX } from './saveBundle.ts';

// The File System Access API's folder picker (Chromium only) isn't in TypeScript's DOM types yet.
type ShowDirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

/**
 * Writes an export into a brand-new folder, so it never overwrites anything. Where folders can't be
 * written (Firefox, Safari), downloads the files instead. Returns a message describing where they went.
 */
export async function saveExportFolder(bundle: Map<string, Uint8Array>): Promise<string> {
	const folderName = `undertale-save-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
	const showDirectoryPicker = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker;

	if (showDirectoryPicker) {
		const parent = await showDirectoryPicker({ id: 'undertale-export', mode: 'readwrite' });
		if (await exists(parent, folderName)) throw new Error(`A folder named ${folderName} already exists there.`);
		let current = folderName;
		try {
			const folder = await parent.getDirectoryHandle(folderName, { create: true });
			for (const [name, bytes] of bundle) {
				current = name;
				const handle = await folder
					.getFileHandle(name, { create: true })
					// Chrome refuses some names (a TypeError, "Name is not allowed"); import reads the renamed file too.
					.catch((err) => {
						if (!(err instanceof TypeError)) throw err;
						current = name + RENAMED_SUFFIX;
						return folder.getFileHandle(current, { create: true });
					});
				const writable = await handle.createWritable();
				await writable.write(bytes.slice());
				await writable.close();
			}
			return `Saved to the folder ${folderName}. Import that folder to load it.`;
		} catch (err) {
			// Anything else refused (a place the browser won't write to): download instead,
			// and drop the half-written folder so it can't be imported by mistake.
			console.warn(`Folder write refused at "${current}", downloading the files instead:`, err);
			await parent.removeEntry(folderName, { recursive: true }).catch(() => undefined);
		}
	}

	for (const [name, bytes] of bundle) {
		const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/octet-stream' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = name;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}
	return `Downloaded ${bundle.size} files. Put them together in one new folder, then import that folder.`;
}

async function exists(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
	try {
		await parent.getDirectoryHandle(name);
		return true;
	} catch {
		return false;
	}
}
