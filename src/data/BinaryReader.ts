const utf8 = new TextDecoder('utf-8');
const ascii = new TextDecoder('ascii');

/** Little-endian reads at absolute offsets into data.win. Pointers in the file are absolute offsets too. */
export class BinaryReader {
	readonly bytes: Uint8Array;
	readonly view: DataView;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	u8(at: number): number {
		return this.view.getUint8(at);
	}

	u16(at: number): number {
		return this.view.getUint16(at, true);
	}

	i16(at: number): number {
		return this.view.getInt16(at, true);
	}

	u32(at: number): number {
		return this.view.getUint32(at, true);
	}

	i32(at: number): number {
		return this.view.getInt32(at, true);
	}

	f32(at: number): number {
		return this.view.getFloat32(at, true);
	}

	/** Four ASCII characters, as used for chunk names. */
	tag(at: number): string {
		return ascii.decode(this.bytes.subarray(at, at + 4));
	}

	/** GameMaker string pointers address the characters; the u32 length sits just before them. */
	string(ptr: number): string {
		if (ptr === 0) return '';
		const length = this.u32(ptr - 4);
		return utf8.decode(this.bytes.subarray(ptr, ptr + length));
	}

	/** A u32 count followed by that many u32 pointers. */
	pointerList(at: number): number[] {
		const count = this.u32(at);
		const out = new Array<number>(count);
		for (let i = 0; i < count; i++) out[i] = this.u32(at + 4 + 4 * i);
		return out;
	}
}
