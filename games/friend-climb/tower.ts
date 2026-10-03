/**
 * Friend Climb's deterministic core: tower generation, the fixed-step physics simulation, and a short text
 * code for sharing a run. Nothing here touches the DOM, canvas or SDK — it is plain data in, data out, so a
 * recorded run always replays to the exact same score, on any machine, at any frame rate.
 */

// --- Physics constants (height increases upward; this module never flips the sign for a screen). ---
export const DT = 1 / 60; // fixed simulation step; the renderer may draw at any frame rate, the sim never does
export const GRAVITY = 1400; // px/s^2 pulling the Friend back down
export const BOUNCE_VELOCITY = 620; // px/s applied upward on every landing; there is no jump button
export const MAX_HORIZONTAL_SPEED = 220; // px/s
export const HORIZONTAL_ACCEL = 900; // px/s^2 while a direction is held
export const HORIZONTAL_DRAG = 700; // px/s^2 slowdown while no direction is held
export const PLAYER_RADIUS = 14;
export const WORLD_WIDTH = 300; // the tower lane; the Friend's x stays within [PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS]
export const FALL_MARGIN = 260; // how far below the highest point reached the camera lets the Friend fall before the run ends
export const HEIGHT_PER_POINT = 10;
export const STAR_POINTS = 25;
/** A rare platform that launches the Friend far higher than a normal landing — strictly a bonus: generation
 * still only ever requires a normal BOUNCE_VELOCITY bounce to clear any gap (see MAX_BOUNCE_RISE below and
 * tower.test.mjs's reachability check), so a spring can never be the only way through, only a shortcut. */
export const SPRING_VELOCITY = BOUNCE_VELOCITY * 1.6;
/** Extra points per star in an unbroken streak (one star landing right after another, no plain landing
 * between), on top of the first star's plain STAR_POINTS; capped so the bonus cannot grow without bound. */
export const COMBO_BONUS_PER_STEP = 10;
export const COMBO_BONUS_MAX_STEPS = 4;
/** The highest a single bounce can carry the Friend; platform gaps must stay safely under this. */
export const MAX_BOUNCE_RISE = BOUNCE_VELOCITY ** 2 / (2 * GRAVITY);
/** Time in the air between two bounces straight up and back down; bounds how far a gap can drift sideways. */
export const BOUNCE_AIR_TIME = (2 * BOUNCE_VELOCITY) / GRAVITY;

export type Dir = -1 | 0 | 1;
export type Random = () => number;

/** Small seeded generator so a tower and a replay are reproducible from one 32-bit number. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed for "the tower of the day", the same for everyone on the same UTC date. */
export function seedForDate(isoDate: string): number {
  let hash = 0x811c9dc5; // FNV-1a
  for (let index = 0; index < isoDate.length; index++) {
    hash ^= isoDate.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type Platform = Readonly<{ x: number; height: number; width: number; breaking: boolean; star: boolean; spring: boolean }>;
export type WindBand = Readonly<{ from: number; to: number; push: number }>;
export type Tower = Readonly<{ seed: number; platforms: readonly Platform[]; windBands: readonly WindBand[] }>;

const GENERATED_HEIGHT = 50_000; // comfortably above any reachable height in a real run; see tower.test.mjs

/**
 * The whole tower, generated once from a seed. Gaps and sideways drift stay within what one bounce can clear
 * (MAX_BOUNCE_RISE, BOUNCE_AIR_TIME), so the climb is always provably possible; tower.test.mjs checks this.
 */
export function generateTower(seed: number): Tower {
  const random = seeded(seed);
  const platforms: Platform[] = [{ x: WORLD_WIDTH / 2, height: 0, width: 90, breaking: false, star: false, spring: false }];
  const windBands: WindBand[] = [];
  let height = 0, sinceWind = 0;
  while (height < GENERATED_HEIGHT) {
    const difficulty = Math.min(1, height / 8000); // 0 at the base, 1 from height 8000 up
    const width = 70 - 36 * difficulty;
    const gap = 60 + (MAX_BOUNCE_RISE * 0.78 - 60) * difficulty * random();
    height += gap;
    const reach = HORIZONTAL_ACCEL * (BOUNCE_AIR_TIME / 2) ** 2 + MAX_HORIZONTAL_SPEED * (BOUNCE_AIR_TIME / 2);
    const previous = platforms[platforms.length - 1].x;
    const drift = (random() * 2 - 1) * reach * 0.82;
    const x = Math.min(WORLD_WIDTH - width / 2, Math.max(width / 2, previous + drift));
    const breaking = height > 600 && random() < 0.1 + 0.1 * difficulty;
    const star = random() < 0.3;
    // Rare, and never on a platform that is about to disappear — a spring is meant to be a repeatable shortcut
    // (for a ghost replaying the same tower too), not a one-time trick tied to a breaking platform's single use.
    const spring = !breaking && random() < 0.05;
    platforms.push({ x, height, width, breaking, star, spring });
    sinceWind += gap;
    if (height > 1500 && sinceWind > 900 + random() * 600) {
      sinceWind = 0;
      const from = height + 200, to = from + 500 + random() * 400;
      const push = (random() < 0.5 ? -1 : 1) * (HORIZONTAL_ACCEL * 0.35) * (0.6 + 0.4 * random());
      windBands.push({ from, to, push });
    }
  }
  return Object.freeze({ seed, platforms: Object.freeze(platforms), windBands: Object.freeze(windBands) });
}

export type RunState = Readonly<{
  tick: number; x: number; height: number; vx: number; vy: number;
  peakHeight: number; stars: number; starPoints: number; comboStreak: number;
  broken: ReadonlySet<number>; starsCollected: ReadonlySet<number>; alive: boolean;
}>;

export function startRun(): RunState {
  return Object.freeze({
    tick: 0, x: WORLD_WIDTH / 2, height: 0, vx: 0, vy: BOUNCE_VELOCITY,
    peakHeight: 0, stars: 0, starPoints: 0, comboStreak: 0,
    broken: new Set<number>(), starsCollected: new Set<number>(), alive: true,
  });
}

function windAt(tower: Tower, height: number): number {
  for (const band of tower.windBands) if (height >= band.from && height <= band.to) return band.push;
  return 0;
}

/** One fixed physics tick. Pure: the same state and dir always produce the same next state. */
export function step(tower: Tower, state: RunState, dir: Dir): RunState {
  if (!state.alive) return state;
  let vx = state.vx + (dir !== 0 ? dir * HORIZONTAL_ACCEL : 0) + windAt(tower, state.height) * DT;
  if (dir === 0) vx = Math.sign(vx) * Math.max(0, Math.abs(vx) - HORIZONTAL_DRAG * DT);
  vx = Math.max(-MAX_HORIZONTAL_SPEED, Math.min(MAX_HORIZONTAL_SPEED, vx));
  // The lane wraps left-right, like the genre's classic screen wrap: walking off one edge reappears on the
  // other at the same speed. A bouncing wall instead pins a held direction against it, which (combined with
  // a reflected random walk also piling up near the edges) let a single held key ride the wall forever.
  const x = ((state.x + vx * DT) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;

  const vy = state.vy - GRAVITY * DT;
  const height = state.height + vy * DT;

  let bounceVy = vy, broken = state.broken, stars = state.stars, starsCollected = state.starsCollected;
  let starPoints = state.starPoints, comboStreak = state.comboStreak;
  if (vy < 0) {
    // Falling: did the Friend's vertical segment this tick cross a live platform under its feet?
    for (let index = 0; index < tower.platforms.length; index++) {
      const platform = tower.platforms[index];
      if (broken.has(index)) continue;
      if (platform.height > state.height || platform.height <= height) continue;
      const sideways = Math.abs(x - platform.x), horizontal = Math.min(sideways, WORLD_WIDTH - sideways);
      if (horizontal > platform.width / 2 + PLAYER_RADIUS) continue;
      bounceVy = platform.spring ? SPRING_VELOCITY : BOUNCE_VELOCITY;
      if (platform.breaking) broken = new Set(broken).add(index);
      // platform.star never changes — it is the same platform's star every time it is bounced on, so a star
      // only pays out the first time this exact platform is landed on (tracked the same way broken is), not
      // once per bounce. Without this a single star platform paid out forever on repeat bounces.
      if (platform.star && !starsCollected.has(index)) {
        // A streak of star landings with no plain landing between them pays an increasing bonus on top of
        // STAR_POINTS, capped at COMBO_BONUS_MAX_STEPS steps; any landing that is not a fresh star (a plain
        // platform, or one whose star is already gone) breaks the streak back to zero.
        comboStreak += 1;
        starPoints += STAR_POINTS + Math.min(comboStreak - 1, COMBO_BONUS_MAX_STEPS) * COMBO_BONUS_PER_STEP;
        stars += 1; starsCollected = new Set(starsCollected).add(index);
      } else {
        comboStreak = 0;
      }
      break; // one platform can be hit per tick; ties are decided by generation order, not render order
    }
  }
  const peakHeight = Math.max(state.peakHeight, height);
  const alive = height >= peakHeight - FALL_MARGIN;
  return Object.freeze({
    tick: state.tick + 1, x, height, vx, vy: bounceVy, peakHeight, stars, starPoints, comboStreak,
    broken, starsCollected, alive,
  });
}

export function scoreOf(state: RunState): number {
  return Math.floor(state.peakHeight / HEIGHT_PER_POINT) + state.starPoints;
}

export type Transition = Readonly<{ tick: number; dir: Dir }>;

/** Turns sparse direction changes into a fast, deterministic per-tick lookup for the simulation loop. */
export function inputReader(transitions: readonly Transition[]): (tick: number) => Dir {
  let index = 0, dir: Dir = 0;
  return tick => {
    while (index < transitions.length && transitions[index].tick <= tick) { dir = transitions[index].dir; index++; }
    return dir;
  };
}

export type RunResult = Readonly<{ ticks: number; state: RunState; score: number }>;

/** Runs a whole climb from a seed and a recorded input track. This is the replay: the only thing that can change
 * the outcome is the seed and the transitions, never the clock the browser happened to render at. */
export function simulate(seed: number, transitions: readonly Transition[], maxTicks = 60 * 180): RunResult {
  const tower = generateTower(seed);
  const input = inputReader(transitions);
  let state = startRun();
  while (state.alive && state.tick < maxTicks) state = step(tower, state, input(state.tick));
  return Object.freeze({ ticks: state.tick, state, score: scoreOf(state) });
}

/**
 * A simple reflex "ghost" bot: always steers toward the x of the next platform above it, with a small dead
 * zone so it does not flap direction right on top of a platform. It is not a trained or optimal player — just
 * enough to give a run an opponent from the very first attempt. Deterministic, like everything else here, so
 * its run can be recorded and shared the same way a human one can; the UI must label it "bot", never a Friend.
 */
/** How often the bot reconsiders its aim; a real player does not correct course every single 1/60s tick either. */
const BOT_REACTION_TICKS = 10;
/** Chance per reconsideration that the bot fumbles and steers the wrong way, rising with height like the
 * platform widths do. Every gap is reachable by design (see tower.test.mjs), so a flawless bot would never
 * fall; this is what makes it a beatable "bot", not an aimbot, and makes its own run eventually end too. */
const BOT_FUMBLE_CHANCE = (difficulty: number) => 0.01 + 0.45 * difficulty;

export function botRun(seed: number, maxTicks = 60 * 180): { transitions: Transition[]; result: RunResult } {
  const tower = generateTower(seed);
  const fumble = seeded(seed ^ 0x9e3779b9); // independent of the tower's own randomness
  let state = startRun(), dir: Dir = 0, lastLanded = 0; // index 0 is the spawn platform, already under the Friend
  const transitions: Transition[] = [];
  while (state.alive && state.tick < maxTicks) {
    if (state.tick % BOT_REACTION_TICKS === 0) {
      // Height briefly passes above a far platform mid-flight on the way to apex, long before actually landing
      // on it, so the target can only ever be "the platform just above the last confirmed landing" — never
      // picked from a bare height comparison, or the bot aims at a platform it cannot possibly reach yet.
      const target = tower.platforms[Math.min(lastLanded + 1, tower.platforms.length - 1)];
      const sideways = target.x - state.x;
      const wrapped = sideways > WORLD_WIDTH / 2 ? sideways - WORLD_WIDTH : sideways < -WORLD_WIDTH / 2 ? sideways + WORLD_WIDTH : sideways;
      let next: Dir = Math.abs(wrapped) < 3 ? 0 : wrapped > 0 ? 1 : -1;
      if (fumble() < BOT_FUMBLE_CHANCE(Math.min(1, state.height / 8000))) next = ([-1, 0, 1] as const)[Math.floor(fumble() * 3)];
      if (next !== dir) { dir = next; transitions.push({ tick: state.tick, dir }); }
    }
    const wasFalling = state.vy < 0;
    state = step(tower, state, dir);
    if (wasFalling && state.vy === BOUNCE_VELOCITY) {
      for (let index = lastLanded + 1; index < tower.platforms.length && tower.platforms[index].height <= state.height + 0.01; index++) lastLanded = index;
    }
  }
  return { transitions, result: Object.freeze({ ticks: state.tick, state, score: scoreOf(state) }) };
}

// --- A short text code for sharing a run: "FC3.<seed base36>.<tokens>!<score base36>". ---
// Each token is "<ticks since the previous change, base36><L|N|R>". Direction letters are uppercase and base36
// digits are lowercase, so a single regex splits tokens unambiguously without a separator between them.
//
// The version number has moved twice, each time because the same seed and transitions started replaying to a
// different score than before: FC1 -> FC2 fixed a star paying out on every repeat bounce instead of once; FC2
// -> FC3 added springs and the star combo bonus, which change scoring outright. Both old prefixes are refused
// by name instead of silently replaying to a number that no longer matches what the code claims.
const TOKEN = /([0-9a-z]+)([LNR])/g;
const LETTER: Record<Dir, "L" | "N" | "R"> = { [-1]: "L", 0: "N", 1: "R" };
const DIR_OF: Record<string, Dir> = { L: -1, N: 0, R: 1 };

export function encodeRun(seed: number, transitions: readonly Transition[], score: number): string {
  let previous = 0;
  const tokens = transitions.map(({ tick, dir }) => {
    const token = `${(tick - previous).toString(36)}${LETTER[dir]}`;
    previous = tick;
    return token;
  });
  return `FC3.${seed.toString(36)}.${tokens.join("")}!${score.toString(36)}`;
}

export type DecodedRun = Readonly<{ seed: number; transitions: readonly Transition[]; claimedScore: number }>;

export function decodeRun(code: string): DecodedRun {
  const trimmed = code.trim();
  if (/^FC1\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (its star scoring had a bug) and can no longer be replayed.");
  }
  if (/^FC2\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (before springs and the star combo bonus) and can no longer be replayed.");
  }
  const match = /^FC3\.([0-9a-z]+)\.([0-9a-zLNR]*)!([0-9a-z]+)$/.exec(trimmed);
  if (!match) throw new Error("That run code does not look like a Friend Climb code.");
  const [, seedPart, tokenPart, scorePart] = match;
  const transitions: Transition[] = [];
  let tick = 0, consumed = 0;
  for (const found of tokenPart.matchAll(TOKEN)) {
    consumed += found[0].length;
    tick += parseInt(found[1], 36);
    transitions.push({ tick, dir: DIR_OF[found[2]] });
  }
  if (consumed !== tokenPart.length) throw new Error("That run code has unreadable characters in it.");
  return Object.freeze({ seed: parseInt(seedPart, 36), transitions: Object.freeze(transitions), claimedScore: parseInt(scorePart, 36) });
}
