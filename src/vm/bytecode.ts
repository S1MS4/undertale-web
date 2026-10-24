import type { CodeEntry, DataWin, Variable } from '../data/DataWin.ts';

// GameMaker Studio 1.4 bytecode (versions 15/16): 32-bit little-endian words, opcode in the top byte.

export const Op = {
	Conv: 0x07,
	Mul: 0x08,
	Div: 0x09,
	Rem: 0x0a, // integer division (`div`)
	Mod: 0x0b,
	Add: 0x0c,
	Sub: 0x0d,
	And: 0x0e,
	Or: 0x0f,
	Xor: 0x10,
	Neg: 0x11,
	Not: 0x12,
	Shl: 0x13,
	Shr: 0x14,
	Cmp: 0x15,
	Pop: 0x45,
	PushI: 0x84,
	Dup: 0x86,
	Ret: 0x9c,
	Exit: 0x9d,
	Popz: 0x9e,
	B: 0xb6,
	Bt: 0xb7,
	Bf: 0xb8,
	PushEnv: 0xba,
	PopEnv: 0xbb,
	Push: 0xc0,
	PushLoc: 0xc1,
	PushGlb: 0xc2,
	PushBltn: 0xc3,
	Call: 0xd9,
	Break: 0xff,
} as const;

export const DataType = {
	Double: 0,
	Float: 1,
	Int32: 2,
	Int64: 3,
	Boolean: 4,
	Variable: 5,
	String: 6,
	Int16: 0x0f,
} as const;

export const Cmp = { LT: 1, LTE: 2, EQ: 3, NEQ: 4, GTE: 5, GT: 6 } as const;

/** How a variable operand finds its instance. */
export const VarKind = { Array: 0x00, StackTop: 0x80, Normal: 0xa0, Instance: 0xe0 } as const;

/** PopEnv with this jump target leaves a `with` block early instead of looping. */
export const POPENV_DROP = 0xf00000;

export interface Instruction {
	op: number;
	type1: number;
	type2: number;
	/** Comparison kind, dup count, or argument count. */
	extra: number;
	/** Jump target as an instruction index (branches, pushenv/popenv). */
	target: number;
	/** Pushed constant. */
	value: number | string | boolean;
	/** Variable operand (push.v / pop). */
	variable: Variable | null;
	varKind: number;
	/** Instance type in the operand (-1 self, -5 global, -7 local, >= 0 object index). */
	instance: number;
	/** Function name (call). */
	func: string;
	/** Set on popenv that exits a with block early. */
	drop: boolean;
}

export interface DecodedCode {
	entry: CodeEntry;
	instructions: Instruction[];
}

/** Decodes one code entry. Jump targets become instruction indices so the VM never deals in bytes. */
export function decodeCode(data: DataWin, entry: CodeEntry): DecodedCode {
	const r = data.reader;
	const end = entry.start + entry.length;
	const instructions: Instruction[] = [];
	const indexAt = new Map<number, number>();
	const branchAt: { index: number; address: number; offset: number }[] = [];

	for (let at = entry.start; at < end; ) {
		indexAt.set(at, instructions.length);
		const word = r.u32(at);
		const op = word >>> 24;
		const b0 = word & 0xff;
		const b1 = (word >>> 8) & 0xff;
		const b2 = (word >>> 16) & 0xff;
		const low16 = word & 0xffff;
		const ins: Instruction = {
			op,
			type1: b2 & 0xf,
			type2: b2 >> 4,
			extra: b0,
			target: -1,
			value: 0,
			variable: null,
			varKind: 0,
			instance: 0,
			func: '',
			drop: false,
		};
		let size = 4;

		switch (op) {
			case Op.Cmp:
				ins.extra = b1;
				break;
			case Op.B:
			case Op.Bt:
			case Op.Bf:
			case Op.PushEnv:
			case Op.PopEnv: {
				const raw = word & 0xffffff;
				if (op === Op.PopEnv && raw === POPENV_DROP) {
					ins.drop = true;
				} else {
					// 23-bit signed offset, counted in words.
					const offset = raw & 0x400000 ? (raw & 0x7fffff) - 0x800000 : raw & 0x7fffff;
					branchAt.push({ index: instructions.length, address: at, offset });
				}
				break;
			}
			case Op.Pop:
				ins.instance = (low16 << 16) >> 16;
				ins.variable = data.variableRefs.get(at) ?? null;
				ins.varKind = r.u32(at + 4) >>> 24 & 0xf8;
				size = 8;
				break;
			case Op.PushI:
				ins.value = (low16 << 16) >> 16;
				break;
			case Op.Push:
			case Op.PushLoc:
			case Op.PushGlb:
			case Op.PushBltn:
				switch (ins.type1) {
					case DataType.Int16:
						ins.value = (low16 << 16) >> 16;
						break;
					case DataType.Variable:
						ins.instance = (low16 << 16) >> 16;
						ins.variable = data.variableRefs.get(at) ?? null;
						ins.varKind = r.u32(at + 4) >>> 24 & 0xf8;
						size = 8;
						break;
					case DataType.Double:
						ins.value = r.view.getFloat64(at + 4, true);
						size = 12;
						break;
					case DataType.Float:
						ins.value = r.f32(at + 4);
						size = 8;
						break;
					case DataType.Int32:
						ins.value = r.i32(at + 4);
						size = 8;
						break;
					case DataType.Int64:
						ins.value = Number(r.view.getBigInt64(at + 4, true));
						size = 12;
						break;
					case DataType.Boolean:
						ins.value = r.u32(at + 4) !== 0;
						size = 8;
						break;
					case DataType.String:
						ins.value = data.strings[r.u32(at + 4)] ?? '';
						size = 8;
						break;
					default:
						throw new Error(`${entry.name}: push of unknown type ${ins.type1} at ${at}`);
				}
				break;
			case Op.Call:
				ins.extra = low16;
				ins.func = data.functionRefs.get(at) ?? '';
				size = 8;
				break;
			case Op.Break:
				ins.value = (low16 << 16) >> 16;
				break;
			case Op.Dup:
			case Op.Conv:
			case Op.Mul:
			case Op.Div:
			case Op.Rem:
			case Op.Mod:
			case Op.Add:
			case Op.Sub:
			case Op.And:
			case Op.Or:
			case Op.Xor:
			case Op.Neg:
			case Op.Not:
			case Op.Shl:
			case Op.Shr:
			case Op.Ret:
			case Op.Exit:
			case Op.Popz:
				break;
			default:
				throw new Error(`${entry.name}: unknown opcode 0x${op.toString(16)} at ${at}`);
		}
		instructions.push(ins);
		at += size;
	}
	indexAt.set(end, instructions.length);

	for (const { index, address, offset } of branchAt) {
		const target = indexAt.get(address + offset * 4);
		if (target === undefined) throw new Error(`${entry.name}: branch into the middle of an instruction at ${address}`);
		instructions[index].target = target;
	}
	return { entry, instructions };
}
