import fs from 'node:fs';
import path from 'node:path';
import { type Connect, defineConfig, type Plugin } from 'vite';

const GAME_DIR = process.env.UNDERTALE_DIR ?? 'C:/Users/ariju/Documents/code_proj/undertale-reverse/assets';

/**
 * Serves the installed game's files (data.win, *.ogg) at /game/ straight from the install folder, on the
 * local dev and preview servers only. The built site never uses this route (src/gameSource.ts); in
 * preview it lets tests hand the files to the folder picker.
 */
function gameFiles(): Plugin {
	return {
		name: 'game-files',
		configureServer: (server) => serveGame(server.middlewares),
		configurePreviewServer: (server) => serveGame(server.middlewares),
	};
}

function serveGame(middlewares: Connect.Server): void {
	middlewares.use('/game', (req, res) => {
		const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
		// Plain file names only: no folders, no dot files, nothing outside the install.
		const file = /^[\w-][\w.-]*$/.test(name) ? path.join(GAME_DIR, name) : null;
		const stat = file ? fs.statSync(file, { throwIfNoEntry: false }) : undefined;
		if (!file || !stat?.isFile()) {
			res.statusCode = 404;
			res.end(`Not found in ${GAME_DIR}: ${name}`);
			return;
		}
		res.setHeader('Content-Type', name.endsWith('.ogg') ? 'audio/ogg' : 'application/octet-stream');
		res.setHeader('Content-Length', stat.size);
		res.setHeader('Cache-Control', 'no-cache');
		fs.createReadStream(file).pipe(res);
	});
}

export default defineConfig({
	plugins: [gameFiles()],
	server: { host: '127.0.0.1', port: 5173 },
	preview: { host: '127.0.0.1', port: 4173 },
});
