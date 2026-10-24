# Handoff: automated full playthrough

Goal from the user: play Undertale start to finish at maximum speed with the autoplayer and fix any engine bugs found.

**Status (2026-10-23): two routes played to the ending, plus a sweep of every story room the route missed.** All results are from the final code; none produced an engine warning or error.
- **Fight route** (`a.newGame()`): a new game to the ending and back to the title. This covers the Ruins, Snowdin, Waterfall, Hotland, the castle, the king's fight, the game closing itself twice, the last fight and the ending. The autoplayer did everything except choosing Continue on the launcher after each self-close, which is what a player does too.
- **Sparing route** (`a.newGame(1, 'spare')`): never chooses FIGHT unless a battle passes 30 turns. It got to the ending at LV 1 with one kill, a monster finished by that fallback. Everything else, including Toriel, was spared through ACT and MERCY, Undyne was fled, and the final choices were SPARE.
- **Warp spots:** every place the autoplayer had to warp was checked by hand in the engine. Each room's way on works; the warps are puzzles or autoplayer limits.
- **Sweep:** after the fight route, all 88 story rooms it never reached were entered and played in one pass with `a.sweep()`. The only warning was the bird-room marker read described below, which is now handled.
- **Visual spot checks:** Waterfall, the hotel and the Core render as expected.
- **Not tested:**
  - Sound at real time: tests are silent on purpose, at the user's request.
  - The true pacifist ending, which needs the dates and the true lab.
  - Solving every puzzle by playing it rather than checking its mechanics.

## How to run it

1. `npm run dev` (it may already be running on http://127.0.0.1:5173).
2. Open **http://127.0.0.1:5173/?mute&hold** in Chrome.
   - `?mute` runs the game with `SilentAudio`, which never opens the sound device. Always use it for tests (the user asked for silent tests).
   - `?hold` (dev only) freezes the game from its first step, so only the autoplayer advances it. Together with the fixed seed and clock that `newGame()` sets, **runs repeat step for step**: to look at step N again, reload and run to N.
3. Press Enter on the launcher (Start New Game). If a test save exists it asks again, so press Enter a second time. Then in the console:
   ```js
   const a = window.__auto; a.newGame(); a.run(38000);   // repeat a.run(38000) to continue
   ```
   - Keep each browser-tool call under about 40 s; the tool times out at 45 s.
   - `run()` returns `{ reason, steps, gameMinutes, room, furthest, battles, warps, lv, plot, recent }`. `a.log` has the full log, including `WARNING` lines for engine warnings.
   - `a.run(ms, maxSteps)` stops after `maxSteps` steps, which is how to reach a given step. `a.status()` shows the current target door and `interact`. `a.doors` holds what each door was found to lead to. `a.stall()` forces stalled mode for testing.
4. **The game closes itself** after the king's fight (that is Undertale's own story), and `run()` stops with `reason: 'game ended'`. To continue:
   - Set `window.__holdLoop = false` so the launcher responds.
   - Choose Continue: press Up and Up, check with a screenshot, then press Enter.
   - In the console: `const g = __scene.game; g.setRandomSeed(1); g.fixedClockFrom = g.frameCount; a.run(30000)`.
5. Saving `src/autoplay.ts` makes Vite reload the page, which loses the running game. Make edits between runs, and use a new URL (`?mute&hold&v=N`) afterwards.
6. A disassembler for looking at the game's code lives outside the repo. To make one: decode with `decodeCode` from `src/vm/bytecode.ts`, filter `data.code` by name (e.g. `gml_Object_obj_iceevent_`), and print opcodes. Don't commit its output (it is the game's code).

## What the autoplayer does (src/autoplay.ts, dev only)

- Presses Z for dialogue. Keeps `global.hp` (and the last fight's `global.my_hp`) at 99 or more, since some hits take a full bar in one step.
- Battles (`chooseBattleAction`):
  - Fight mode uses FIGHT while it lowers the monsters' HP. After 6 turns where it doesn't, it rotates through each ACT option, each followed by MERCY's Spare, then FIGHT.
  - Spare mode uses that rotation from the first turn.
  - After 30 turns it flees every other turn; in spare mode it uses FIGHT on the turns between.
  - The ACT options sit in two columns of three (0–2 on the left, 3–5 on the right) and are reached with the arrow keys.
  - A battle only counts as stuck after 10 game minutes (40 in the last fights) without the monsters' HP going down.
- In spare mode, the final choices take the rightmost button (SPARE).
- Walks to the best door. The move goes through the engine's dev hook `Game.ghostMove`: it is applied right after `xprevious` is recorded, and skips the player's collisions with walls. So walls don't stop it, but triggers behave as in real play.
- Learns where doors lead. It records a door only if the player touched it, and applies the result to every stacked piece of that door. It explores at the frontier and marks dead ends. It steps around other doors and the igloo teleporter, keeping one sidestep direction.
- When stalled (2500 steps), it talks to everyone (`obj_interactable` descendants) in rooms near the furthest point reached. It talks to each twice per plot value, taking the first and then the second option at choices. Untried doors come first.
- Saves at save points (Z, then X), and leaves shops (X, down x3, Z).
- Holds an arrow key when stepping onto ice and while sliding.
- Finds a path around `obj_shockblock` (the invisible maze) by breadth-first search.
- In battle, steers the heart onto quiz answers, the fake buttons and the souls' buttons in the last fights, pressing Z throughout.
- A run ends with `reason: 'finished: …'` once the ending has played and the game is back at its title.
- Treats the last fight's stand-in player (`obj_mainchara_fake`) as the player.
- After 9 game minutes without progress, it warps to the first story room after the frontier that it hasn't visited, resets `interact`, and records the warp with a snapshot (`a.warpInfo`). It never warps out of battles, the last fights or the ending rooms (`SELF_RUNNING_ROOMS`).
- Among doors known to lead forward, it prefers the nearest next room, so a far jump doesn't skip a stretch.

## Coverage sweep

After a run, `a.unvisited()` lists the story rooms never reached, and `a.sweep(names, stepsEach)` enters each one, with the plot of the nearest earlier room the run reached, and plays it.
- Run it in a **new game** after the main run: the autoplayer keeps its records across games on the same page, but not across reloads, and saving `autoplay.ts` reloads.
- Jumping between rooms can trigger battles out of story order. One that needs aiming (Mettaton's shooter battle) never ends and strands the rooms after it; start a new game and carry on from the next room.
- `jump()` changes room immediately (`Game.afterFrame()`), so the old room can't run another step that would change `global.entrance` or `interact`.

## Warps on the seed-1 run (places the autoplayer can't solve)

- `room_tundra_iceentrance`: an ice puzzle with drop holes and X/O tiles. Plus two follow-on stalls around `room_tundra_iceexit_new`, `room_tundra_iceexit` and `room_icecave1`.
- Waterfall: `room_water_temvillage`, `room_water17`, `room_water_undynefinal`.
- Hotland: `room_fire_lab2`, `room_fire3`, and `room_fire_elevator_l1`. That last warp jumped to `room_fire_finalelevator` and skipped most of Hotland, because the room order puts it next.

All of them were checked with direct engine tests, and none is an engine bug:
- **The ice puzzle:** the X/O tiles flip and the controller registers the win. The right-hand door leads on to `room_tundra_poffzone`. `iceexit_new` and `iceexit` are the optional rooms you fall into.
- **The Undyne chase room:** with real arrow keys the player reaches `undynefinal2`. The autoplayer got stuck beside a wall.
- **The darkness room (`water17`) and the lab exit:** both lead on. The stalls were `interact` carried over by a warp; warps now reset it after the room change.
- **The Hotland elevators:** the Core's last room leads to the final elevator, and the L1 elevator is the lab-side stop.

The autoplayer still skips Waterfall from onionsan to the Undyne bridge, and much of Hotland, through doors reached by walking through walls; the sweep covers those rooms.

## Bugs found and fixed this session

- **Save files the game writes were dropped:** the save store only kept `config.ini`, `file0`, `file9` and `undertale.ini`. Undertale also writes `file8` after the king's fight (it loads it when reopened) and two marker files (`system_information_962` and `963`). Without `file8`, reopening the game went to its error room (`room_of_dog`). They are now in `SAVE_FILES` (`src/saveFormat.ts`), and `tools/test-saves.ts` passes.
- **A door into a room without its marker left the player outside the room.**
  - The tall-grass room's left door (`room_water_prebird` to `room_water_bird`) sets entrance 24, and the bird room has no `obj_markerX`. A player can walk there with the arrow keys.
  - GameMaker would stop with an error there. The engine used 0, which put the player at (0, 0), above the walls and stuck.
  - A failed read of `x` or `y` from a missing instance now returns the reader's own value (`Game.getVar`), so the player stays where the room placed them.
- **Seeded random numbers:** `random`, `irandom`, `choose` and so on use a mulberry32 generator in `Game`. `random_set_seed` and `random_get_seed` work (they were no-ops), and `randomize` reseeds.
- **Test clock:** `Game.fixedClockFrom` makes `current_time` and `get_timer` count game steps.

## Fixed in the previous session

- Skip runs Draw events, fades out, skips, and fades in. It only triggers when `interact == 1`.
- `collision_rectangle` off-by-one.
- Full-screen fades and flashes are widened to the window's sides.
- Export works any time.

## Verified working (not bugs)

- Paths (`path_start`), the Toriel scenes, ice tiles, the electric maze, the igloo, shops, the quiz, the king's fight and the fake-button choice, the game closing itself and continuing, the last fight with all six souls, and the ending.
- A test that teleports the player into a trigger makes it fire every step, because the trigger's push back to `xprevious` can't undo a teleport.

## Next steps (optional)

1. Look at the warp spots above. They are puzzles, but an engine issue could still be hiding there.
2. Profile `room_tundra_iceentrance`: the engine alone runs about 1500 steps/s there, against about 4000 elsewhere. The last fight runs at about 900 steps/s.
3. Other routes (sparing everyone, the true ending) are untested. The autoplayer always picks FIGHT.

## Notes about the user

- They use OBS, and system audio sounded damped. Windows communications ducking is at its default ("reduce by 80%"). Nothing was changed on their system.
- Don't reproduce game text or artwork in the repository or in messages.
