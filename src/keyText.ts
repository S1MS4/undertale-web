import type { DataWin } from './data/DataWin.ts';

/**
 * Game text that names keys this port uses differently: Space confirms (Enter doesn't), and holding Enter
 * skips a cutscene. The instructions screen has no free row for a new line, so the skip line takes the
 * place of its "When HP is 0" tip.
 */
const REPLACEMENTS = new Map([
	['[Z or ENTER]', '[Z or SPACE]'],
	['[PRESS Z OR ENTER]', '[PRESS Z OR SPACE]'],
	['[Z / ENTER]', '[Z / SPACE]'],
	['When HP is 0, you lose.', '[Hold ENTER] - Skip scene'],
]);

/** Rewrites those strings in place. Run before any game code is decoded, since decoding copies them. */
export function patchKeyText(data: DataWin): void {
	data.strings.forEach((text, i) => {
		const replacement = REPLACEMENTS.get(text);
		if (replacement !== undefined) data.strings[i] = replacement;
	});
}
