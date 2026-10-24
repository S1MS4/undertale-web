import { createSigningKey, isSigningKey, type SaveFiles } from './saveBundle.ts';
import { checkSaveFile, isSaveFileName } from './saveFormat.ts';

/** "imported" holds a verified import; "new" is a fresh run that always starts empty. */
export type Slot = 'imported' | 'new';

const DB_NAME = 'undertale-web';
const STORE = 'saves';
const ACTIVE_KEY = 'meta/active';
const SIGNING_KEY = 'meta/key';

/**
 * Two save slots and the export signing key, kept in IndexedDB so they survive a refresh. File keys are
 * "<slot>/<file>". If the browser blocks storage (private windows, cleared site data), everything lasts
 * only until the page closes, including the key, so exports from such a session can't be imported later.
 */
export class SaveStore {
	readonly slots: Record<Slot, SaveFiles> = { imported: new Map(), new: new Map() };
	active: Slot = 'new';
	key!: CryptoKey;
	private db: IDBDatabase | null = null;

	static async open(): Promise<SaveStore> {
		const store = new SaveStore();
		let key: CryptoKey | null = null;
		try {
			store.db = await openDb();
			const tx = store.db.transaction(STORE, 'readonly').objectStore(STORE);
			const [keys, values] = await Promise.all([request(tx.getAllKeys()), request(tx.getAll())]);
			keys.forEach((k, i) => {
				const id = String(k);
				const value = values[i];
				if (id === ACTIVE_KEY) {
					if (value === 'imported' || value === 'new') store.active = value;
				} else if (id === SIGNING_KEY) {
					if (isSigningKey(value)) key = value;
				} else {
					store.restore(id, value);
				}
			});
		} catch (err) {
			console.warn('Save storage unavailable; saves will last until the page closes.', err);
			store.db = null;
		}
		store.key = key ?? (await store.newSigningKey());
		return store;
	}

	/** The files the game reads and writes this session. */
	get files(): SaveFiles {
		return this.slots[this.active];
	}

	hasProgress(slot: Slot = this.active): boolean {
		return this.slots[slot].has('file0');
	}

	/** Makes `slot` the active one, replacing its files first when `files` is given. */
	async use(slot: Slot, files?: SaveFiles): Promise<void> {
		if (files) {
			const target = this.slots[slot];
			target.clear();
			for (const [name, bytes] of files) target.set(name, bytes);
		}
		this.active = slot;
		await this.write((store) => {
			store.delete(IDBKeyRange.bound(`${slot}/`, `${slot}/￿`));
			for (const [name, bytes] of this.slots[slot]) store.put(bytes, `${slot}/${name}`);
			store.put(slot, ACTIVE_KEY);
		});
	}

	/** Stores one file the game wrote (or deleted) in the active slot. Files Undertale doesn't use are kept in memory only. */
	writeFile(name: string, bytes: Uint8Array | null): void {
		if (!isSaveFileName(name)) return;
		const slot = this.active;
		if (bytes && checkSaveFile(name, bytes)) {
			console.warn(`Not storing ${name}: ${checkSaveFile(name, bytes)}`);
			return;
		}
		if (bytes) this.slots[slot].set(name, bytes);
		else this.slots[slot].delete(name);
		void this.write((store) => {
			if (bytes) store.put(bytes, `${slot}/${name}`);
			else store.delete(`${slot}/${name}`);
		});
	}

	/**
	 * Another app served from the same localhost port shares this storage, so stored files are
	 * re-checked on load and anything malformed is dropped.
	 */
	private restore(id: string, value: unknown): void {
		const [slot, name, extra] = id.split('/');
		if ((slot !== 'imported' && slot !== 'new') || extra !== undefined || !isSaveFileName(name ?? '')) return;
		if (!(value instanceof Uint8Array) || checkSaveFile(name as never, value)) {
			console.warn(`Dropped an invalid stored save file: ${id}`);
			return;
		}
		this.slots[slot].set(name as never, value);
	}

	private async newSigningKey(): Promise<CryptoKey> {
		const key = await createSigningKey();
		await this.write((store) => store.put(key, SIGNING_KEY));
		return key;
	}

	private async write(apply: (store: IDBObjectStore) => void): Promise<void> {
		if (!this.db) return;
		try {
			const tx = this.db.transaction(STORE, 'readwrite');
			apply(tx.objectStore(STORE));
			await done(tx);
		} catch (err) {
			console.warn('Could not persist saves.', err);
		}
	}
}

function openDb(): Promise<IDBDatabase> {
	const req = indexedDB.open(DB_NAME, 1);
	req.onupgradeneeded = () => req.result.createObjectStore(STORE);
	return request(req);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = tx.onabort = () => reject(tx.error);
	});
}
