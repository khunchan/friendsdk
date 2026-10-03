# Friend Climb

SDK version **v0.1.4**. Your Rare Friend bounces up a tower on its own; you only steer it left and right.
The lane wraps — walk off one edge and you reappear on the other, like the genre's classic screen wrap. Reach
for stars, watch your own past runs and a scripted "bot" climb alongside you as translucent ghosts, and see
how high you get before you miss a platform and fall.

**Everything is free and simulated.** There is no ticket, no RF cost and no reward. An owned Generations NFT
is still required to play; the SDK runtime checks it, exactly as for every other game on the platform.

**Status: stage 0, a free prototype.** This is the first of three planned stages (see `docs/DESIGN.md` for
stages 1–2): shared leaderboards, ghosts of other players and paid tournaments all need a backend FriendSDK
does not have yet. Nothing here is a finished submission; it exists to find out whether the climb itself is
fun before any of that is built.

## How it uses Rare Friends

Your Friend's canonical sprite (read from the chain, never altered — only squashed and stretched by this
game's own jump animation) is the character climbing the tower. Its SDK character family picks the color of
this game's own bounce sparks and star-pickup sparkle; the sprite pixels themselves are untouched.

## Play

Pick **Tower of the day** (the same tower for everyone today, from the UTC date) or **Practice** (a fresh
random tower every time). Move with the arrow keys or A/D, or hold either half of the tower on a touchscreen.
Your Friend bounces automatically; you are only steering sideways. Land on platforms to keep climbing — a
cracked platform (white fill) breaks after one bounce. Collect stars for bonus points. Falling more than one
screen below your highest point ends the run.

Settings has reduced motion (turns off landing squash-and-stretch and sparks; never changes the physics or
score) and a Sound button (a landing thud and a star chime, off by default).

A zigzag mark on a platform is a **spring**: bouncing off it launches you noticeably higher than a normal
landing — a repeatable shortcut, never required to clear a gap. Landing on consecutive stars with no plain
landing in between builds a **combo**: each star in the streak is worth more than the last, up to a cap, reset
by the next plain landing. Every 100 height-points you reach for the first time in a run fires a one-off
milestone banner and a subtle background tint shift — purely a progress cue, never fed back into the physics
or the score.

## Towers, physics and determinism

A tower is generated entirely from one 32-bit seed: platform positions, widths, which ones break, where the
stars are, and a few wind bands higher up. Every gap is built to stay within what one bounce can clear and
every sideways jump within what steering can cross in that time — `tower.test.mjs` checks this directly from
the physics constants, so the climb is provably always possible, never a trap.

The physics run on a **fixed 1/60s step**, decoupled from the browser's actual frame rate. The same seed and
the same recorded left/right presses always replay to the exact same score, on any machine, at any frame
rate — `tower.test.mjs` checks this too. That determinism is also what makes two things possible:

- **A run code to share.** After a run, a short text code (`FC3.<seed>.<moves>!<score>`) encodes the seed and
  every direction change — not every frame, so it stays short for a realistic run. A friend pastes it in and
  races a ghost of that exact run on the same tower. There is no server: the code is the whole message. The
  version number has moved twice (v1 → v2 → v3, see Known limits), each time because a change to scoring meant
  old codes could no longer be replayed to the score they claimed; `decodeRun` refuses a v1 or v2 code by name
  instead of guessing.
- **A bot ghost from your first attempt.** A simple scripted "bot" (always labeled "bot", never shown as a
  Friend) aims at the next platform with a human-scale reaction delay and an increasing chance to fumble as
  the tower gets harder, so it is an opponent, not an aimbot — `tower.test.mjs` checks that it is reproducible
  and that it is sometimes beaten and sometimes not, across 100 seeds.

## Known limits

- **Nothing here is saved.** The SDK's game sandbox cannot use `localStorage` or IndexedDB (see
  `HOST_INTEGRATION.md`), so your best score, your own ghosts and the bot's run all live only in the open
  tab and disappear on reload. The game says so in the picker screen, not just here.
- **Clipboard copy may not work inside the SDK's sandbox** (the game iframe has no `allow="clipboard-write"`).
  When it fails, the run code stays in a plain text field to select and copy by hand instead.
- **Tilt/motion controls were not added.** The sandboxed iframe has no `allow="accelerometer; gyroscope"`
  either, so device-orientation steering would likely be blocked outright; keyboard and touch are the only
  controls for now.
- **Ghosts are markers, not sprites.** A pasted run code carries no Friend identity (only a seed, moves and a
  claimed score), so an opponent's ghost is drawn as a dashed outline labeled by who it is, not their Friend's
  artwork.
- **Difficulty and the bot's fumble rate are a first pass**, not final balance; both need real playtesting
  to tune properly, same as any new platformer.
- **The SDK's own toolbar (Local preview / Friend # / Friend wallet buttons) cannot be restyled from game
  code.** Checked directly against `assets/game-frame.css`: it exposes only `--rf-game-max-width` and
  `--rf-game-aspect-ratio` as custom properties, and every toolbar color is hardcoded in that stylesheet. There
  is no `host.css` hook or frame variable this game can use to make those buttons match its dark palette — a
  genuine SDK v0.1.4 limitation, not something worked around here.
- **Run code version history.** v1 (`FC1`) paid out a star's +25 on every single bounce off that platform, not
  once — repeat bounces on one star platform could inflate a score without limit, a real hole for any future
  tournament. Fixed by tracking collected stars the same way broken platforms are tracked (once per platform,
  ever); the run code version moved to `FC2`. v2 had no springs or combo bonus; adding them in v3 (`FC3`)
  changes what the same seed and recorded moves replay to, same as the v1 fix did. Both older prefixes are now
  refused with their own clear message rather than replayed to a different score.
- **Features considered for the "jumping feels empty" pass and not built this round:** moving platforms
  (left-right) and avoidable obstacles (birds/drones). Both would need their own reachability proof added to
  `tower.test.mjs` — a moving platform's catchable window changes the gap math everywhere, and an obstacle that
  ends the run on touch needs a guarantee it can always be dodged, not just usually — which is more scope than
  springs, milestones and the combo bonus together. Good candidates for a follow-up round once those three have
  been played with for a while.

## Checks

Run on 2026-10-03 with SDK v0.1.4 and Node.js 22, from the SDK root:

| Command | Result |
| --- | --- |
| `node --test games/friend-climb/tower.test.mjs` | 15 tests: replay, encode/decode, run-code version rejection, reachability, tower safety, springs, combo, the bot, scoring |
| `node scripts/dev-game.mjs check games/friend-climb` (`friendsdk check`) | game definition and build |
| `node scripts/dev-game.mjs test games/friend-climb` (`friendsdk test`) | the SDK's automated browser check with its mock wallet |
| `node games/friend-climb/check-browser.mjs` | this game's own browser check at 1100 px and 360 px |
| `npm run typecheck` | passed |
| `npm run check:games` | passed for `games/friend-climb`; pre-existing, unrelated failure on `games/friend-rooms` (missing `game.json`, a different frozen project) |

## Files

`index.tsx` (the game component), `tower.ts` (deterministic tower generation, physics, the bot, run codes —
framework-free, unit-tested on its own), `tower.test.mjs`, `check-browser.mjs`, `style.css`, `game.json`
(an unused schema-only chance-game definition; this game never calls `buy`, `play`, `settle` or `redeem`,
the same pattern `examples/scrolling-world` uses for a free exploration game).
