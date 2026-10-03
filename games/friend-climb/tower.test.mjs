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
  assert.deepEqual(tower.decodeRun(code), { seed: 42, transitions: [], claimedScore: 0 });
});

test("decoding rejects text that is not a Friend Climb code", () => {
  assert.throws(() => tower.decodeRun("not a code"), /does not look like/);
  assert.throws(() => tower.decodeRun("FC3.5.3L!x!y"), /does not look like/);
  // "LL" is inside the loose outer shape (only 0-9, a-z, L, N, R are allowed) but has no digits before
  // either letter, so the token scanner can match neither — exercises the leftover-character check.
  assert.throws(() => tower.decodeRun("FC3.5.LL!a"), /unreadable characters/);
});

test("decoding rejects an old code by name instead of silently replaying it to a different score", () => {
  // v1 (FC1) paid out a star on every bounce off a star platform, not once, and v2 (FC2) had no springs or
  // combo bonus; neither version's claimed scores are reproducible under the current logic, so both must be
  // refused with their own specific message, not treated as generic garbage or replayed to a wrong number.
  assert.throws(() => tower.decodeRun("FC1.5.3L!a"), /older version/);
  assert.throws(() => tower.decodeRun("FC1.5.3L!a"), error => !/does not look like/.test(error.message));
  assert.throws(() => tower.decodeRun("FC2.5.3L!a"), /older version/);
  assert.throws(() => tower.decodeRun("FC2.5.3L!a"), error => !/does not look like/.test(error.message));
});

test("a star only pays out once, even when the same platform is bounced on many times", () => {
  // A synthetic one-platform tower (the mandatory spawn platform, with its star flag forced on) instead of
  // generateTower(): with no horizontal input the Friend bounces on this exact platform forever (a known,
  // correct property of zero input — see the "holding one direction" test above), so this directly exercises
  // many repeat bounces off one star platform, which is exactly what the bug paid out on every time.
  const oneStarTower = Object.freeze({
    seed: 0, windBands: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: true, spring: false }]),
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
      state = tower.step(towerData, state, dir);
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

test("the ghost bot is deterministic and is always beatable, never a guaranteed win or a guaranteed loss", () => {
  let wins = 0, losses = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const a = tower.botRun(seed), b = tower.botRun(seed);
    assert.equal(a.result.score, b.result.score, `seed ${seed}: the bot's own run is not reproducible`);
    assert.deepEqual(a.transitions, b.transitions);
    if (a.result.ticks < 60 * 180) losses++; else wins++;
  }
  assert(losses > 0, "the bot never falls off in 100 seeds — it would be an unbeatable opponent");
  assert(wins > 0, "the bot always falls off in 100 seeds — matches would never have a lasting opponent");
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
    seed: 0, windBands: Object.freeze([]),
    platforms: Object.freeze([{ x: 150, height: 0, width: 90, breaking: false, star: false, spring: true }]),
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
    { x: 150, height: 0, width: 90, breaking: false, star: false, spring: false },
    { x: 150, height: 100, width: 90, breaking: false, star: true, spring: false },
    { x: 150, height: 200, width: 90, breaking: false, star: true, spring: false },
    { x: 150, height: 300, width: 90, breaking: false, star: true, spring: false },
    { x: 150, height: 400, width: 90, breaking: false, star: false, spring: false },
    { x: 150, height: 500, width: 90, breaking: false, star: true, spring: false },
  ];
  const scriptedTower = Object.freeze({ seed: 0, windBands: Object.freeze([]), platforms: Object.freeze(platforms) });
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
