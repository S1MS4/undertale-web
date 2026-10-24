/**
 * The round buttons at the top left: Help opens a menu of the side panels (see helpPanel.ts), Export runs on its
 * own (see main.ts), Volume opens the volume slider. One popover at a time; a click elsewhere, Escape or picking a
 * menu item closes it. The game reads keys on the window, so keys used inside an open popover stop here.
 */
export function setupToolbar(): void {
	const popovers = [
		{ toggle: '#help-toggle', popover: '#help-popover' },
		{ toggle: '#audio-toggle', popover: '#audio-popover' },
	].map((ids) => ({
		toggle: document.querySelector<HTMLButtonElement>(ids.toggle)!,
		popover: document.querySelector<HTMLElement>(ids.popover)!,
	}));
	const toolbar = document.querySelector<HTMLElement>('#toolbar')!;

	const setOpen = (target: (typeof popovers)[number] | null) => {
		for (const p of popovers) {
			const open = p === target;
			p.popover.hidden = !open;
			p.toggle.setAttribute('aria-expanded', String(open));
		}
		target?.popover.querySelector<HTMLElement>('button:not(:disabled), input')?.focus();
	};
	const openOne = () => popovers.find((p) => !p.popover.hidden);
	/** Closes everything and, when the mouse did it, hands the keyboard back to the game. */
	const closeAll = (returnFocus: boolean) => {
		const open = openOne();
		setOpen(null);
		if (returnFocus) open?.toggle.focus();
		else if (toolbar.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
	};

	for (const p of popovers) {
		p.toggle.addEventListener('click', (e) => {
			if (!p.popover.hidden) return closeAll(e.detail === 0);
			setOpen(p);
			// Opened with the mouse: leave the focus on the page so keys keep going to the game.
			if (e.detail !== 0) (document.activeElement as HTMLElement | null)?.blur();
		});
	}
	// The item's own handler (the panel opening) runs too; this only hides the menu.
	for (const item of toolbar.querySelectorAll<HTMLButtonElement>('.menu button')) {
		item.addEventListener('click', () => setOpen(null));
	}
	addEventListener('pointerdown', (e) => {
		if (openOne() && !(e.target as HTMLElement).closest('.popover-anchor')) closeAll(false);
	});
	for (const type of ['keydown', 'keyup'] as const) {
		toolbar.addEventListener(type, (e) => {
			const target = e.target as HTMLElement;
			const inOpen = !!target.closest('.popover:not([hidden])');
			// Enter or Space on a round button only works it; elsewhere in the bar keys reach the game.
			const onToggle = !!target.closest('.round') && (e.key === 'Enter' || e.key === ' ');
			if (!inOpen && !onToggle) return;
			if (type === 'keydown' && e.key === 'Escape') closeAll(true);
			e.stopPropagation();
		});
	}
}
