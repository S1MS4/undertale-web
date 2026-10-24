import type { DataWin } from '../data/DataWin.ts';
import { Cmp, DataType, decodeCode, type DecodedCode, Op, VarKind } from './bytecode.ts';
import type { Instance } from './Instance.ts';
import { compare, toInt, toNumber, truthy, type Value } from './values.ts';

/** Where the running code is: who `self` and `other` are, its locals and arguments, and which event it's in. */
export interface Frame {
	self: Instance;
	other: Instance;
	locals: Map<string, Value>;
	args: Value[];
	/** Event being run, for event_inherited(); null for scripts and creation code. */
	event: { type: number; subtype: number; owner: number } | null;
}

/** What the interpreter needs from the game: variables, instance lookup, and function calls. */
export interface Host {
	getVar(frame: Frame, target: Value, name: string, index?: number): Value;
	setVar(frame: Frame, target: Value, name: string, value: Value, index?: number): void;
	/** Instances a `with` block visits. */
	withTargets(frame: Frame, target: Value): Instance[];
	call(frame: Frame, name: string, args: Value[]): Value;
}

interface WithBlock {
	instances: Instance[];
	index: number;
	self: Instance;
	other: Instance;
}

// A runaway loop in game code shouldn't freeze the tab forever.
const MAX_INSTRUCTIONS_PER_RUN = 50_000_000;

export class Interpreter {
	private readonly data: DataWin;
	private readonly host: Host;
	private readonly cache = new Map<number, DecodedCode>();
	/** Script call depth, to turn runaway recursion into an error instead of a crash. */
	private depth = 0;

	constructor(data: DataWin, host: Host) {
		this.data = data;
		this.host = host;
	}

	run(codeId: number, frame: Frame): Value {
		let code = this.cache.get(codeId);
		if (!code) {
			code = decodeCode(this.data, this.data.code[codeId]);
			this.cache.set(codeId, code);
		}
		if (++this.depth > 512) {
			this.depth = 0;
			throw new Error(`call depth exceeded in ${code.entry.name}`);
		}
		try {
			return this.execute(code, frame);
		} finally {
			this.depth--;
		}
	}

	private execute(code: DecodedCode, frame: Frame): Value {
		const ins = code.instructions;
		const host = this.host;
		const stack: Value[] = [];
		const withs: WithBlock[] = [];
		let pc = 0;
		let budget = MAX_INSTRUCTIONS_PER_RUN;

		const pop = (): Value => stack.pop();

		while (pc < ins.length) {
			if (--budget === 0) throw new Error(`${code.entry.name}: instruction budget exceeded (infinite loop?)`);
			const i = ins[pc++];
			switch (i.op) {
				case Op.Push:
				case Op.PushLoc:
				case Op.PushGlb:
				case Op.PushBltn:
					if (i.type1 === DataType.Variable) {
						const name = i.variable!.name;
						if (i.varKind === VarKind.Array) {
							const index = toInt(pop());
							stack.push(host.getVar(frame, pop(), name, index));
						} else if (i.varKind === VarKind.StackTop) {
							stack.push(host.getVar(frame, pop(), name));
						} else {
							stack.push(host.getVar(frame, i.instance, name));
						}
					} else {
						stack.push(typeof i.value === 'boolean' ? (i.value ? 1 : 0) : i.value);
					}
					break;
				case Op.PushI:
					stack.push(i.value as number);
					break;
				case Op.Pop: {
					// pop.i.* keeps the value on top (compound assignments); otherwise it's under the target.
					const valueOnTop = i.type1 === DataType.Int32;
					let value = valueOnTop ? pop() : undefined;
					let target: Value = i.instance;
					let index: number | undefined;
					if (i.varKind === VarKind.Array) {
						index = toInt(pop());
						target = pop();
					} else if (i.varKind === VarKind.StackTop) {
						target = pop();
					}
					if (!valueOnTop) value = pop();
					host.setVar(frame, target, i.variable!.name, value, index);
					break;
				}
				case Op.Popz:
					pop();
					break;
				case Op.Dup: {
					const n = i.extra + 1;
					stack.push(...stack.slice(stack.length - n));
					break;
				}
				case Op.Conv: {
					const v = pop();
					if (i.type2 === DataType.Boolean) stack.push(truthy(v) ? 1 : 0);
					else if (i.type2 === DataType.Int32 || i.type2 === DataType.Int64) stack.push(typeof v === 'number' ? Math.trunc(v) : v);
					else stack.push(v);
					break;
				}
				case Op.Add: {
					const b = pop();
					const a = pop();
					if (typeof a === 'string' || typeof b === 'string') {
						stack.push(`${typeof a === 'string' ? a : ''}${typeof b === 'string' ? b : ''}`);
					} else {
						stack.push(toNumber(a) + toNumber(b));
					}
					break;
				}
				case Op.Sub: {
					const b = toNumber(pop());
					stack.push(toNumber(pop()) - b);
					break;
				}
				case Op.Mul: {
					const b = pop();
					const a = pop();
					// "abc" * 3 repeats the string.
					if (typeof a === 'string') stack.push(a.repeat(Math.max(0, toInt(b))));
					else stack.push(toNumber(a) * toNumber(b));
					break;
				}
				case Op.Div: {
					const b = toNumber(pop());
					stack.push(toNumber(pop()) / b);
					break;
				}
				case Op.Rem: {
					const b = toNumber(pop());
					stack.push(Math.trunc(toNumber(pop()) / b));
					break;
				}
				case Op.Mod: {
					const b = toNumber(pop());
					stack.push(toNumber(pop()) % b);
					break;
				}
				case Op.And:
				case Op.Or:
				case Op.Xor: {
					const b = pop();
					const a = pop();
					if (i.type1 === DataType.Boolean && i.type2 === DataType.Boolean) {
						const x = truthy(a);
						const y = truthy(b);
						stack.push((i.op === Op.And ? x && y : i.op === Op.Or ? x || y : x !== y) ? 1 : 0);
					} else {
						const x = toInt(a);
						const y = toInt(b);
						stack.push(i.op === Op.And ? x & y : i.op === Op.Or ? x | y : x ^ y);
					}
					break;
				}
				case Op.Shl: {
					const b = toInt(pop());
					stack.push(toInt(pop()) * 2 ** b);
					break;
				}
				case Op.Shr: {
					const b = toInt(pop());
					stack.push(Math.floor(toInt(pop()) / 2 ** b));
					break;
				}
				case Op.Neg:
					stack.push(-toNumber(pop()));
					break;
				case Op.Not:
					if (i.type1 === DataType.Boolean) stack.push(truthy(pop()) ? 0 : 1);
					else stack.push(~toInt(pop()));
					break;
				case Op.Cmp: {
					const b = pop();
					const a = pop();
					const sameKind = typeof a === typeof b || (typeof a !== 'string' && typeof b !== 'string');
					const c = compare(a, b);
					let result: boolean;
					switch (i.extra) {
						case Cmp.LT:
							result = sameKind && c < 0;
							break;
						case Cmp.LTE:
							result = sameKind && c <= 0;
							break;
						case Cmp.EQ:
							result = sameKind && c === 0;
							break;
						case Cmp.NEQ:
							result = !sameKind || c !== 0;
							break;
						case Cmp.GTE:
							result = sameKind && c >= 0;
							break;
						default:
							result = sameKind && c > 0;
					}
					stack.push(result ? 1 : 0);
					break;
				}
				case Op.B:
					pc = i.target;
					break;
				case Op.Bt:
					if (truthy(pop())) pc = i.target;
					break;
				case Op.Bf:
					if (!truthy(pop())) pc = i.target;
					break;
				case Op.PushEnv: {
					const instances = host.withTargets(frame, pop());
					if (instances.length === 0) {
						// Jump to the matching popenv (which then finds nothing left) or past it.
						if (ins[i.target]?.op === Op.PopEnv) withs.push({ instances, index: 0, self: frame.self, other: frame.other });
						pc = i.target;
						break;
					}
					withs.push({ instances, index: 0, self: frame.self, other: frame.other });
					frame.other = frame.self;
					frame.self = instances[0];
					break;
				}
				case Op.PopEnv: {
					const block = withs[withs.length - 1];
					if (!block) break;
					if (!i.drop) {
						// Next live instance, if any: loop back to the body.
						let next = block.index + 1;
						while (next < block.instances.length && block.instances[next].destroyed) next++;
						if (next < block.instances.length) {
							block.index = next;
							frame.self = block.instances[next];
							pc = i.target;
							break;
						}
					}
					withs.pop();
					frame.self = block.self;
					frame.other = block.other;
					break;
				}
				case Op.Call: {
					const args: Value[] = [];
					for (let k = 0; k < i.extra; k++) args.push(pop());
					stack.push(host.call(frame, i.func, args));
					break;
				}
				case Op.Ret: {
					const value = pop();
					this.unwind(withs, frame);
					return value;
				}
				case Op.Exit:
					this.unwind(withs, frame);
					return undefined;
				case Op.Break:
					break;
				default:
					throw new Error(`${code.entry.name}: unhandled opcode 0x${i.op.toString(16)}`);
			}
		}
		this.unwind(withs, frame);
		return undefined;
	}

	/** Leaving code from inside a `with` block restores the original self/other. */
	private unwind(withs: WithBlock[], frame: Frame): void {
		if (withs.length) {
			frame.self = withs[0].self;
			frame.other = withs[0].other;
		}
	}
}
