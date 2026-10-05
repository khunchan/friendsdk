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
export const FALL_MARGIN = 260; // how far below the highest point reached the Friend may fall before the run ends
/** How many world-units tall the renderer's viewport is, fixed regardless of the actual screen's aspect ratio
 * or pixel size — every player sees the same slice of the tower no matter their device, a fairness
 * requirement for any future tournament (see index.tsx's ResizeObserver, which only ever varies the *width*
 * it renders, never this). The renderer derives its camera anchor from this and FALL_MARGIN together
 * (CAMERA_ANCHOR = REFERENCE_HEIGHT - FALL_MARGIN) so the screen's bottom edge and the death boundary above
 * are tied by one fixed formula instead of two independently-tuned constants that could drift apart —
 * tower.test.mjs checks that they line up exactly, every tick, not just approximately. */
export const REFERENCE_HEIGHT = 640;
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
/** How far steering can actually carry the Friend sideways during one bounce's half-flight (rise-to-apex;
 * the same distance applies falling back down), starting from a dead stop: accelerate at HORIZONTAL_ACCEL
 * until MAX_HORIZONTAL_SPEED is hit, then travel at that capped speed for whatever time is left. This is the
 * bound tower generation actually has to respect for a gap to be clearable by every player, not just a fast
 * one — found via a bot that kept failing one specific, reproducible jump at seed 1500 (see
 * check-browser.mjs) even with zero fumble and reacting every single tick, which traced back to generation's
 * PREVIOUS reach formula (`HORIZONTAL_ACCEL * halfAirTime**2 + MAX_HORIZONTAL_SPEED * halfAirTime`) silently
 * assuming full acceleration AND full capped speed applied for the *entire* half-flight simultaneously —
 * physically impossible (once capped, further acceleration time doesn't add distance on top of the capped
 * term too) and roughly 3.9x too generous as a result, occasionally producing a sideways drift that no player,
 * however skilled, could actually cover in time. */
const TIME_TO_MAX_HORIZONTAL_SPEED = MAX_HORIZONTAL_SPEED / HORIZONTAL_ACCEL;
export const MAX_HORIZONTAL_REACH = TIME_TO_MAX_HORIZONTAL_SPEED >= BOUNCE_AIR_TIME / 2
  ? 0.5 * HORIZONTAL_ACCEL * (BOUNCE_AIR_TIME / 2) ** 2 // never actually reaches max speed within the half-flight
  : 0.5 * HORIZONTAL_ACCEL * TIME_TO_MAX_HORIZONTAL_SPEED ** 2
    + MAX_HORIZONTAL_SPEED * (BOUNCE_AIR_TIME / 2 - TIME_TO_MAX_HORIZONTAL_SPEED);

// --- Chase: short, recurring lava WAVES, not a permanent rising floor. Outside a wave the only death
// boundary is the ordinary FALL_MARGIN one below; a wave is a temporary, bounded threat that rises from the
// ordinary boundary and then recedes back below it. This replaced an earlier always-on accelerating chase
// (FC5 and before) that a playtest showed killed a weak player on the very first wave and never let up —
// punishing a moment of stalling was the goal, not a race nobody but a very strong player could ever win.
// A wave is triggered purely by score, the same milestone the HUD banner already announces (every
// CHASE_WAVE_SCORE_STEP points), so the two are always exactly in sync by construction, not by coincidence of
// similar tuning numbers.
export const CHASE_WAVE_SCORE_STEP = 1000;
// ~1.5s between the milestone being crossed and the floor actually starting to rise — long enough for the
// warning banner/sound (index.tsx) to read as a genuine heads-up, not a surprise.
export const CHASE_WAVE_WARNING_TICKS = 90;
// ~6-8s per wave, each later one a little longer, capped so waves never grow unboundedly long.
export const CHASE_WAVE_BASE_DURATION_TICKS = 420; // ~7s: wave 1's rise-then-retreat length
export const CHASE_WAVE_DURATION_GROWTH_TICKS = 12; // each later wave runs a little longer
export const CHASE_WAVE_DURATION_CAP_TICKS = 480; // ~8s hard cap, so waves never grow unboundedly long
// A first pass (100px/s, "a little under" the measured ~119-126px/s climbing rate) made a steadily-climbing
// player simply outpace the wave for its whole duration — which also means the wave's own floor falls
// further and further BEHIND the camera's bottom edge the whole time, so it was reported as basically never
// visible at all, not just rarely dangerous (see README.md's "Chase wave calibration" for the measurement and
// index.tsx's cameraReference comment for why the math works out that way). Raised well above the measured
// climbing rate so a wave visibly closes the gap for a steadily-climbing player too, not only a stalled one —
// the ~6-8s cap (above) is what makes this survivable: the wave only needs to be outlasted, not outrun.
export const CHASE_WAVE_BASE_SPEED = 180; // px/s wave 1 rises at
export const CHASE_WAVE_SPEED_GROWTH = 15; // px/s added per later wave
export const CHASE_WAVE_SPEED_CAP = 260; // px/s hard cap

/** How long wave number `waveIndex` (1 = the first wave, at score CHASE_WAVE_SCORE_STEP) lasts, in ticks,
 * before it recedes back below the ordinary FALL_MARGIN boundary. Pure, so both step() and the renderer
 * (for drawing the lava and deriving music urgency) always agree. */
export function chaseWaveDuration(waveIndex: number): number {
  return Math.min(CHASE_WAVE_DURATION_CAP_TICKS, CHASE_WAVE_BASE_DURATION_TICKS + CHASE_WAVE_DURATION_GROWTH_TICKS * (waveIndex - 1));
}
/** How fast wave number `waveIndex` rises, in px/s, once its warning window has elapsed. */
export function chaseWaveSpeed(waveIndex: number): number {
  return Math.min(CHASE_WAVE_SPEED_CAP, CHASE_WAVE_BASE_SPEED + CHASE_WAVE_SPEED_GROWTH * (waveIndex - 1));
}

/** Pure description of the chase wave in effect (if any) right now, for a run whose most recent score
 * milestone (`waveIndex`, 0 if none yet) was crossed at `triggerTick`, evaluated at the given `tick`.
 * `baseHeight` is the peak height the floor actually starts rising from — step() keeps this fresh for the
 * whole warning window (see its own comment), so it reflects the peak right as the floor starts moving, not
 * wherever it was back when the milestone first fired. `warning` is the ~1.5s heads-up window before the
 * floor moves at all; `active` is the floor-rising window itself; `floor` is -Infinity whenever neither
 * applies (no threat beyond the ordinary FALL_MARGIN boundary), exactly like the old chaseHeight's grace
 * period did. Both step() (for the actual death floor) and index.tsx (for the warning banner/sound, the lava
 * render and music urgency) read this one function, so they can never disagree about when a wave is
 * happening. */
export function chaseWaveFloor(
  waveIndex: number, triggerTick: number, baseHeight: number, tick: number,
): Readonly<{ warning: boolean; active: boolean; floor: number }> {
  if (waveIndex === 0) return { warning: false, active: false, floor: -Infinity };
  const elapsed = tick - triggerTick;
  if (elapsed < 0) return { warning: false, active: false, floor: -Infinity };
  if (elapsed < CHASE_WAVE_WARNING_TICKS) return { warning: true, active: false, floor: -Infinity };
  const waveTick = elapsed - CHASE_WAVE_WARNING_TICKS;
  const duration = chaseWaveDuration(waveIndex);
  if (waveTick > duration) return { warning: false, active: false, floor: -Infinity };
  const floor = baseHeight - FALL_MARGIN + chaseWaveSpeed(waveIndex) * (waveTick * DT);
  return { warning: false, active: true, floor };
}

/** A 0..1 "how tense should this feel right now" reading, purely for presentation (music tempo/volume in
 * index.tsx) — 0 outside any wave, a flat partial value through the warning window, ramping up to 1 within
 * the wave's first second once the floor is actually rising. Never read by step() itself; kept here rather
 * than duplicated in index.tsx so it can never drift out of sync with the wave timing chaseWaveFloor itself
 * describes. */
export function chaseWaveUrgency(waveIndex: number, triggerTick: number, tick: number): number {
  if (waveIndex === 0) return 0;
  const elapsed = tick - triggerTick;
  if (elapsed < 0) return 0;
  if (elapsed < CHASE_WAVE_WARNING_TICKS) return 0.4;
  const waveTick = elapsed - CHASE_WAVE_WARNING_TICKS;
  if (waveTick > chaseWaveDuration(waveIndex)) return 0;
  return Math.min(1, 0.4 + waveTick / 60);
}

// --- Drones: a thin horizontal band at a fixed height that a small patrolling hazard sweeps back and forth
// across. Its own width is kept well under WORLD_WIDTH on purpose (see DRONE_RADIUS below) so a gap at least
// WORLD_WIDTH - 2*(DRONE_RADIUS+PLAYER_RADIUS) wide always exists on the wrapped lane, at every tick, for
// every drone, regardless of seed or oscillation phase — tower.test.mjs checks this algebraically, not by
// simulating paths. ---
export const DRONE_RADIUS = 18;
// Measured, not guessed: driving the game's own bot (a fully scripted, reasonably competent player) through
// the real build repeatedly showed death around height 130-310 under the chase's default pace — a first pass
// at DRONE_START_HEIGHT=700 meant drones essentially never appeared in an actual run, independent of how
// skilled the player was. Lowered to a height most runs genuinely reach, a data-driven balance fix, not a
// per-player difficulty slider.
export const DRONE_START_HEIGHT = 220;
export const DRONE_SPACING = 300; // roughly one drone every this many height units past DRONE_START_HEIGHT
export const DRONE_HIT_COOLDOWN_TICKS = 90; // ~1.5s of invulnerability after a hit, so one overlap is one hit
export type Drone = Readonly<{ height: number; x0: number; amplitude: number; periodTicks: number; phase: number }>;
/** A drone's horizontal position at a given tick — pure, like chaseHeight, so both renderer and tests agree. */
export function droneX(drone: Drone, tick: number): number {
  const raw = drone.x0 + drone.amplitude * Math.sin((2 * Math.PI * tick) / drone.periodTicks + drone.phase);
  return ((raw % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
}

// --- Power-ups: rare pickups placed on specific platforms at generation time, like stars and springs. ---
export type PowerupKind = "rocket" | "shield" | "magnet";
export const ROCKET_SPEED = 900; // px/s straight up while active — faster and steadier than any ordinary bounce
export const ROCKET_DURATION_TICKS = 150; // 2.5s
export const MAGNET_DURATION_TICKS = 300; // 5s
export const MAGNET_RADIUS = 70; // world-units a star can be auto-collected from without actually landing on it

/** The score that ends a run as a win ("SUMMIT!") instead of a fall. A plain constant on purpose, not derived
 * from anything else, so it is trivial to retune once there has been real playtesting to judge how long that
 * actually takes at a realistic pace.
 *
 * The bot-skill-tier calibration this was previously set from (3500, see tower.test.mjs's "chase wave
 * calibration" test and README.md's table) turned out to badly underestimate a real human: the game's own
 * builder reached 3261 on a live run (score), well past what even the calibration bot's "strong" tier could
 * reach over 200 towers — direct, concrete proof that the bot is not a stand-in for a skilled human (it has
 * no lookahead; see botRun's own comment) and that balance has to come from real play, not bot data, from
 * here on. Raised to 10000 as an explicit placeholder with real headroom above a single real player's current
 * best, specifically so it does not sit right at the edge of what is already known to be reachable — not a
 * final answer, just enough room to keep collecting real climb data (see index.tsx's session Stats screen)
 * before settling on a real number. Still just a constant, still due for another pass (see docs/DESIGN.md's
 * open questions). */
export const SUMMIT_SCORE = 10_000;

/** Which of the optional hazards/mechanics below are active for a given run. Purely a matter of which rules
 * were in force — never randomness, never anything that could differ between two replays of the same code —
 * so a RunRules value is encoded directly into the run code (see encodeRun/decodeRun) and a ghost always
 * replays under the exact rules it was recorded with, never whatever the live player currently has toggled
 * in Settings. */
export type RunRules = Readonly<{ chase: boolean; drones: boolean; powerups: boolean }>;
export const DEFAULT_RULES: RunRules = Object.freeze({ chase: true, drones: true, powerups: true });

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

export type Platform = Readonly<{ x: number; height: number; width: number; breaking: boolean; star: boolean; spring: boolean; powerup: PowerupKind | null }>;
export type WindBand = Readonly<{ from: number; to: number; push: number }>;
export type Tower = Readonly<{ seed: number; platforms: readonly Platform[]; windBands: readonly WindBand[]; drones: readonly Drone[] }>;

const GENERATED_HEIGHT = 50_000; // comfortably above any reachable height in a real run; see tower.test.mjs
// How far the difficulty ramp (platform width, gap size) stretches before it maxes out. Raised from an
// implicit 8000 (and switched from a linear ramp to smoothstep below) after a playtest found the narrowing
// felt like sudden jumps — a real human now routinely climbs well past where the old ramp finished, so
// cramming the whole difficulty increase into the first 8000 units made that early stretch feel steep, and a
// plain linear ramp has a visible kink exactly where it hits its cap (the rate of change drops to zero in a
// single tick, rather than easing out). smoothstep removes that kink at both ends; the longer reach spreads
// the increase out over more of a real climb.
const DIFFICULTY_RAMP_HEIGHT = 16_000;
/** Eases in and out (zero slope at both t=0 and t=1) instead of linear's constant rate the whole way — the
 * only thing this changes is the shape of the ramp between "easiest" and "hardest", never the endpoints
 * themselves (difficulty(0) is still exactly 0, difficulty(DIFFICULTY_RAMP_HEIGHT) is still exactly 1). */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * The whole tower, generated once from a seed. Gaps and sideways drift stay within what one bounce can clear
 * (MAX_BOUNCE_RISE, MAX_HORIZONTAL_REACH), so the climb is always provably possible; tower.test.mjs checks
 * this against the same true-physics bound step() itself is subject to, not a separate, looser assumption.
 */
export function generateTower(seed: number): Tower {
  const random = seeded(seed);
  const platforms: Platform[] = [{ x: WORLD_WIDTH / 2, height: 0, width: 90, breaking: false, star: false, spring: false, powerup: null }];
  const windBands: WindBand[] = [];
  const drones: Drone[] = [];
  let height = 0, sinceWind = 0, sinceDrone = 0;
  while (height < GENERATED_HEIGHT) {
    const difficulty = smoothstep(Math.min(1, height / DIFFICULTY_RAMP_HEIGHT)); // 0 at the base, eases up to 1
    const width = 70 - 36 * difficulty;
    const gap = 60 + (MAX_BOUNCE_RISE * 0.78 - 60) * difficulty * random();
    height += gap;
    const previous = platforms[platforms.length - 1].x;
    const drift = (random() * 2 - 1) * MAX_HORIZONTAL_REACH * 0.82;
    const x = Math.min(WORLD_WIDTH - width / 2, Math.max(width / 2, previous + drift));
    const breaking = height > 600 && random() < 0.1 + 0.1 * difficulty;
    const star = random() < 0.3;
    // Rare, and never on a platform that is about to disappear — a spring is meant to be a repeatable shortcut
    // (for a ghost replaying the same tower too), not a one-time trick tied to a breaking platform's single use.
    const spring = !breaking && random() < 0.05;
    // Power-ups: three independent, small, mutually-exclusive rolls per platform — rare enough to feel like a
    // find, common enough that a long climb sees a handful of each. Always a bonus on top of what a plain
    // bounce already provides, same spirit as a spring: never required to clear anything.
    const powerup: PowerupKind | null = random() < 0.025 ? "rocket" : random() < 0.025 ? "shield" : random() < 0.025 ? "magnet" : null;
    platforms.push({ x, height, width, breaking, star, spring, powerup });
    sinceWind += gap;
    if (height > 1500 && sinceWind > 900 + random() * 600) {
      sinceWind = 0;
      const from = height + 200, to = from + 500 + random() * 400;
      const push = (random() < 0.5 ? -1 : 1) * (HORIZONTAL_ACCEL * 0.35) * (0.6 + 0.4 * random());
      windBands.push({ from, to, push });
    }
    sinceDrone += gap;
    if (height > DRONE_START_HEIGHT && sinceDrone > DRONE_SPACING * (0.8 + 0.4 * random())) {
      sinceDrone = 0;
      // Amplitude and radius both stay comfortably under WORLD_WIDTH/2 by construction (see DRONE_RADIUS's
      // comment), so the gap-always-exists guarantee holds regardless of these randomized values.
      drones.push({
        height: height + 80 + 60 * random(),
        x0: WORLD_WIDTH / 2 + (random() * 2 - 1) * 40,
        amplitude: 40 + 50 * random(),
        periodTicks: Math.round(120 + 90 * random()),
        phase: random() * Math.PI * 2,
      });
    }
  }
  return Object.freeze({ seed, platforms: Object.freeze(platforms), windBands: Object.freeze(windBands), drones: Object.freeze(drones) });
}

export type RunState = Readonly<{
  tick: number; x: number; height: number; vx: number; vy: number;
  peakHeight: number; stars: number; starPoints: number; comboStreak: number;
  broken: ReadonlySet<number>; starsCollected: ReadonlySet<number>; alive: boolean;
  // Power-up/hazard state, all purely additive on top of the base run above: zero/false for every one of
  // these reproduces the exact pre-FC4 behavior, which is what rules.powerups/rules.drones=false rely on.
  rocketTicks: number; shield: boolean; magnetTicks: number; droneCooldown: number;
  // True exactly when the run ended by reaching SUMMIT_SCORE rather than by falling — alive is false either
  // way once a run is over, so this is what tells a win and a fall apart. tick at that point is the climb's
  // own deterministic time (tick / 60 seconds), never a wall-clock reading.
  summited: boolean;
  // Chase wave bookkeeping: how many score milestones have been crossed so far (0 = no wave yet), the tick
  // the most recent one was crossed at, and the peak height the floor actually starts rising from (kept
  // fresh through the whole warning window, then frozen — see step()'s own comment) — chaseWaveFloor's three
  // inputs besides the current tick, carried in RunState so a replay reproduces the same wave timing as the
  // original run, not a value recomputed from scratch each frame.
  waveIndex: number; waveTriggerTick: number; waveBaseHeight: number;
}>;

export function startRun(): RunState {
  return Object.freeze({
    tick: 0, x: WORLD_WIDTH / 2, height: 0, vx: 0, vy: BOUNCE_VELOCITY,
    peakHeight: 0, stars: 0, starPoints: 0, comboStreak: 0,
    broken: new Set<number>(), starsCollected: new Set<number>(), alive: true,
    rocketTicks: 0, shield: false, magnetTicks: 0, droneCooldown: 0, summited: false,
    waveIndex: 0, waveTriggerTick: 0, waveBaseHeight: 0,
  });
}

function windAt(tower: Tower, height: number): number {
  for (const band of tower.windBands) if (height >= band.from && height <= band.to) return band.push;
  return 0;
}

/** One fixed physics tick. Pure: the same state, dir and rules always produce the same next state. */
export function step(tower: Tower, state: RunState, dir: Dir, rules: RunRules = DEFAULT_RULES): RunState {
  if (!state.alive) return state;
  let vx = state.vx + (dir !== 0 ? dir * HORIZONTAL_ACCEL : 0) + windAt(tower, state.height) * DT;
  if (dir === 0) vx = Math.sign(vx) * Math.max(0, Math.abs(vx) - HORIZONTAL_DRAG * DT);
  vx = Math.max(-MAX_HORIZONTAL_SPEED, Math.min(MAX_HORIZONTAL_SPEED, vx));
  // The lane wraps left-right, like the genre's classic screen wrap: walking off one edge reappears on the
  // other at the same speed. A bouncing wall instead pins a held direction against it, which (combined with
  // a reflected random walk also piling up near the edges) let a single held key ride the wall forever.
  const x = ((state.x + vx * DT) % WORLD_WIDTH + WORLD_WIDTH) % WORLD_WIDTH;

  // A rocket replaces gravity with a steady climb for its whole duration — a straight flight, not one bigger
  // bounce — then simply lets gravity resume once it runs out, arcing back down from wherever that left off.
  const rocketActive = rules.powerups && state.rocketTicks > 0;
  const vy = rocketActive ? ROCKET_SPEED : state.vy - GRAVITY * DT;
  const height = state.height + vy * DT;

  let bounceVy = vy, broken = state.broken, stars = state.stars, starsCollected = state.starsCollected;
  let starPoints = state.starPoints, comboStreak = state.comboStreak;
  let rocketTicks = rocketActive ? state.rocketTicks - 1 : 0;
  let shield = state.shield;
  let magnetTicks = Math.max(0, state.magnetTicks - 1);
  let droneCooldown = Math.max(0, state.droneCooldown - 1);

  // Landing checks only make sense while actually falling under gravity; mid-rocket-flight there is nothing
  // to "land" on, by design (a rocket is a guaranteed, obstruction-free climb for its duration).
  if (vy < 0 && !rocketActive) {
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
      if (rules.powerups && platform.powerup) {
        if (platform.powerup === "rocket") rocketTicks = ROCKET_DURATION_TICKS;
        else if (platform.powerup === "shield") shield = true;
        else if (platform.powerup === "magnet") magnetTicks = MAGNET_DURATION_TICKS;
      }
      break; // one platform can be hit per tick; ties are decided by generation order, not render order
    }
  }

  const peakHeight = Math.max(state.peakHeight, height);

  // Chase wave trigger: fires the instant scoreOf's own formula crosses a new multiple of
  // CHASE_WAVE_SCORE_STEP — the exact same score the HUD and milestone banner read, computed from peakHeight
  // and starPoints just above/below, never a separate height or distance reading. A score only ever crosses
  // a given multiple once (both inputs are monotonically non-decreasing), so this cannot re-trigger a wave
  // already in progress; it also cannot retrigger a wave that finished, since waveIndex only ever increases.
  const scoreSoFar = Math.floor(peakHeight / HEIGHT_PER_POINT) + starPoints;
  const triggeredWaveIndex = Math.floor(scoreSoFar / CHASE_WAVE_SCORE_STEP);
  let waveIndex = state.waveIndex, waveTriggerTick = state.waveTriggerTick, waveBaseHeight = state.waveBaseHeight;
  if (triggeredWaveIndex > waveIndex) {
    waveIndex = triggeredWaveIndex;
    waveTriggerTick = state.tick + 1;
    waveBaseHeight = peakHeight;
  } else if (waveIndex > 0 && state.tick + 1 - waveTriggerTick <= CHASE_WAVE_WARNING_TICKS) {
    // Keeps the anchor fresh for the whole warning window, not just the instant the milestone was crossed —
    // a player who keeps climbing through the ~1.5s warning (the normal case) would otherwise have the
    // floor start rising from however high the peak was back then, already behind the CURRENT peak by
    // whatever was climbed since. The floor must start exactly FALL_MARGIN below the peak at the moment it
    // actually begins rising, not wherever the peak happened to be when the milestone first fired, or it
    // starts the wave already past the camera's bottom edge — invisible from its very first instant.
    waveBaseHeight = peakHeight;
  }

  // Magnet: auto-collects any still-uncollected star within reach every tick it is active, not only one
  // actually landed on — the same scoring/combo formula either way, so a magnet-assisted streak pays exactly
  // like a landed one would. Capped at the peak height reached so far (computed just above): a magnet can
  // reach a star beside or below where the Friend has already been, never one above the highest point it has
  // genuinely gotten to yet, so "a run never collects more stars than the platforms it actually reached"
  // keeps holding exactly as it did before magnets existed.
  if (rules.powerups && magnetTicks > 0) {
    for (let index = 0; index < tower.platforms.length; index++) {
      const platform = tower.platforms[index];
      if (!platform.star || starsCollected.has(index) || platform.height > peakHeight) continue;
      if (Math.abs(platform.height - height) > MAGNET_RADIUS) continue;
      const sideways = Math.abs(x - platform.x), horizontal = Math.min(sideways, WORLD_WIDTH - sideways);
      if (horizontal > MAGNET_RADIUS) continue;
      comboStreak += 1;
      starPoints += STAR_POINTS + Math.min(comboStreak - 1, COMBO_BONUS_MAX_STEPS) * COMBO_BONUS_PER_STEP;
      stars += 1; starsCollected = new Set(starsCollected).add(index);
    }
  }

  // Drones: a hit overrides whatever bounceVy landing logic above produced — getting struck cancels a lucky
  // landing the same tick, not the other way around. The cooldown after a hit means one overlap is one hit,
  // not one hit per tick for as long as the drone happens to still be overlapping.
  if (rules.drones && droneCooldown === 0) {
    for (const drone of tower.drones) {
      const crossed = Math.min(state.height, height) <= drone.height && Math.max(state.height, height) >= drone.height;
      if (!crossed) continue;
      const dx = droneX(drone, state.tick) - x;
      const sideways = Math.abs(dx), horizontal = Math.min(sideways, WORLD_WIDTH - sideways);
      if (horizontal > DRONE_RADIUS + PLAYER_RADIUS) continue;
      bounceVy = -BOUNCE_VELOCITY * 0.9;
      droneCooldown = DRONE_HIT_COOLDOWN_TICKS;
      rocketTicks = 0; // a hit cancels an in-progress rocket flight too — it is a real setback, not a graze
      break;
    }
  }

  const chaseFloor = rules.chase ? chaseWaveFloor(waveIndex, waveTriggerTick, waveBaseHeight, state.tick + 1).floor : -Infinity;
  const floor = Math.max(peakHeight - FALL_MARGIN, chaseFloor);
  let finalHeight = height, finalVy = bounceVy, alive = height >= floor;
  if (!alive && rules.powerups && shield) {
    // A shield spends itself to cancel exactly one otherwise-fatal fall: bounced back up from right at the
    // floor, like landing on an invisible safety net, instead of merely postponing death by one tick.
    alive = true; shield = false;
    finalHeight = floor + 1; finalVy = BOUNCE_VELOCITY;
  }
  const finalPeak = Math.max(peakHeight, finalHeight);
  // A summit ends the run as a win, not a fall — checked after the shield save above so a save that happens
  // to also cross the summit score still counts (the Friend is alive and has the score, nothing more to ask).
  // Once summited the run freezes exactly like death does (step() returns the frozen state unchanged on any
  // further call, via the !state.alive check at the top), so tick effectively becomes the climb's own time.
  const summited = Math.floor(finalPeak / HEIGHT_PER_POINT) + starPoints >= SUMMIT_SCORE;

  return Object.freeze({
    tick: state.tick + 1, x, height: finalHeight, vx, vy: finalVy, peakHeight: finalPeak, stars, starPoints, comboStreak,
    broken, starsCollected, alive: alive && !summited, summited,
    rocketTicks, shield, magnetTicks, droneCooldown,
    waveIndex, waveTriggerTick, waveBaseHeight,
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
export function simulate(seed: number, transitions: readonly Transition[], maxTicks = 60 * 180, rules: RunRules = DEFAULT_RULES): RunResult {
  const tower = generateTower(seed);
  const input = inputReader(transitions);
  let state = startRun();
  while (state.alive && state.tick < maxTicks) state = step(tower, state, input(state.tick), rules);
  return Object.freeze({ ticks: state.tick, state, score: scoreOf(state) });
}

/**
 * A simple reflex "ghost" bot: always steers toward the x of the next platform above it, with a small dead
 * zone so it does not flap direction right on top of a platform. It is not a trained or optimal player — just
 * enough to give a run an opponent from the very first attempt. Deterministic, like everything else here, so
 * its run can be recorded and shared the same way a human one can; the UI must label it "bot", never a Friend.
 */
/** Three fixed skill tiers used to calibrate the chase waves against (see tower.test.mjs's "chase wave
 * calibration" test and README.md's table) and, for "medium", as the single opponent bot every live run gets
 * — none of them optimal play, all of them beatable by design (see BOT_FUMBLE_CHANCE's own comment).
 * reactionTicks: how often the bot reconsiders its aim (a real player does not correct course every tick
 * either). fumbleBase/fumbleSlope feed the same rising-with-height formula BOT_FUMBLE_CHANCE always used; a
 * stronger tier simply fumbles less at every height, not "never". */
export type BotSkill = "weak" | "medium" | "strong";
// Comfortably above the worst realistic single-tick landing overshoot (falling the full FALL_MARGIN at
// terminal velocity overshoots by roughly sqrt(2*GRAVITY*FALL_MARGIN)*DT =~ 14px; this just needs to clear
// that with margin) — see the lastLanded-tracking comment in the loop below for what this actually fixes.
const LANDING_HEIGHT_SLACK = 20;
const BOT_PROFILES: Record<BotSkill, Readonly<{ reactionTicks: number; fumbleBase: number; fumbleSlope: number }>> = {
  weak: { reactionTicks: 18, fumbleBase: 0.05, fumbleSlope: 0.75 },
  medium: { reactionTicks: 10, fumbleBase: 0.01, fumbleSlope: 0.45 }, // unchanged from the original single bot
  strong: { reactionTicks: 6, fumbleBase: 0.002, fumbleSlope: 0.18 },
};

export function botRun(
  seed: number, maxTicks = 60 * 180, rules: RunRules = DEFAULT_RULES, skill: BotSkill = "medium",
): { transitions: Transition[]; result: RunResult } {
  const tower = generateTower(seed);
  const profile = BOT_PROFILES[skill];
  const fumble = seeded(seed ^ 0x9e3779b9); // independent of the tower's own randomness
  let state = startRun(), dir: Dir = 0, lastLanded = 0; // index 0 is the spawn platform, already under the Friend
  const transitions: Transition[] = [];
  while (state.alive && state.tick < maxTicks) {
    if (state.tick % profile.reactionTicks === 0) {
      // Height briefly passes above a far platform mid-flight on the way to apex, long before actually landing
      // on it, so the target can only ever be "the platform just above the last confirmed landing" — never
      // picked from a bare height comparison, or the bot aims at a platform it cannot possibly reach yet.
      const target = tower.platforms[Math.min(lastLanded + 1, tower.platforms.length - 1)];
      const sideways = target.x - state.x;
      const wrapped = sideways > WORLD_WIDTH / 2 ? sideways - WORLD_WIDTH : sideways < -WORLD_WIDTH / 2 ? sideways + WORLD_WIDTH : sideways;
      let next: Dir = Math.abs(wrapped) < 3 ? 0 : wrapped > 0 ? 1 : -1;
      const fumbleChance = profile.fumbleBase + profile.fumbleSlope * Math.min(1, state.height / 8000);
      if (fumble() < fumbleChance) next = ([-1, 0, 1] as const)[Math.floor(fumble() * 3)];
      if (next !== dir) { dir = next; transitions.push({ tick: state.tick, dir }); }
    }
    const wasFalling = state.vy < 0;
    // The bot has no idea the chase/drones/power-ups exist — it still only aims at the next platform, exactly
    // as before. That is intentional: it is what keeps the bot genuinely beatable-but-not-guaranteed under
    // the new hazards too, without hand-tuning a second "bot is aware of hazard X" behavior for each one.
    state = step(tower, state, dir, rules);
    // Identifies exactly which platform this landing happened on by the same height-and-horizontal-overlap
    // test step() itself uses, rather than inferring it from height alone with a near-zero tolerance — the
    // Friend's post-landing height is essentially always somewhat BELOW the platform's own height (physics
    // resolves once per 1/60s tick, not continuously, so a landing is caught a few pixels into the platform,
    // never caught exactly at its surface), by up to roughly one tick's fall speed. A near-zero tolerance here
    // used to leave the bot believing it had never actually reached the platform it was already bouncing on
    // every single cycle — it kept re-aiming at the same, already-conquered platform forever, visible as a
    // bot stalled indefinitely at a low, constant height (see tower.test.mjs's "lastLanded tracking" test).
    if (wasFalling && (state.vy === BOUNCE_VELOCITY || state.vy === SPRING_VELOCITY)) {
      for (let index = lastLanded + 1; index < tower.platforms.length && tower.platforms[index].height <= state.height + LANDING_HEIGHT_SLACK; index++) {
        const platform = tower.platforms[index];
        const sideways = Math.abs(state.x - platform.x), horizontal = Math.min(sideways, WORLD_WIDTH - sideways);
        if (horizontal <= platform.width / 2 + PLAYER_RADIUS) lastLanded = index;
      }
    }
  }
  return { transitions, result: Object.freeze({ ticks: state.tick, state, score: scoreOf(state) }) };
}

// --- A short text code for sharing a run: "FC7.<rules digit><seed base36>.<tokens>!<score base36>". ---
// Each token is "<ticks since the previous change, base36><L|N|R>". Direction letters are uppercase and base36
// digits are lowercase, so a single regex splits tokens unambiguously without a separator between them.
//
// The version number has moved six times now, each time because the same seed and transitions started
// replaying to a different score than before: FC1 -> FC2 fixed a star paying out on every repeat bounce
// instead of once; FC2 -> FC3 added springs and the star combo bonus; FC3 -> FC4 added the chase, drones and
// power-ups (and introduced RunRules, see its own comment, as a new thing a code has to carry); FC4 -> FC5
// added the summit (SUMMIT_SCORE) as a second way a run can end, and lowered DRONE_START_HEIGHT/DRONE_SPACING
// (a tuning fix to tower generation itself, which shifts the seeded random() sequence for everything
// generated after a tower's first drone, same as FC2 -> FC3 silently reshaping towers when spring/power-up
// fields were added); FC5 -> FC6 replaced the always-on, ever-accelerating chase with short score-triggered
// waves (chaseWaveFloor), lowered SUMMIT_SCORE from 25000 and fixed generateTower's sideways-drift bound
// (MAX_HORIZONTAL_REACH, see its own comment); FC6 -> FC7 fixed the wave anchor so it starts exactly at the
// camera's bottom edge instead of already behind it (see step()'s own comment), raised the wave speed well
// above typical climbing pace so it is actually visible closing the gap, raised SUMMIT_SCORE again (a real
// human run beat the FC6 value — see its own comment) and switched the difficulty ramp from linear to
// smoothstep over a longer reach (DIFFICULTY_RAMP_HEIGHT, see its own comment). All six old prefixes are
// refused by name instead of silently replaying to a number that no longer matches what the code claims.
const TOKEN = /([0-9a-z]+)([LNR])/g;
const LETTER: Record<Dir, "L" | "N" | "R"> = { [-1]: "L", 0: "N", 1: "R" };
const DIR_OF: Record<string, Dir> = { L: -1, N: 0, R: 1 };

function rulesToFlags(rules: RunRules): number {
  return (rules.chase ? 1 : 0) | (rules.drones ? 2 : 0) | (rules.powerups ? 4 : 0);
}
function flagsToRules(flags: number): RunRules {
  return Object.freeze({ chase: Boolean(flags & 1), drones: Boolean(flags & 2), powerups: Boolean(flags & 4) });
}

export function encodeRun(seed: number, transitions: readonly Transition[], score: number, rules: RunRules = DEFAULT_RULES): string {
  let previous = 0;
  const tokens = transitions.map(({ tick, dir }) => {
    const token = `${(tick - previous).toString(36)}${LETTER[dir]}`;
    previous = tick;
    return token;
  });
  return `FC7.${rulesToFlags(rules)}${seed.toString(36)}.${tokens.join("")}!${score.toString(36)}`;
}

export type DecodedRun = Readonly<{ seed: number; transitions: readonly Transition[]; claimedScore: number; rules: RunRules }>;

export function decodeRun(code: string): DecodedRun {
  const trimmed = code.trim();
  if (/^FC1\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (its star scoring had a bug) and can no longer be replayed.");
  }
  if (/^FC2\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (before springs and the star combo bonus) and can no longer be replayed.");
  }
  if (/^FC3\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (before the chase, drones and power-ups) and can no longer be replayed.");
  }
  if (/^FC4\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (before the summit, and with a different drone layout) and can no longer be replayed.");
  }
  if (/^FC5\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (the chase worked differently then — a constant chase, not short waves) and can no longer be replayed.");
  }
  if (/^FC6\./.test(trimmed)) {
    throw new Error("That run code is from an older version of Friend Climb (the chase waves and difficulty ramp worked differently then) and can no longer be replayed.");
  }
  const match = /^FC7\.([0-7])([0-9a-z]+)\.([0-9a-zLNR]*)!([0-9a-z]+)$/.exec(trimmed);
  if (!match) throw new Error("That run code does not look like a Friend Climb code.");
  const [, flagsPart, seedPart, tokenPart, scorePart] = match;
  const transitions: Transition[] = [];
  let tick = 0, consumed = 0;
  for (const found of tokenPart.matchAll(TOKEN)) {
    consumed += found[0].length;
    tick += parseInt(found[1], 36);
    transitions.push({ tick, dir: DIR_OF[found[2]] });
  }
  if (consumed !== tokenPart.length) throw new Error("That run code has unreadable characters in it.");
  return Object.freeze({
    seed: parseInt(seedPart, 36), transitions: Object.freeze(transitions), claimedScore: parseInt(scorePart, 36),
    rules: flagsToRules(parseInt(flagsPart, 10)),
  });
}
