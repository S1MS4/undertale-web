# undertale copycat - all of this is my own code built from scratch

A GameMaker runner written from scratch in TypeScript (bytecode interpreter + WebGL2 renderer) that plays Undertale in the browser from **your own copy** of the game. This repository contains no game files: no `data.win`, music, sprites or decompiled game code. Undertale is © Toby Fox; buy it to play.

## Run

```powershell
npm install
npm run dev        # http://127.0.0.1:5173
```

The game folder defaults to `C:/Users/ariju/Documents/code_proj/undertale-reverse/assets`. Set `UNDERTALE_DIR` to use another one.

## Deploy

Live at https://roomly.fun. None of the game's files are on the site: on first visit the player picks their Undertale install folder, the page reads `data.win` and the `.ogg` files locally (nothing is uploaded) and keeps a copy in the browser's private storage (OPFS), so later visits start straight away. **Forget game files** in the settings menu removes that copy.

```powershell
npm run preview                    # the production build at http://127.0.0.1:4173 (asks for the folder)
firebase deploy --only hosting     # builds, then publishes dist/ to roomly.fun
```

Hosting is the `roomly-prototype` Firebase project (`.firebaserc`). Always deploy with `--only hosting`: the same project holds the old Roomly app's Firestore rules, which this repo doesn't manage. Earlier releases, including the old Roomly site, can be rolled back in the Firebase console under Hosting → Release history.

## Controls

| Key | Action |
|---|---|
| Arrows or WASD | Move |
| Enter | Confirm |
| X or Shift | Cancel |
| C or Ctrl | Menu |
| Hold Space | Skip a cutscene: fills a bar, the screen fades to black, the game runs ahead out of sight until you're needed (free to walk, a choice, or a battle), then fades back in. |
| Z at a yellow star | Save (the game's own save point) |
| F4 | Fullscreen |
| Hold Esc | Quit to the start screen |

The **Keybinds** button (top left) shows these in the page. Standard gamepads work too. The picture follows the window's shape: the game's 640x480 layout stays centred, the sides show more of the room, and full-screen fades and flashes are widened to cover them.

Skipping jumps over dialogue, including instructions. If a character seems to wait in your way afterwards, the game is usually waiting for you to do something, such as flipping a marked switch.

## Saves

- **Start New Game** always starts with no save data.
- The game saves in the browser (IndexedDB) at yellow stars. **Export save** (top left) works any time: when you're free to walk it first saves your current room with the game's own save routine (Continue puts you at that room's save point, as in the original), then writes a folder `undertale-save-<date-time>` with the save files and a signed manifest (`undertale-web-save.json`).
- **Import Save** accepts only an unchanged folder exported by this browser: the manifest is signed with an HMAC key that can't be read out of the browser, and every file's size and SHA-256 are checked.
- The **? How the save works** panel shows the steps with pictures.

## Layout

```
src/data/       data.win reader (sprites, rooms, objects, code, sounds...)
src/vm/         the engine: bytecode decoder, interpreter, rooms and events, built-in functions and variables,
                audio (Web Audio), input, INI/text files
src/render/     WebGL2 renderer (sprites, shapes, views, surfaces)
src/gameSource.ts  where data.win and the music come from: dev server, the browser's copy, or the picked folder
src/scenes.ts   launcher (Continue / Import Save / Start New Game)
src/gameScene.ts  running game + hold-Space skip
src/save*.ts    save slots, signed export/import, save-file validation
tools/          checks: check-datawin.ts, check-bytecode.ts, test-saves.ts
```

## Checks

```powershell
npm run check                    # TypeScript
node tools/check-bytecode.ts     # decodes every code entry in data.win
node tools/test-saves.ts         # attacks the save import with tampered and malformed folders
```

In dev mode the console has `window.__dev` (step the game, tap keys, walk, skip, status) for testing.

## Known gaps

- `sprite_replace` (loads an image file from disk) does nothing in the browser.
- Console-only features (async buffer saving, Steam cloud) are stubbed; the PC save path is used.
- Collision and rounding follow GameMaker's documented behaviour; rare edge cases may differ from the original runner.
