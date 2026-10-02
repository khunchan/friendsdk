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
  assert.throws(() => tower.decodeRun("FC1.5.3L!x!y"), /does not look like/);
  // "LL" is inside the loose outer shape (only 0-9, a-z, L, N, R are allowed) but has no digits before
  // either letter, so the token scanner can match neither — exercises the leftover-character check.
  assert.throws(() => tower.decodeRun("FC1.5.LL!a"), /unreadable characters/);
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

test("score counts height in ten-pixel steps plus 25 per star", () => {
  const state = { ...tower.startRun(), peakHeight: 1234, stars: 3 };
  assert.equal(tower.scoreOf(state), Math.floor(1234 / 10) + 3 * 25);
});
