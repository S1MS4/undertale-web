// Decodes every code entry in data.win and checks the format assumptions the VM relies on.
// Prints structure and statistics only (no game text or code).
// Usage: node tools/check-bytecode.ts [path/to/data.win]
import { readFileSync } from 'node:fs';
import { parseDataWin } from '../src/data/DataWin.ts';
import { decodeCode, Op } from '../src/vm/bytecode.ts';

const path = process.argv[2] ?? 'C:/Users/ariju/Documents/code_proj/undertale-reverse/assets/data.win';
const t0 = performance.now();
const data = parseDataWin(new Uint8Array(readFileSync(path)));
console.log(`parsed in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`objects ${data.objects.length}, rooms ${data.rooms.length}, room order ${data.roomOrder.length}, first room ${data.roomNames[data.roomOrder[0]]}`);
console.log(`code ${data.code.length}, strings ${data.strings.length}, variable refs ${data.variableRefs.size}, function refs ${data.functionRefs.size}`);
console.log(`backgrounds ${data.backgrounds.length}, sounds ${data.sounds.length} (${data.sounds.filter((s) => s.audioId < 0).length} streamed), embedded audio ${data.audio.length}, paths ${data.paths.length}`);

const eventTypes = new Map<number, number>();
for (const o of data.objects) for (const type of o.events.keys()) eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
console.log(`objects with events by type: ${[...eventTypes].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join(' ')}`);
const parentsOk = data.objects.every((o) => o.parent === -100 || o.parent === -1 || (o.parent >= 0 && o.parent < data.objects.length));
console.log(`parents valid: ${parentsOk}; sprites valid: ${data.objects.every((o) => o.sprite >= -1 && o.sprite < data.spriteList.length)}`);
const r0 = data.rooms[data.roomOrder[0]];
console.log(`first room: ${r0.width}x${r0.height} speed ${r0.speed}, ${r0.instances.length} instances, ${r0.views.filter((v) => v.enabled).length} views, ${r0.tiles.length} tiles`);
const maskCounts = new Map<string, number>();
for (const s of data.spriteList) {
	const key = `kind ${s.collisionKind}: ${s.masks.length === s.frames.length ? 'mask per frame' : s.masks.length === 1 ? 'one mask' : `${s.masks.length} masks/${s.frames.length} frames`}`;
	maskCounts.set(key, (maskCounts.get(key) ?? 0) + 1);
}
console.log(`sprite masks: ${[...maskCounts].map(([k, n]) => `${k} x${n}`).join('; ')}`);

const opCounts = new Map<number, number>();
let failures = 0;
let unresolvedVars = 0;
let unresolvedCalls = 0;
let instructions = 0;
const popPatterns = new Map<string, number>();
const t1 = performance.now();
for (const entry of data.code) {
	if (entry.length === 0) continue;
	try {
		const code = decodeCode(data, entry);
		instructions += code.instructions.length;
		code.instructions.forEach((ins, i) => {
			opCounts.set(ins.op, (opCounts.get(ins.op) ?? 0) + 1);
			if ((ins.op === Op.Pop || (ins.op >= Op.Push && ins.op <= Op.PushBltn && ins.type1 === 5)) && !ins.variable) unresolvedVars++;
			if (ins.op === Op.Call && !ins.func) unresolvedCalls++;
			// What precedes array assignments tells us the stack order for pop with an array target.
			if (ins.op === Op.Pop && ins.varKind === 0x00) {
				const prev = code.instructions.slice(Math.max(0, i - 3), i).map((p) => p.op.toString(16)).join(',');
				const key = `pop.${ins.type1}.${ins.type2} after [${prev}]`;
				popPatterns.set(key, (popPatterns.get(key) ?? 0) + 1);
			}
		});
	} catch (err) {
		if (failures++ < 5) console.log(`decode failed: ${(err as Error).message}`);
	}
}
console.log(`decoded ${instructions} instructions in ${(performance.now() - t1).toFixed(0)} ms, ${failures} failures, ${unresolvedVars} unresolved variables, ${unresolvedCalls} unresolved calls`);
console.log(`opcodes: ${[...opCounts].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o.toString(16)}:${n}`).join(' ')}`);
console.log('array pop patterns (top 8):');
for (const [k, n] of [...popPatterns].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${n}  ${k}`);
