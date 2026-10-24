/**
 * The side panels ("How the save works", "Keybinds"), opened from the help menu. Only one is open at a time;
 * Escape or Close shuts it and returns focus to the help button (the menu is gone by then).
 * Set up first so they work while data.win is still loading.
 */
export function setupHelpPanel(): void {
	const panels = [
		{ toggle: '#help-open', panel: '#help-panel', close: '#help-close', title: '#help-title' },
		{ toggle: '#keys-open', panel: '#keys-panel', close: '#keys-close', title: '#keys-title' },
	].map((ids) => ({
		toggle: document.querySelector<HTMLButtonElement>(ids.toggle)!,
		panel: document.querySelector<HTMLElement>(ids.panel)!,
		close: document.querySelector<HTMLButtonElement>(ids.close)!,
		title: document.querySelector<HTMLElement>(ids.title)!,
	}));
	const helpButton = document.querySelector<HTMLButtonElement>('#help-toggle')!;

	const refocus = () => helpButton.focus();

	const setOpen = (target: (typeof panels)[number] | null) => {
		for (const p of panels) {
			const open = p === target;
			p.panel.hidden = !open;
			p.toggle.setAttribute('aria-expanded', String(open));
		}
		target?.title.focus();
	};

	for (const p of panels) {
		p.toggle.addEventListener('click', () => setOpen(p.panel.hidden ? p : null));
		p.close.addEventListener('click', () => {
			setOpen(null);
			refocus();
		});
	}
	addEventListener('keydown', (e) => {
		const open = panels.find((p) => !p.panel.hidden);
		if (e.key === 'Escape' && open) {
			setOpen(null);
			refocus();
		}
	});
}
