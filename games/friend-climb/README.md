# Friend Climb

SDK version **v0.1.4**. Your Rare Friend bounces up a tower on its own; you only steer it left and right.
The lane wraps — walk off one edge and you reappear on the other, like the genre's classic screen wrap. Reach
for stars, watch your own past runs and a scripted "bot" climb alongside you as translucent ghosts, and see
how high you get before you miss a platform and fall.

**Everything is free and simulated.** There is no ticket, no RF cost and no reward. An owned Generations NFT
is still required to play; the SDK runtime checks it, exactly as for every other game on the platform.

**Status: stage 0, a free prototype.** This is the first of three planned stages (see `docs/DESIGN.md`, which
now has a drafted plan for stages 1–2 — shared leaderboards, ghosts of other players and a paid daily
tournament — none of it implemented yet, all of it needing a backend FriendSDK v0.1.4 does not have). Nothing
here is a finished submission; it exists to find out whether the climb itself is fun before any of that is
built.

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

The keyboard works the instant a run starts — after clicking "Tower of the day"/"Practice", or after starting
either one with Enter/Space while it's focused — without first clicking anywhere on the game itself. Steering
is listened on the game's own document, not just the canvas, specifically so it keeps working even if focus
ends up somewhere else entirely; the canvas is still focused automatically on start too, for touch/assistive
tech and so its own aria-label gets announced.

Settings has reduced motion (turns off landing squash-and-stretch and sparks; never changes the physics or
score) and a Sound button (a landing thud and a star chime, off by default).

A zigzag mark on a platform is a **spring**: bouncing off it launches you noticeably higher than a normal
landing — a repeatable shortcut, never required to clear a gap. Landing on consecutive stars with no plain
landing in between builds a **combo**: each star in the streak is worth more than the last, up to a cap, reset
by the next plain landing. Every 1000 points of score — the exact same number the HUD's "Score N" reads, not
a separate height or distance unit — fires a brief, bright milestone banner and a subtle background tint
shift, each exactly once. Both are purely a progress cue, never fed back into the physics or the score itself.

## The chase, drones and power-ups

Jumping with nothing else going on got repetitive once a run passed a few hundred points — no time pressure
and no sense of competing with anyone in the moment. Five mechanics address that, each with its own Settings
toggle (default on) so you can compare what each one actually adds:

- **Chase.** Short, recurring "lava" waves, not a permanent rising floor — a playtest of the original
  always-on, ever-accelerating chase (FC5 and before) showed it killing a weak player on the very first
  encounter and never letting up, which is the opposite of what a time-pressure mechanic should feel like.
  Outside a wave, the only death boundary is the ordinary `FALL_MARGIN` one below; a wave triggers every
  `CHASE_WAVE_SCORE_STEP` score points (1000 — the exact same milestone the on-screen banner announces, by
  construction, not by coincidentally-matching tuning), with a ~1.5s "LAVA SURGE!" warning before the floor
  actually starts rising, then a ~7-8s rise-and-recede window (`chaseWaveFloor`, `chaseWaveDuration`,
  `chaseWaveSpeed`). Each later wave rises a little faster and lasts a little longer, both capped. Drawn as a
  filled, wavy-edged band in the same black/green/white palette as everything else — never a traditional
  orange/red lava — and it IS the death boundary whenever an active wave is ahead of `FALL_MARGIN`: the
  camera's reference height becomes `max(peakHeight, chaseFloor + FALL_MARGIN)`, the same "screen's bottom
  edge is exactly the death line" guarantee from the camera section below, generalized to whichever threshold
  is currently stricter. `tower.test.mjs` proves the wave's own timing (absent, warning, active, receded) and
  that stalling between waves is never punished — only an active wave is a threat, never a permanent one. A
  second fix (see "Making the chase actually visible" below) addresses a real report that it never appeared
  at all, which turned out to be a real bug, not a perception problem.
- **Drones.** Small hazards that patrol a short horizontal stretch at specific heights (never before
  `DRONE_START_HEIGHT`); crossing through one knocks you down hard and starts a brief invulnerability window,
  so one overlap is one hit, not one hit per tick. A drone's own width is kept well under the lane's full
  width on purpose, so a gap big enough to fit through always exists regardless of seed or where in its
  oscillation it currently is — `tower.test.mjs` checks this algebraically (a fixed-width guarantee, not a
  per-seed simulation), plus a dedicated test for the knock-down-then-cooldown behavior itself. Drawn as a
  spiked, spinning hazard with a pulsing core (`drawDroneHazard`) over a faint hazard-striped band marking its
  *full* patrol reach (not just where it happens to be right now) — a plain rounded rectangle with a dot used
  to read as "just another platform with a dot on it" (a real playtest report), which this directly fixes. The
  first drone that actually enters view gets a one-shot alert sting; getting close to a live (not cooling
  down) one gets its own, repeatable proximity blip, both separate from and in addition to the chase's own
  warning cue (see "Making the chase and drones noticeable" below).
- **Power-ups**, placed on specific platforms at generation time, deterministic like stars and springs: a
  **rocket** (a steady, obstruction-free climb for about 2.5 seconds), a **shield** (cancels exactly one
  otherwise-fatal fall, then is gone), and a **magnet** (auto-collects any star within reach for about 5
  seconds, even ones you never actually land on — capped at your own peak height reached so far, so it can
  never credit a star you have not genuinely gotten up to yet). All three are reusable, like a spring, not
  single-use like a star.
- **Race HUD.** A small second readout next to the score — "1st of N" among everyone sharing the screen right
  now (the bot, your own past runs, any pasted code) plus a direct delta against the bot specifically, since
  the bot is the one opponent every player always has. Purely presentational.
- **Music & FX.** Three procedural layers, synthesized directly with WebAudio (never a sampled or licensed
  track): a melody arpeggio present from the start, a bass root under every other beat, and a kick/hihat pair
  that only joins in once the climb has made real progress — so the *texture* visibly thickens as a run goes
  on, not just the tempo, which itself still ramps up the longer the chase has had to build. Screen shake and
  a brief flash fire on a hit or a death (a different, non-shaking flash plus a reward sound on reaching the
  summit, never the "something hit you" cue). Screen shake is skipped entirely under Reduce Motion; the music
  keeps going either way, muted by the same Sound button as everything else.

Chase, drones and power-ups all change what a given seed and recorded moves replay to, so each run snapshots
its own current Settings into a `RunRules` the moment it starts and encodes that into its run code (see
below) — a ghost (the bot, your own past runs, a pasted code) always replays under the exact rules it was
recorded with, never whatever you currently have toggled, so two players comparing the same code never get a
different outcome depending on their own Settings. Race HUD and Music & FX never affect the physics at all,
so they are not part of a run's rules or its code.

### Making the chase and drones noticeable

First playtest round: both mechanics were confirmed working (Settings defaults on, build current, chase
provably catches a stalled Friend) but were, in practice, essentially never encountered or understood. Two
separate problems, both now fixed:

1. **`DRONE_START_HEIGHT` was tuned too high.** Driving the game's own bot (a scripted, reasonably competent
   player, not a specifically weak one) through the real build repeatedly showed death around height 130–310
   under the chase's pace — the original `DRONE_START_HEIGHT=700` meant drones essentially never appeared in
   an actual run, independent of player skill. Lowered to 220 (and `DRONE_SPACING` 420→300) — a data-driven
   balance fix grounded in the bot's own measured death heights, not a per-player difficulty slider.
2. **Neither mechanic announced itself.** A player dying to the chase or a drone had no way to tell that was
   what happened, as opposed to an ordinary missed platform. Now: each wave's ~1.5s warning window fires a
   "LAVA SURGE!" banner and a rising rumble tone exactly once per wave (not once per run, since waves recur);
   the first time any drone is actually visible on screen (not merely generated into the tower), a short
   two-note alert sting fires once per run, and getting close to a *live* one (not on cooldown) fires its own
   shorter, repeatable proximity blip on top. None of the lava cue is gated by `raceHudOn`/`fxOn` (it is drawn
   as a plain banner, not an "FX") — every sound specifically respects the Music & FX toggle and the Sound
   button, same as the rest of the audio.

### Making the chase actually visible

A second playtest round liked the mechanics but reported never actually seeing a chase wave across a normal
run, at any of several milestones. That turned out to be a real bug, not a perception problem, with a second
contributing tuning issue on top:

1. **The wave's floor was anchored to the wrong moment.** It used to snapshot the peak height once, right
   when the milestone was crossed — but the ~1.5s warning window still has to elapse before the floor
   actually starts rising, and a player who keeps climbing through that window (the normal case) is already
   some distance ahead of that stale snapshot by the time the wave goes active. The floor would start the
   wave already behind the camera's own bottom edge, sometimes invisibly so. Fixed: the anchor now stays
   fresh for the entire warning window (see `step()`'s own comment), so the floor always starts exactly
   `FALL_MARGIN` below the peak at the moment it actually begins rising — right at the screen's bottom edge,
   every single wave, by construction.
2. **The wave's speed (100px/s) was deliberately tuned *below* the typical climbing pace (~120px/s)**, on the
   theory that a steadily climbing player should simply outrun it. In practice this meant the gap only ever
   widened for anyone who kept climbing, pushing the wave further behind the camera's bottom edge for the
   whole time it was active — survivable, but also invisible, which defeats the point of a *visible* threat.
   Raised well above the measured climbing pace (see `CHASE_WAVE_BASE_SPEED`'s own comment) so a wave now
   visibly closes the gap even against a player who never stops climbing; the ~6-8s duration cap is what
   keeps this survivable — a wave only needs to be outlasted, not outrun.

A spot-check (driving the bot through an actual wave) now shows the lava on screen for roughly 70% of an
active wave's duration, including moments where it visibly pushes the camera up from right at the bottom
edge — a dramatic, legible "it's catching up" read, not the flat 0% the report described before this fix.

### The summit

Reaching **`SUMMIT_SCORE`** (currently 10000, a plain constant in `tower.ts` chosen to be easy to retune —
see "Calibrating from real play, not bots" below for why this number keeps moving) ends the run as a **win**,
not a fall — a "SUMMIT!" banner on the result screen, a reward sound instead of the usual impact, and the
run's own deterministic climb time (`tick / 60` seconds, exactly reproducible from the run code, never a
wall-clock reading) recorded alongside the score. A summited `RunState` freezes exactly like a fallen one
does (`alive` is `false` either way); `state.summited` is what tells the two apart. This is also why the run
code moved to `FC7` (see Known limits) — reaching the summit is a second, new way a run can end, something
older code formats never had to represent at all.

### Calibrating from real play, not bots

FC6 picked `SUMMIT_SCORE` (3500) and the chase wave constants from a bot calibration: three fixed skill tiers
(`BotSkill`: `"weak" | "medium" | "strong"`, see `botRun`'s own comment) run over 200 towers each, aiming for
"weak survives waves 1-2, medium 3-5, strong summits 1-5% of the time". That calibration run surfaced two real
bugs along the way, both still worth knowing about:

1. **`botRun` was mistracking which platform it had actually landed on**, by a height tolerance far too
   tight for normal tick-quantization (physics resolves once per 1/60s, so a landing is caught a few pixels
   into the platform, never exactly at its surface) — it would get stuck believing it had never reached a
   platform it was already bouncing on every cycle, and so never attempt the next jump. Fixed (see
   `botRun`'s own comment); roughly tripled typical bot scores on its own.
2. **Tower generation's own sideways-drift bound was wrong, independent of the bot or the chase.** Found via
   this same bot failing one specific, reproducible jump at the test fixture's pinned seed (1500) even with
   zero fumble and reacting every tick — not a skill issue, a jump nobody could clear. Generation's `reach`
   formula (`HORIZONTAL_ACCEL * halfAirTime**2 + MAX_HORIZONTAL_SPEED * halfAirTime`) assumed full
   acceleration *and* the full speed cap both applied for the entire half-flight at once, which double-counts
   distance and is physically impossible once the speed cap is actually hit — about 3.9x too generous as a
   result. Fixed with the correct two-phase kinematics (`MAX_HORIZONTAL_REACH`, see its own comment) — this is
   a fairness bug, not a balance one: it could occasionally place a jump no player, however skilled, could
   actually clear, in any tower, independent of hazards.

But then a real human playtest settled the question the bot calibration was trying to answer: the game's own
builder reached **score 3261** on a live run — past the "strong" bot tier's entire ceiling over 200 towers
(~1023 median, ~3500-4700 best-case). That is direct, concrete proof the bot is not a usable stand-in for a
skilled human (it has no lookahead — it aims at one platform at a time with a fixed per-reaction fumble
chance, nothing like how a person actually reads a tower ahead of time). `SUMMIT_SCORE` moved to 10000
specifically to sit with real headroom above that one known real score, not at the edge of it — a deliberate
placeholder, not a rounding exercise, pending more real runs.

**Going forward, balance is calibrated from real play, not bot simulation** — see "Session Stats" below for
the in-game screen built specifically to collect that data (score, height, stars, cause of death, time, for
every run this session, copyable as text). The bot calibration's old table is kept in `tower.test.mjs`'s
"chase wave calibration" test as a cheap regression floor (did a real, pre-existing bug make the bot
mysteriously unable to progress at all — the kind of thing that's easy to miss by eye), not as a claim about
what a human can or should reach.

| tier (bot, not human) | median score | median seconds survived |
| --- | --- | --- |
| weak | 314 | 11.2s |
| medium | 643 | 22.5s |
| strong | 1023 | 37.4s |
| **a real human** | **3261** | — |

### Smoother difficulty

Platform width and gap size both ramp with a `difficulty` value that used to be a plain linear function of
height, maxing out at height 8000 — meaning its *rate of change* dropped to exactly zero in a single tick
right at that point (a visible kink, even though the value itself never jumped), and the whole ramp was
compressed into the first 8000 units of what a real climb (now routinely into the tens of thousands) actually
covers. A playtest reported the narrowing as sudden jumps; both of these are plausible, fixable contributors.
Fixed by switching to `smoothstep` (eases in and out at both ends, so there is no kink at the cap) over a
longer reach, `DIFFICULTY_RAMP_HEIGHT` (16000, up from the implicit 8000) — see its own comment. This changes
`generateTower`'s output for every seed (same as the reach-bound fix above), bundled into the same `FC7` bump.

### Session Stats

A "Stats" screen (reachable from the picker once at least one run has ended, and from every result screen)
lists every run this session — score, height, stars, how it ended (`Fell` / `Lava` / `Drone` / `Summit`) and
climb time — with a "Copy as text" button, specifically so real numbers can be read off or sent elsewhere for
balance calibration (see "Calibrating from real play, not bots" above). `classifyEnd` derives "how it ended"
entirely from values `tower.ts` already exposes — a drone cause only if the hit happened on the exact same
tick the run ended (not a few ticks later from the knockback), a lava cause only if the chase wave was
actually the binding boundary at that tick (stricter than the ordinary `FALL_MARGIN` one) — never a new field
tower.ts itself has to track. Session-only, like every other piece of session state here (`ghosts`, `best`):
it resets on reload, by design, same disclaimer as the rest of the picker screen.

## The camera and the death boundary

The visible world is always exactly `REFERENCE_HEIGHT` (640) world-units tall, regardless of the actual
screen's size or aspect ratio — only the *width* rendered varies with the frame's shape (see the
ResizeObserver in `index.tsx`), so every player sees the same vertical slice of the tower no matter their
device, a fairness requirement for any future tournament.

The camera's vertical reference is the run's own `peakHeight` (tower.ts's monotonic high-water mark), read
directly every frame with no smoothing or lag, and the screen's anchor point is derived from
`FALL_MARGIN` by one fixed formula: `CAMERA_ANCHOR = REFERENCE_HEIGHT - FALL_MARGIN`. Algebraically, this
makes `height == peakHeight - FALL_MARGIN` (the exact death boundary) always map to `REFERENCE_HEIGHT`, the
very bottom row of the canvas — every tick, not approximately. A thin green line and a soft fog mark that
row on screen. `tower.test.mjs` proves this alignment exactly with pure math; `check-browser.mjs` checks the
real renderer never visibly strays far past it before a run actually ends, at both 1100px and 360px.

## Staying clear of the SDK's own toolbar

The SDK's trusted-runtime toolbar ("Local preview", "Friend #...", "Friend wallet") is not part of this game
at all — it's a sibling of the game's sandboxed iframe in the host's own page, absolutely positioned on top
of it. Game code cannot measure or reach it (confirmed directly against `assets/game-frame.css`: no CSS
custom property exposes its size). Measured from that stylesheet instead: its buttons are a fixed
`min-height:36px` at any viewport width, floating `bottom:14px` above the frame's edge normally and
`bottom:6px` at narrow (≤520px) viewports — a ~50px/~42px exclusion band, with a further ~13px of slack
possible if its mode label wraps to a second line under a long enough string. `style.css`'s
`--fc-safe-zone` (80px) is one flat reservation comfortably past either case, used for every screen size
rather than mirroring the SDK's own breakpoint, so a future SDK release moving that breakpoint can't quietly
reopen the gap.

That reservation lives entirely in `.fc-scene`'s own CSS box (`bottom: var(--fc-safe-zone)` instead of
filling the frame edge to edge) — the canvas's ResizeObserver in `index.tsx` only ever reads *that* box's
size, so the camera, `REFERENCE_HEIGHT`, `FALL_MARGIN` and the death-boundary math above all needed zero
changes to respect it; `.fc-game`'s own dark background already shows through the reserved strip, reading as
plain background rather than cut-off gameplay. The control hint ("Arrow keys or A/D...") moved from the
bottom of the screen to just under the HUD, and now only shows for the first few seconds of each run rather
than the whole time. `check-browser.mjs` reads the toolbar's real bounding box directly from the host page
(`.rf-frame-toolbar`) and asserts neither the canvas (and the death-boundary fog drawn at its bottom edge)
nor either hint ever overlaps it, at both 1100px and 360px.

One non-obvious wrinkle found while fixing this: this game's own `@media(max-width:520px)` rules inside the
sandboxed iframe match unconditionally, at *both* test widths — `host.css` caps the frame itself to 480px
wide (`--rf-game-max-width`), so the iframe's own internal viewport is always ≤520px regardless of the outer
browser window's width. A rule meant to apply only "at the bottom, same place as the control hint" need
enough selector specificity to still win against that always-active narrow block, not just correct source
order (see `.fc-hint.fc-star-hint`'s comment in `style.css`).

An earlier version eased the camera toward the peak with an exponential lag, purely for a smoother look. That
lag floated relative to `FALL_MARGIN` depending on climb speed, so a platform that was still clearly visible
on screen could already be past the real death line — the Friend would die landing on something the player
could still see. Removing the lag from the camera's gameplay-critical position (keeping any future easing
strictly to decorative effects, never to `toScreenY`) fixes this at the root instead of papering over it with
a wider margin.

## Towers, physics and determinism

A tower is generated entirely from one 32-bit seed: platform positions, widths, which ones break, where the
stars are, and a few wind bands higher up. Every gap is built to stay within what one bounce can clear and
every sideways jump within what steering can cross in that time — `tower.test.mjs` checks this directly from
the physics constants, so the climb is provably always possible, never a trap.

The physics run on a **fixed 1/60s step**, decoupled from the browser's actual frame rate. The same seed and
the same recorded left/right presses always replay to the exact same score, on any machine, at any frame
rate — `tower.test.mjs` checks this too. That determinism is also what makes two things possible:

- **A run code to share.** After a run, a short text code (`FC7.<rules digit><seed>.<moves>!<score>`) encodes
  the seed, which optional rules (chase/drones/power-ups) were active, and every direction change — not every
  frame, so it stays short for a realistic run. A friend pastes it in and races a ghost of that exact run,
  under its own recorded rules, on the same tower. There is no server: the code is the whole message. The
  version number has moved six times now (v1 → v2 → v3 → v4 → v5 → v6 → v7, see Known limits), each time
  because a change to scoring, survival or generation meant old codes could no longer be replayed to the
  score they claimed; `decodeRun` refuses a v1-v6 code by name instead of guessing.
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
  changes what the same seed and recorded moves replay to, same as the v1 fix did. v3 had no chase, drones or
  power-ups; adding them in v4 (`FC4`) changes survival itself, not just scoring, and also added `RunRules`
  (which of those three were active) as a new thing a code has to carry. v4 had no summit, and a different
  `DRONE_START_HEIGHT`/`DRONE_SPACING` (which shifts the seeded random() sequence for everything generated
  after a tower's first drone, same as v2→v3 silently reshaping towers when spring/power-up fields were
  added) — bumped to `FC5`. v5's chase was an always-on, ever-accelerating floor instead of short waves, and
  had a much higher `SUMMIT_SCORE` (25000) — bumped to `FC6`. v6's chase wave anchored to a stale snapshot and
  rose slower than typical climbing pace (see "Making the chase actually visible" above), used a linear, not
  smoothstep, difficulty ramp (see "Smoother difficulty" above), and `SUMMIT_SCORE` (3500) was calibrated
  against a bot a real human comfortably beat (see "Calibrating from real play, not bots" above) — bumped to
  `FC7`. All six older prefixes are now refused with their own clear message rather than replayed to a
  different score.
- **Moving platforms were considered for the "jumping feels empty" pass and not built.** They would need
  their own reachability proof added to `tower.test.mjs` — a moving platform's catchable window changes the
  gap math everywhere a static platform's doesn't — more scope than the five mechanics built this round. A
  good candidate for a follow-up once those have been played with for a while.
- **Chase/drone/power-up tuning is still a first pass**, same disclaimer as the bot's fumble rate above —
  `SUMMIT_SCORE` is an explicit placeholder with headroom above one known real score (see "Calibrating from
  real play, not bots" above), not a settled number; the Session Stats screen exists specifically to collect
  the real data that should eventually replace it.
- **`MAX_HORIZONTAL_REACH` was a real, pre-existing fairness bug, fixed in FC6 (see "Calibrating from real
  play, not bots" above).** Generation's old sideways-drift bound overestimated true reach by ~3.9x, so some
  towers (any seed, not just ones with hazards) could already contain a jump no player could actually clear.
  Every tower generated before that fix (any run code sharing an old seed-to-layout mapping) laid out
  differently.

## Checks

Run on 2026-10-05 with SDK v0.1.4 and Node.js 22, from the SDK root:

| Command | Result |
| --- | --- |
| `node --test games/friend-climb/tower.test.mjs` | 30 tests: replay, encode/decode (incl. RunRules), run-code version rejection, reachability (platforms and drones), tower safety, camera/death-boundary alignment, springs, combo, chase waves, drones, rocket, shield, magnet, summit, the 200-tower bot skill-tier calibration, the bot, scoring |
| `node scripts/dev-game.mjs check games/friend-climb` (`friendsdk check`) | game definition and build |
| `node scripts/dev-game.mjs test games/friend-climb` (`friendsdk test`) | the SDK's automated browser check with its mock wallet |
| `node games/friend-climb/check-browser.mjs` | this game's own browser check at 1100 px and 360 px |
| `npm run typecheck` | passed |
| `npm run check:games` | passed for `games/friend-climb`; pre-existing, unrelated failure on `games/friend-rooms` (missing `game.json`, a different frozen project) |

## Files

`index.tsx` (the game component), `tower.ts` (deterministic tower generation, physics, the bot, run codes —
framework-free, unit-tested on its own), `tower.test.mjs`, `check-browser.mjs`, `style.css`, `game.json`
(an unused schema-only chance-game definition; this game never calls `buy`, `play`, `settle` or `redeem`,
the same pattern `examples/scrolling-world` uses for a free exploration game), `game/platform.ts` (the three
seams between this game and whatever platform runs it — identity, persistence, randomness — modeled directly
on `penalty-kings`' own `game/platform.ts`, the pattern Rare Friends actually used to fork that game onto SDK
v0.2.0 with real money; see its own file comment for what is and is not an integration point today),
`docs/DESIGN.md` (stages 1–2: shared persistence/leaderboards and the proposed paid daily tournament
tokenomics — a plan, nothing implemented).
