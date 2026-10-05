// Run from the SDK root: node --test games/friend-climb/tower.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [new URL("./tower.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const tower = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

/** A seeded, reproducible "player" for tests: presses a direction, holds it a while, switches. */
function scriptedTransitions(seed, count) {
  const random = tower.seeded(seed), transitions = [];
  let tick = 0;
  for (let index = 0; index < count; index++) {
    tick += 20 + Math.floor(random() * 140);
    transitions.push({ tick, dir: [-1, 0, 1][Math.floor(random() * 3)] });
  }
  return transitions;
}

test("the same seed and the same recorded input always replay to the same score", () => {
  for (const seed of [1, 2, 20260101, 999999]) {
    const transitions = scriptedTransitions(seed * 7 + 3, 40);
    const first = tower.simulate(seed, transitions), second = tower.simulate(seed, transitions);
    assert.equal(first.score, second.score, `seed ${seed}: replay produced a different score`);
    assert.equal(first.ticks, second.ticks);
    assert.deepEqual(first.state.broken, second.state.broken);
  }
});

test("encoding and decoding a run recovers the exact transitions and replays to the same score", () => {
  for (const seed of [5, 2026, 123456789]) {
    const transitions = scriptedTransitions(seed, 25);
    const played = tower.simulate(seed, transitions);
    const code = tower.encodeRun(seed, transitions, played.score);
    const decoded = tower.decodeRun(code);
    assert.equal(decoded.seed, seed);
    assert.deepEqual(decoded.transitions, transitions);
    assert.equal(decoded.claimedScore, played.score);
    const replayed = tower.simulate(decoded.seed, decoded.transitions);
    assert.equal(replayed.score, played.score, "the shared code did not replay to the score it claims");
  }
});

test("a run code with no direction changes at all still round-trips", () => {
  const code = tower.encodeRun(42, [], 0);
  assert.deepEqual(tower.decodeRun(code), { seed: 42, transitions: [], claimedScore: 0, rules: tower.DEFAULT_RULES });
});

test("a run code carries which optional mechanics were active, round-tripping exactly", () => {
  for (const rules of [
    { chase: false, drones: false, powerups: false },
    { chase: true, drones: false, powerups: true },
    { chase: false, drones: true, powerups: false },
    tower.DEFAULT_RULES,
  ]) {
    const code = tower.encodeRun(7, [{ tick: 5, dir: 1 }], 100, rules);
    assert.deepEqual(tower.decodeRun(code).rules, rules, `rules did not round-trip for ${JSON.stringify(rules)}`);
  }
});

test("decoding rejects text that is not a Friend Climb code", () => {
  assert.throws(() => tower.decodeRun("not a code"), /does not look like/);
  assert.throws(() => tower.decodeRun("FC5.75.3L!x!y"), /does not look like/);
  // "LL" is inside the loose outer shape (only 0-9, a-z, L, N, R are allowed) but has no digits before
  // either letter, so the token scanner can match neither — exercises the leftover-character check.
  assert.throws(() => tower.decodeRun("FC5.75.LL!a"), /unreadable characters/);
});

test("decoding rejects an old code by name instead of silently replaying it to a different score", () => {
  // v1 (FC1) paid out a star on every bounce off a star platform, not once; v2 (FC2) had no springs or combo
  // bonus; v3 (FC3) had no chase, drones or power-ups; v4 (FC4) had no summit and a different drone layout.
  // None of their claimed scores are reproducible under the current logic, so all four must be refused with
  // their own specific message, not treated as generic garbage or replayed to a wrong number.
  assert.throws(() => tower.decodeRun("FC1.5.3L!a"), /older version/);
  assert.throws(() => tower.decodeRun("FC1.5.3L!a"), error => !/does not look like/.test(error.message));
  assert.throws(() => tower.decodeRun("FC2.5.3L!a"), /older version/);
  assert.throws(() => tower.decodeRun("FC2.5.3L!a"), error => !/does not look like/.test(error.message));
  assert.throws(() => tower.decodeRun("FC3.5.3L!a"), /older version/);
  assert.throws(() => tower.decodeRun("FC3.5.3L!a"), error => !/does not look like/.test(error.message));
  assert.throws(() => tower.decodeRun("FC4.5.3L!a"), /older version/);
  assert.throws(() => tower.decodeRun("FC4.5.3L!a"), error => !/does not look like/.test(error.message));
});

test("a star only pays out once, even when the same platform is bounced on many times", () => {
  // A synthetic one-platform tower (the mandatory spawn platform, with its star flag forced on) instead of
  // generateTower(): with no horizontal input the Friend bounces on this exact platform forever (a known,
  // correct property of zero input — see the "holding one direction" test above), so this directly exercises
  // many repeat bounces off one star platform, which is exactly what the bug paid out on every time.
  const oneStarTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: true, spring: false, powerup: null }]),
  });
  let state = tower.startRun(), bounces = 0;
  for (let tick = 0; tick < 600 && bounces < 8; tick++) {
    const wasFalling = state.vy < 0;
    state = tower.step(oneStarTower, state, 0);
    if (wasFalling && state.vy === tower.BOUNCE_VELOCITY) bounces++;
  }
  assert(bounces >= 8, `expected at least 8 bounces off the one platform within 600 ticks, got ${bounces}`);
  assert.equal(state.stars, 1, `a single star platform must pay out exactly once no matter how many times it is bounced on, got ${state.stars}`);
});

test("every platform gap and sideways drift stays within what one bounce can clear", () => {
  for (const seed of [1, 2, 3, 2026]) {
    const { platforms } = tower.generateTower(seed);
    for (let index = 1; index < platforms.length; index++) {
      const gap = platforms[index].height - platforms[index - 1].height;
      assert(gap > 0 && gap < tower.MAX_BOUNCE_RISE, `seed ${seed}, platform ${index}: gap ${gap} exceeds what a bounce can clear`);
      const drift = Math.abs(platforms[index].x - platforms[index - 1].x);
      const reach = tower.HORIZONTAL_ACCEL * (tower.BOUNCE_AIR_TIME / 2) ** 2 + tower.MAX_HORIZONTAL_SPEED * (tower.BOUNCE_AIR_TIME / 2);
      assert(drift <= reach + 1, `seed ${seed}, platform ${index}: sideways drift ${drift} is further than one bounce can carry`);
    }
  }
});

test("the screen's bottom edge lines up exactly with the FALL_MARGIN death boundary, every tick", () => {
  // Mirrors index.tsx's camera formula exactly: CAMERA_ANCHOR = REFERENCE_HEIGHT - FALL_MARGIN, with the
  // camera's own world-height reference pinned to the run's own peakHeight every frame (no smoothing) — so
  // the two numbers are tied by one fixed formula, not two independently-tuned constants that could drift
  // apart the way they used to (a platform still visible on screen could already be past the death line).
  const CAMERA_ANCHOR = tower.REFERENCE_HEIGHT - tower.FALL_MARGIN;
  const screenY = (height, peakHeight) => CAMERA_ANCHOR - (height - peakHeight);
  // The most a single 1/60s physics tick can carry the Friend past the boundary: falling the entire
  // FALL_MARGIN distance from a dead stop at the peak reaches sqrt(2 * GRAVITY * FALL_MARGIN) px/s, times one
  // tick's duration, plus slack for the peak itself not landing exactly on a tick boundary.
  const maxOvershootPerTick = Math.sqrt(2 * tower.GRAVITY * tower.FALL_MARGIN) * tower.DT + 15;
  // Chase and drones each introduce their own, independent way to die (an absolute rising floor; a hard
  // instantaneous knockdown) that this specific FALL_MARGIN-only formula does not model — index.tsx's own
  // camera formula accounts for the chase separately (see its own comment), and that combination is checked
  // on its own below; this test stays focused on the plain FALL_MARGIN boundary alone, as it always has.
  const rules = { chase: false, drones: false, powerups: true };
  for (let seed = 1; seed <= 30; seed++) {
    const towerData = tower.generateTower(seed);
    const random = tower.seeded(seed * 97 + 11);
    let state = tower.startRun(), dir = 0, diedAt = null;
    for (let tick = 0; tick < 60 * 180 && state.alive; tick++) {
      if (tick % 30 === 0) dir = [-1, 0, 1][Math.floor(random() * 3)];
      // Every alive frame's own height must still map to on-screen or exactly at the edge — the direct
      // statement of "a platform I can see and land on never kills me".
      assert(screenY(state.height, state.peakHeight) <= tower.REFERENCE_HEIGHT + 1e-6,
        `seed ${seed}, tick ${tick}: an alive frame is already below the visible bottom edge`);
      const previous = state;
      state = tower.step(towerData, state, dir, rules);
      if (!state.alive) diedAt = { before: previous, after: state };
    }
    assert(diedAt, `seed ${seed}: never died within the tick limit — this scenario did not exercise death`);
    const overshoot = screenY(diedAt.after.height, diedAt.after.peakHeight) - tower.REFERENCE_HEIGHT;
    assert(overshoot > 0, `seed ${seed}: the tick that ends the run is not actually below the bottom edge`);
    assert(overshoot < maxOvershootPerTick,
      `seed ${seed}: death landed ${overshoot.toFixed(1)}px past the bottom edge, further than one tick of falling can explain`);
  }
});

test("different seeds generate different towers", () => {
  const a = tower.generateTower(1), b = tower.generateTower(2);
  assert.notDeepEqual(a.platforms.slice(0, 10), b.platforms.slice(0, 10));
});

test("the tower of the day is the same seed all day and usually differs from other days", () => {
  assert.equal(tower.seedForDate("2026-10-02"), tower.seedForDate("2026-10-02"));
  assert.notEqual(tower.seedForDate("2026-10-02"), tower.seedForDate("2026-10-03"));
});

test("holding one direction the whole run still falls off before the tick limit, every time", () => {
  // Zero input is excluded on purpose: starting centered right above the spawn platform with no horizontal
  // push ever applied, the Friend bounces on that same platform forever. That is a correct, harmless corner
  // case (real players always move eventually, and simulate()'s tick limit bounds it either way) — it is not
  // what this test is checking. What matters here is that steering never gives an exploitable infinite ride.
  for (let seed = 1; seed <= 200; seed++) {
    for (const dir of [-1, 1]) {
      const result = tower.simulate(seed, [{ tick: 0, dir }], 60 * 180);
      assert(result.ticks < 60 * 180, `seed ${seed}, dir ${dir}: holding one direction never fell off the tower`);
      assert.equal(result.state.alive, false);
    }
  }
});

test("a run never collects more stars than exist among the platforms it actually reached", () => {
  for (const seed of [1, 2, 3, 9, 1500]) {
    const towerData = tower.generateTower(seed);
    const { result } = tower.botRun(seed);
    const starsAvailable = towerData.platforms.filter(platform => platform.star && platform.height <= result.state.peakHeight).length;
    assert(result.state.stars <= starsAvailable,
      `seed ${seed}: collected ${result.state.stars} stars but only ${starsAvailable} star platforms are at or below the peak height reached`);
  }
});

test("the ghost bot is deterministic and does not meet the exact same fate on every seed", () => {
  // With the chase on (the default rules), surviving all the way to the tick cap is no longer a meaningful
  // "win" to check for — the chase is specifically designed so nobody can stall indefinitely, bot included,
  // so it is expected to eventually fall on essentially every seed now. What still matters, and is still
  // worth proving, is that the bot is not a scripted, identical failure every time: some seeds genuinely give
  // it a much harder or easier time than others, which is what makes it a credible opponent rather than a
  // fixed timer dressed up as one.
  const ticksSurvived = [];
  for (let seed = 1; seed <= 100; seed++) {
    const a = tower.botRun(seed), b = tower.botRun(seed);
    assert.equal(a.result.score, b.result.score, `seed ${seed}: the bot's own run is not reproducible`);
    assert.deepEqual(a.transitions, b.transitions);
    ticksSurvived.push(a.result.ticks);
  }
  const min = Math.min(...ticksSurvived), max = Math.max(...ticksSurvived);
  assert(min < max * 0.5,
    `expected meaningfully different outcomes across seeds (shortest ${min} ticks, longest ${max} ticks) — not a fixed, scripted fate`);
});

test("score counts height in ten-pixel steps plus star points earned", () => {
  const state = { ...tower.startRun(), peakHeight: 1234, starPoints: 75 };
  assert.equal(tower.scoreOf(state), Math.floor(1234 / 10) + 75);
});

test("a spring platform launches the Friend higher than a normal bounce", () => {
  // Same synthetic one-platform setup as the star test above, but with spring instead of star: with no
  // horizontal input the Friend keeps bouncing on this exact platform, so its peak height after one bounce
  // is a direct, uncontaminated reading of that platform's launch velocity.
  const springTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: false, spring: true, powerup: null }]),
  });
  // startRun() begins already mid-air at normal BOUNCE_VELOCITY (as if just off the spawn platform), so the
  // first landing on the spring only happens after that first ordinary arc finishes; run long enough to cover
  // that first arc (BOUNCE_AIR_TIME) plus the full rise of the spring-powered arc that follows it.
  let state = tower.startRun();
  const ticksNeeded = Math.ceil((tower.BOUNCE_AIR_TIME + tower.SPRING_VELOCITY / tower.GRAVITY) / tower.DT) + 5;
  for (let tick = 0; tick < ticksNeeded; tick++) state = tower.step(springTower, state, 0);
  // A normal bounce's peak rise is bounded by MAX_BOUNCE_RISE (see the reachability test above); a spring
  // launch must clear that bound, since it is defined as strictly faster than the normal bounce velocity.
  assert(state.peakHeight > tower.MAX_BOUNCE_RISE, `expected a spring launch to rise above ${tower.MAX_BOUNCE_RISE}, got ${state.peakHeight}`);
});

test("consecutive star landings earn a growing combo bonus, which a plain landing resets", () => {
  // Five platforms in a row, each one bounce-rise apart (comfortably under MAX_BOUNCE_RISE, so every bounce
  // lands on exactly the next platform and never skips or doubles up): three star platforms back to back,
  // then one plain platform, then one more star platform. This scripts an exact, deterministic sequence of
  // landings to check the combo formula step by step.
  const platforms = [
    { x: 150, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: null },
    { x: 150, height: 100, width: 90, breaking: false, star: true, spring: false, powerup: null },
    { x: 150, height: 200, width: 90, breaking: false, star: true, spring: false, powerup: null },
    { x: 150, height: 300, width: 90, breaking: false, star: true, spring: false, powerup: null },
    { x: 150, height: 400, width: 90, breaking: false, star: false, spring: false, powerup: null },
    { x: 150, height: 500, width: 90, breaking: false, star: true, spring: false, powerup: null },
  ];
  const scriptedTower = Object.freeze({ seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]), platforms: Object.freeze(platforms) });
  let state = tower.startRun();
  const comboStreaksAtEachStarLanding = [];
  let previousStars = state.stars;
  for (let tick = 0; tick < 2000 && comboStreaksAtEachStarLanding.length < 4; tick++) {
    state = tower.step(scriptedTower, state, 0);
    if (state.stars > previousStars) { comboStreaksAtEachStarLanding.push(state.comboStreak); previousStars = state.stars; }
  }
  assert.deepEqual(comboStreaksAtEachStarLanding, [1, 2, 3, 1], "combo streak must climb across consecutive stars and reset after a plain landing");
  const bonusForStreak = streak => tower.STAR_POINTS + Math.min(streak - 1, tower.COMBO_BONUS_MAX_STEPS) * tower.COMBO_BONUS_PER_STEP;
  const expectedStarPoints = [1, 2, 3, 1].reduce((total, streak) => total + bonusForStreak(streak), 0);
  assert.equal(state.starPoints, expectedStarPoints, "total star points must match the combo bonus formula applied at each landing");
});

test("the chase eventually kills a Friend who stays at a safe, unmoving height, when enabled", () => {
  const oneTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: null }]),
  });
  const rules = { chase: true, drones: false, powerups: false };
  let state = tower.startRun();
  // Comfortably inside the grace period, chaseHeight is still exactly 0, so ordinary safe bouncing on the
  // same platform forever (which revisits height 0 on every landing) must not be touched by it at all yet.
  for (let tick = 0; tick < tower.CHASE_GRACE_TICKS - 60 && state.alive; tick++) state = tower.step(oneTower, state, 0, rules);
  assert(state.alive, "the chase must not have caught up at all yet, comfortably inside its own grace period");
  for (let tick = 0; tick < 60 * 90 && state.alive; tick++) state = tower.step(oneTower, state, 0, rules);
  assert.equal(state.alive, false, "a Friend bouncing on the exact same platform forever must eventually be caught by the rising chase");
});

test("the chase never fires at all when disabled, even far past when it would otherwise have caught up", () => {
  const oneTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: null }]),
  });
  const rules = { chase: false, drones: false, powerups: false };
  let state = tower.startRun();
  for (let tick = 0; tick < 60 * 90; tick++) state = tower.step(oneTower, state, 0, rules);
  assert.equal(state.alive, true, "with the chase off, bouncing in place forever must stay exactly as safe as it always was");
});

test("a drone never blocks the whole lane — a gap always exists regardless of seed or oscillation phase", () => {
  // Purely geometric and seed-independent: a drone's own width (2*DRONE_RADIUS) plus the Friend's own
  // diameter (2*PLAYER_RADIUS) must stay well under the full wrapped lane width, so some horizontal gap
  // always exists no matter where in its oscillation the drone currently is or what seed generated it.
  const blockedWidth = 2 * (tower.DRONE_RADIUS + tower.PLAYER_RADIUS);
  assert(blockedWidth < tower.WORLD_WIDTH, `a drone+Friend together (${blockedWidth}) must stay under the lane width (${tower.WORLD_WIDTH})`);
  let sawADrone = false;
  for (const seed of [1, 2, 3, 2026]) {
    const { drones } = tower.generateTower(seed);
    if (drones.length > 0) sawADrone = true;
    for (const drone of drones) assert(drone.height > tower.DRONE_START_HEIGHT, `seed ${seed}: a drone exists below the documented grace zone`);
  }
  assert(sawADrone, "expected at least one of the checked seeds to generate a drone");
});

test("a drone hit knocks the Friend down hard and starts a cooldown, not a repeat hit on every overlapping tick", () => {
  const droneTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: null }]),
    // Stationary (amplitude 0) right in the Friend's own unmoving path, at a height its bounce comfortably
    // reaches — so a hit is not a matter of luck, and the test's own count of "how many times the bounce
    // crossed this height" is simple to reason about.
    drones: Object.freeze([{ height: 80, x0: 150, amplitude: 0, periodTicks: 100, phase: 0 }]),
  });
  const rules = { chase: false, drones: true, powerups: false };
  let state = tower.startRun(), hits = 0, crossings = 0, wasAbove = state.height >= 80;
  for (let tick = 0; tick < 400; tick++) {
    const previousCooldown = state.droneCooldown;
    const isAbove = state.height >= 80;
    if (isAbove !== wasAbove) { crossings++; wasAbove = isAbove; }
    state = tower.step(droneTower, state, 0, rules);
    if (previousCooldown === 0 && state.droneCooldown === tower.DRONE_HIT_COOLDOWN_TICKS) hits++;
  }
  assert(crossings >= 4, `expected the bounce to cross height 80 several times in 400 ticks, got ${crossings}`);
  assert(hits >= 1, "expected at least one drone hit in 400 ticks of crossing right through it");
  assert(hits < crossings, `the cooldown must suppress at least some repeat hits (got ${hits} hits across ${crossings} crossings)`);
});

test("a rocket power-up launches far higher than even a spring, for its own fixed duration", () => {
  const rocketTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: "rocket" }]),
  });
  const rules = { chase: false, drones: false, powerups: true };
  let state = tower.startRun();
  // One ordinary arc to actually land on the platform and trigger the rocket, plus comfortably more than its
  // own fixed duration for the climb itself.
  const ticksNeeded = Math.ceil(tower.BOUNCE_AIR_TIME / tower.DT) + tower.ROCKET_DURATION_TICKS + 30;
  for (let tick = 0; tick < ticksNeeded; tick++) state = tower.step(rocketTower, state, 0, rules);
  const springLikeBound = tower.SPRING_VELOCITY ** 2 / (2 * tower.GRAVITY); // the highest even a spring could reach
  assert(state.peakHeight > springLikeBound, `expected a rocket to climb past a spring's own bound (${springLikeBound.toFixed(0)}), got ${state.peakHeight.toFixed(0)}`);
});

test("a shield cancels exactly one otherwise-fatal fall, then is gone", () => {
  const emptyTower = Object.freeze({ seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]), platforms: Object.freeze([]) });
  const rules = { chase: false, drones: false, powerups: true };
  // Crafted one tick away from crossing peakHeight - FALL_MARGIN, with a shield already held — exercises the
  // save in isolation rather than hoping a scripted bounce sequence happens to land on the exact fatal tick.
  let state = { ...tower.startRun(), peakHeight: 1000, height: 1000 - tower.FALL_MARGIN + 1, vy: -50, shield: true };
  state = tower.step(emptyTower, state, 0, rules);
  assert.equal(state.alive, true, "the shield must cancel the first otherwise-fatal fall");
  assert.equal(state.shield, false, "the shield must be consumed after saving the run once");
  let dead = false;
  for (let tick = 0; tick < 200 && !dead; tick++) { state = tower.step(emptyTower, state, 0, rules); if (!state.alive) dead = true; }
  assert(dead, "without a shield left, falling through open air with nothing to land on must actually end the run");
});

test("a magnet collects a star the Friend's own path never actually lands on", () => {
  // The Friend's x never moves at all with zero input (no drift, see "holding one direction" above for why
  // that is itself fine), so a platform offset sideways is permanently out of landing range but can still be
  // within magnet range — isolates the magnet's own effect instead of needing to script a precise path to it.
  const platforms = [
    { x: 150, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: "magnet" },
    { x: 200, height: 80, width: 10, breaking: false, star: true, spring: false, powerup: null }, // 50px away: unreachable by landing (needs <=19px), reachable by magnet (<=70px)
  ];
  const magnetTower = Object.freeze({ seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]), platforms: Object.freeze(platforms) });
  let withMagnet = tower.startRun(), withoutMagnet = tower.startRun();
  const withRules = { chase: false, drones: false, powerups: true }, withoutRules = { chase: false, drones: false, powerups: false };
  for (let tick = 0; tick < 150; tick++) {
    withMagnet = tower.step(magnetTower, withMagnet, 0, withRules);
    withoutMagnet = tower.step(magnetTower, withoutMagnet, 0, withoutRules);
  }
  assert.equal(withoutMagnet.stars, 0, "the star is offset far enough that a normal landing must never reach it");
  assert(withMagnet.stars >= 1, "a magnet must auto-collect the same star without ever landing on it");
});

test("reaching SUMMIT_SCORE ends the run as a win, not a fall, and freezes state there", () => {
  // Crafted right at the edge of the summit score, same style as the shield test above: isolates the
  // transition itself instead of needing a multi-minute scripted climb to actually reach 25000.
  const emptyTower = Object.freeze({ seed: 0, windBands: Object.freeze([]), drones: Object.freeze([]), platforms: Object.freeze([]) });
  const rules = { chase: false, drones: false, powerups: false };
  // A large vy so a single physics tick's rise (dt * vy) is comfortably more than one HEIGHT_PER_POINT step —
  // floor(height / HEIGHT_PER_POINT) only ever changes by whole steps, so a small vy could land mid-step and
  // never actually cross from 24999 to 25000 in one tick.
  const justBelow = (tower.SUMMIT_SCORE - 1) * tower.HEIGHT_PER_POINT + 5;
  let state = { ...tower.startRun(), peakHeight: justBelow, height: justBelow, vy: 1000 };
  state = tower.step(emptyTower, state, 0, rules);
  assert.equal(state.summited, true, "crossing SUMMIT_SCORE must set summited");
  assert.equal(state.alive, false, "a summited run is over, same as alive would be false on a fall");
  const summitedState = state;
  state = tower.step(emptyTower, state, 0, rules);
  assert.deepEqual(state, summitedState, "step() on an already-summited (not alive) state must be a no-op, same as on a fallen one");
});

test("a run that never reaches SUMMIT_SCORE ends as a fall, not a win", () => {
  for (const seed of [1, 2, 3]) {
    const { result } = tower.botRun(seed);
    assert.equal(result.state.summited, false, `seed ${seed}: the bot should not be reaching the summit at this score (${result.score})`);
  }
});
