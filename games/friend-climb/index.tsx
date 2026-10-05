"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, spriteFrame } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";
import {
  DT, WORLD_WIDTH, PLAYER_RADIUS, HEIGHT_PER_POINT, STAR_POINTS, FALL_MARGIN, REFERENCE_HEIGHT,
  DRONE_RADIUS, DEFAULT_RULES, CHASE_WAVE_SCORE_STEP, chaseWaveFloor, chaseWaveUrgency, droneX,
  type Dir, type Tower, type RunState, type Transition, type RunRules, type Drone,
  seedForDate, generateTower, startRun, step, scoreOf, botRun, encodeRun, decodeRun,
} from "./tower";
import { defaultPlatform } from "./game/platform";

// The canvas's backing store always matches the SDK frame's actual CSS aspect ratio exactly (see the
// ResizeObserver below) — the whole point is that there is never a gap on any side to letterbox. Only the
// width varies by frame shape; the height stays fixed at REFERENCE_HEIGHT (imported from tower.ts) so the
// *amount* of tower visible, the camera and the physics constants tuned against it never depend on the
// screen size — every player sees the same vertical slice of the tower, a fairness requirement for any
// future tournament.
//
// The camera's own world-height reference is pinned to the run's own peakHeight every frame — never
// smoothed or lagged — and this anchor is derived directly from FALL_MARGIN so the screen's bottom edge
// always lines up exactly with the death boundary tower.ts enforces: at height == peakHeight - FALL_MARGIN,
// CAMERA_ANCHOR - (height - peakHeight) == CAMERA_ANCHOR + FALL_MARGIN == REFERENCE_HEIGHT, the very bottom
// row of the canvas, every tick, not just approximately (tower.test.mjs proves this algebraically). A
// previous version eased the camera toward the peak with an exponential lag purely for a smoother look, but
// that lag floated relative to FALL_MARGIN depending on climb speed — a platform still visible on screen
// could already be past the death line. Any future easing must stay out of this value and apply only to
// purely decorative effects (squash/stretch, particles), never to what toScreenY uses.
const CAMERA_ANCHOR = REFERENCE_HEIGHT - FALL_MARGIN;
/** The whole scene stays inside this three-color palette: black, white and Rare Friends' signal green. */
const NEON = "#ccff00";
const todaySeed = () => seedForDate(new Date().toISOString().slice(0, 10));

type Ghost = Readonly<{ label: string; color: string; tower: Tower; transitions: readonly Transition[]; rules: RunRules; dir: Dir; state: RunState; index: number; starFlash: number }>;
type RunRecord = Readonly<{ seed: number; transitions: readonly Transition[]; score: number; rules: RunRules }>;
type Screen = "pick" | "play" | "result";
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
type Popup = { x: number; y: number; life: number; text: string };

function makeGhost(label: string, color: string, tower: Tower, transitions: readonly Transition[], rules: RunRules): Ghost {
  return { label, color, tower, transitions, rules, dir: 0, state: startRun(), index: 0, starFlash: 0 };
}
/** A ghost is its own independent replay — tower.ts tracks its starsCollected separately from the live
 * player's, exactly like two different runs of the same tower naturally would — so its own star flash fires
 * from its own state, never the player's, even when a ghost is standing right where the player is. Each
 * ghost always replays under its OWN recorded rules (own.rules / the imported code's decoded rules), never
 * whatever the live player currently has toggled in Settings — otherwise the same code could replay to a
 * different outcome depending on who is watching it. */
function advanceGhost(ghost: Ghost): Ghost {
  if (!ghost.state.alive) return { ...ghost, starFlash: Math.max(0, ghost.starFlash - DT / 0.3) };
  let { dir, index } = ghost;
  while (index < ghost.transitions.length && ghost.transitions[index].tick <= ghost.state.tick) { dir = ghost.transitions[index].dir; index++; }
  const previousStars = ghost.state.stars, state = step(ghost.tower, ghost.state, dir, ghost.rules);
  const starFlash = state.stars > previousStars ? 1 : Math.max(0, ghost.starFlash - DT / 0.3);
  return { ...ghost, dir, index, state, starFlash };
}
/** The lane wraps left-right (see tower.ts); draw whichever copy of x is on screen, sometimes both near an edge. */
function wrappedScreenXs(x: number, laneMargin: number): number[] {
  const xs = [laneMargin + x];
  if (x < PLAYER_RADIUS) xs.push(laneMargin + x + WORLD_WIDTH);
  if (x > WORLD_WIDTH - PLAYER_RADIUS) xs.push(laneMargin + x - WORLD_WIDTH);
  return xs;
}
/** tick / 60 is the run's own deterministic elapsed time in seconds — never a wall-clock reading, so a climb
 * time is exactly reproducible from a replayed run code, same as the score is. */
function formatClimbTime(ticks: number): string {
  const totalSeconds = Math.floor(ticks / 60);
  const minutes = Math.floor(totalSeconds / 60), seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function spawnBurst(particles: Particle[], x: number, y: number, color: string, count: number) {
  for (let index = 0; index < count; index++) {
    const angle = Math.PI * (0.15 + 0.7 * Math.random());
    particles.push({ x, y, vx: Math.cos(angle) * 90 * (Math.random() - 0.5) * 2, vy: Math.sin(angle) * 90, life: 0.4, color });
  }
}

// --- Procedural music: synthesized directly with WebAudio (never a sampled or licensed track), three layers
// that build up rather than one flat loop — a melody arpeggio present from the start, a bass root under
// every other beat, and a kick/hihat pair that only joins in once the climb has made real progress (peakHeight
// > 40), so the texture visibly thickens as the run goes on, not just the tempo. The render loop's scheduler
// shrinks the beat interval as the chase accelerates, so tempo itself ramps up with the on-screen threat too. ---
const MUSIC_SCALE = [220, 261.63, 329.63, 392, 440, 523.25]; // melody: A minor pentatonic-ish, kept calm
const BASS_NOTES = [55, 65.41, 73.42, 87.31]; // a simple four-chord root progression, an octave+ below the melody

function playMusicNote(ctx: AudioContext, frequency: number, urgency: number) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "triangle"; osc.frequency.value = frequency;
  // A brief, plucked envelope: fast attack, short decay — urgency both raises the volume a little and
  // shortens the note so a fast, tense tempo does not smear into itself.
  const peak = 0.05 + 0.03 * urgency, duration = 0.5 - 0.3 * urgency;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + duration + 0.02);
}
function playBassNote(ctx: AudioContext, frequency: number, urgency: number) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "sine"; osc.frequency.value = frequency;
  const peak = 0.07 + 0.04 * urgency;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.37);
}
function playKick(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(42, now + 0.12);
  gain.gain.setValueAtTime(0.22, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.16);
}
function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.2)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
  return buffer;
}
function playHihat(ctx: AudioContext, noiseBuffer: AudioBuffer) {
  const now = ctx.currentTime;
  const source = ctx.createBufferSource(); source.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter(); filter.type = "highpass"; filter.frequency.value = 6000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.05, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  source.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  source.start(now); source.stop(now + 0.06);
}
/** A short, bright two-note sting for a drone's first sighting — distinct from the plucked melody notes, so
 * it reads as an alert, not just another beat. */
function playDroneAlert(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (const [offset, frequency] of [[0, 740], [0.09, 988]] as const) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "square"; osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(0.06, now + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.08);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now + offset); osc.stop(now + offset + 0.1);
  }
}
/** A low, rising rumble for the chase's own grace period ending — one long tone, not a beat, so it reads as
 * an announcement rather than part of the music's own pulse. */
function playLavaWarning(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(70, now);
  osc.frequency.linearRampToValueAtTime(140, now + 0.6);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.09, now + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.72);
}

// --- Arcade Neon rendering: everything below builds small offscreen bitmaps ONCE (sprite outline, glow dot,
// hazard pattern) instead of recomputing a soft-edge "glow" every frame with ctx.shadowBlur, which is one of
// the more expensive canvas operations on a phone GPU. The render loop only ever calls drawImage/fillStyle
// with these, which is cheap at any screen size. None of this reads or changes tower.ts's simulation state.

/** A soft green dot, stamped (never shadowBlur'd) wherever a glow is needed: particles, stars, outlines. */
function buildGlowDot(radius: number, rgb = "204,255,0"): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = radius * 2;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, `rgba(${rgb},0.9)`); gradient.addColorStop(0.5, `rgba(${rgb},0.35)`); gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(radius, radius, radius, 0, Math.PI * 2); ctx.fill();
  return canvas;
}

/** How far buildPlayerSprite's glow halo extends past the canonical 16x16 mask; used again where the sprite
 * is drawn, to line the mask itself back up with where the old unpadded sprite used to sit on screen. */
const PLAYER_SPRITE_PAD = 14;
/** The canonical 16x16 mask, composited once into a neon sprite: a soft green halo, a crisp green outline
 * ring, and a pale fill on top — the same "halo then fill" trick the other games use, just recolored for a
 * dark scene and baked into a bitmap instead of redrawn pixel by pixel every frame. */
function buildPlayerSprite(rows: readonly string[]): HTMLCanvasElement {
  const CELL = 5, PAD = PLAYER_SPRITE_PAD, canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16 * CELL + PAD * 2;
  const ctx = canvas.getContext("2d")!, off = PAD;
  const cells: [number, number][] = [];
  rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "#") cells.push([px, py]); }));
  for (const [grow, alpha] of [[4, 0.12], [2.5, 0.22], [1, 0.4]] as const) {
    ctx.fillStyle = `rgba(204,255,0,${alpha})`;
    for (const [px, py] of cells) ctx.fillRect(off + px * CELL - grow, off + py * CELL - grow, CELL + grow * 2, CELL + grow * 2);
  }
  ctx.fillStyle = "#ccff00";
  for (const [px, py] of cells) ctx.fillRect(off + px * CELL - 1, off + py * CELL - 1, CELL + 2, CELL + 2);
  ctx.fillStyle = "#eafff0";
  for (const [px, py] of cells) ctx.fillRect(off + px * CELL, off + py * CELL, CELL, CELL);
  return canvas;
}

/** Black/green diagonal hazard stripes for a breaking platform — one tiny tile, repeated by the canvas's own
 * pattern fill, not redrawn by hand every frame. */
function buildHazardPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  const tile = document.createElement("canvas"); tile.width = tile.height = 10;
  const tctx = tile.getContext("2d")!;
  tctx.fillStyle = "#000"; tctx.fillRect(0, 0, 10, 10);
  tctx.strokeStyle = "#ccff00"; tctx.lineWidth = 3;
  for (const offset of [-5, 5, 15]) { tctx.beginPath(); tctx.moveTo(offset, 10); tctx.lineTo(offset + 10, 0); tctx.stroke(); }
  return ctx.createPattern(tile, "repeat")!;
}

/** A classic five-point star outline, used for both the collectible stars and the parallax field. */
function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number, innerR: number) {
  ctx.beginPath();
  for (let point = 0; point < 10; point++) {
    const radius = point % 2 === 0 ? outerR : innerR, angle = (Math.PI / 5) * point - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
    if (point === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** A deterministic, stable star field: which world-height "bands" carry a star, and where, never changes
 * from frame to frame (it is not re-randomized on every draw), so stars hold still while the camera scrolls.
 * Purely decorative — unrelated to tower.ts's seeded generation, so it never affects the physics or score. */
const STAR_BAND = 70;
/** Spans the whole frame (spanWidth), not just the narrow tower lane, in plain canvas x — the sky is not part
 * of the lane that wraps, so these are never offset by LANE_MARGIN the way anything tied to tower.ts's world
 * coordinates is. */
function starsBetween(topHeight: number, bottomHeight: number, spanWidth: number): { x: number; y: number; size: number }[] {
  const stars: { x: number; y: number; size: number }[] = [];
  const first = Math.floor(bottomHeight / STAR_BAND), last = Math.ceil(topHeight / STAR_BAND);
  for (let band = first; band <= last; band++) {
    let h = (band * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    const roll = (h >>> 0) / 4294967296;
    if (roll > 0.4) continue; // most bands are empty; only some carry a star
    stars.push({ x: ((h >>> 8) % 1000) / 1000 * spanWidth, y: band * STAR_BAND + (h % STAR_BAND), size: 1 + (h % 3) * 0.5 });
  }
  return stars;
}
/** A skyline silhouette near the ground, one tile's worth of buildings in plain canvas x; drawSkyline below
 * repeats it sideways to cover whatever the frame's actual width turns out to be. It fades out as the camera
 * climbs away, same as the star field is unrelated to tower.ts's own world coordinates or its seed. */
const SKYLINE_TILE_WIDTH = 290;
const SKYLINE: readonly [number, number, number][] = [ // [x, width, height]
  [4, 20, 60], [26, 16, 100], [44, 22, 44], [70, 18, 130], [92, 26, 70], [122, 16, 95],
  [142, 24, 50], [170, 18, 115], [192, 22, 65], [218, 16, 150], [238, 20, 55], [262, 26, 90],
];
function drawSkyline(ctx: CanvasRenderingContext2D, toScreenY: (height: number) => number, spanWidth: number) {
  const tiles = Math.ceil(spanWidth / SKYLINE_TILE_WIDTH);
  for (let tile = 0; tile < tiles; tile++) for (const [x, width, height] of SKYLINE) {
    ctx.fillRect(tile * SKYLINE_TILE_WIDTH + x, toScreenY(height) - 1, width, height);
  }
}

/** Score multiples (the exact same number the HUD's "Score N" reads, via scoreOf — not a separate height or
 * distance unit) at which a milestone banner fires and the background tint shifts; purely presentational —
 * never read by tower.ts, so it cannot affect score or determinism. scoreOf is monotonically non-decreasing
 * over a run (both of its inputs, peakHeight and starPoints, only ever grow), so a zone, once reached, is
 * never re-announced. Reuses tower.ts's own CHASE_WAVE_SCORE_STEP directly, rather than a separately-tuned
 * copy of the same number, so the banner and the chase wave it announces can never drift out of sync. */
const MILESTONE_STEP = CHASE_WAVE_SCORE_STEP;
/** Cycled by zone index for a barely-perceptible background shift every MILESTONE_STEP score points — stays
 * inside the dark/near-black register the Arcade Neon palette calls for, not a new bright hue. */
const ZONE_BACKGROUNDS: readonly string[] = ["#060606", "#06090a", "#060a07", "#0a0906", "#090609"];

type Run = {
  tower: Tower; state: RunState; transitions: Transition[]; rules: RunRules; lastDir: Dir; bot: Ghost; own: Ghost[]; imported: Ghost | null;
  // Per-run particle state. This used to live outside the Run object and never reset between games, so a
  // second run started after climbing high in the first one rendered the Friend far below the visible
  // canvas — invisible, camera stuck at the previous run's height. Keeping it here fixes that at the root:
  // a fresh Run means a fresh camera, exactly like a fresh tower and a fresh score. (There is no separate
  // cameraHeight field: the camera is state.peakHeight directly, every frame — see CAMERA_ANCHOR above.)
  particles: Particle[]; popups: Popup[]; starFlash: number;
  // Highest milestone zone (scoreOf(state) / MILESTONE_STEP, floored) already announced, plus how long its
  // banner still has left to show; both purely presentational, derived from the same score the HUD shows,
  // never fed back into it.
  milestoneZone: number; milestoneFlash: number;
  // Screen shake magnitude (decaying) and a brief full-canvas color flash, both purely presentational and
  // both skipped entirely under reduced motion — see the render loop's "FX" block.
  shake: number; hitFlash: number;
  // One-shot "did we already announce this" flags, plus the lava-warning banner's own fade timer (same
  // pattern as milestoneFlash). lastWaveWarned holds the highest waveIndex whose "LAVA SURGE!" warning has
  // already fired, so a wave's ~1.5s warning window (chaseWaveFloor's own `warning` flag stays true the
  // whole window) triggers the banner/sound exactly once, not every frame it stays true — one per wave, not
  // one per run, since waves now recur. droneSpotted fires once per run the first time any drone is actually
  // visible on screen, not merely generated into the tower.
  lastWaveWarned: number; lavaFlash: number; droneSpotted: boolean;
};

export default function FriendClimb({ friendId, client, paused }: GameComponentProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The canvas's current backing-store size in logical pixels, kept exactly in sync with its CSS box by the
  // ResizeObserver below; height is always REFERENCE_HEIGHT, width tracks whatever the SDK frame's actual
  // shape is right now. The render loop reads this every frame instead of a fixed constant, so the dark
  // background, parallax and lane all fill the frame edge to edge on any aspect ratio, never leaving a gap
  // for the frame's own background to show through.
  const viewRef = useRef({ width: REFERENCE_HEIGHT * 0.75, height: REFERENCE_HEIGHT });
  // The score readout changes every physics tick; writing it to this DOM node directly from the render loop
  // (throttled below) keeps it live without asking React to re-render the whole component ~60 times a second.
  // A prior version read runRef.current.state.height only inside the JSX, which only re-evaluates on a React
  // re-render — none of which the render loop triggers — so the HUD showed "Height 0" for the whole run.
  const scoreLabel = useRef<HTMLSpanElement>(null);
  const raceLabel = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState("Loading your Friend…"), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  const [screen, setScreen] = useState<Screen>("pick");
  const [seed, setSeed] = useState<number>(() => todaySeed());
  const [best, setBest] = useState<Record<number, number>>({}); // this session only; see the disclaimer in the menu
  const [ghosts, setGhosts] = useState<readonly RunRecord[]>([]); // this session's own past runs, newest first
  const [lastScore, setLastScore] = useState(0), [lastCode, setLastCode] = useState("");
  const [lastHeightPoints, setLastHeightPoints] = useState(0), [lastStars, setLastStars] = useState(0), [lastStarPoints, setLastStarPoints] = useState(0);
  const [lastSummited, setLastSummited] = useState(false), [lastClimbTicks, setLastClimbTicks] = useState(0);
  const [importCode, setImportCode] = useState(""), [importError, setImportError] = useState("");
  const [importedGhost, setImportedGhost] = useState<RunRecord | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [menu, setMenu] = useState<"settings" | null>(null), [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false);
  // Every one of these is toggleable in Settings (default on) specifically so the user can compare what each
  // mechanic actually adds, one at a time — snapshotted into a RunRules at the moment a run starts (see
  // startGame), never read mid-run, so flipping a toggle never retroactively changes an in-progress climb.
  const [chaseOn, setChaseOn] = useState(true), [dronesOn, setDronesOn] = useState(true), [powerupsOn, setPowerupsOn] = useState(true);
  // Purely presentational, so unlike the three above these are never part of RunRules or the run code —
  // nothing about them can affect a score or a replay's outcome.
  const [raceHudOn, setRaceHudOn] = useState(true), [fxOn, setFxOn] = useState(true);
  const live = useRef({ paused, menu, reducedMotion, screen, raceHudOn, fxOn, muted });
  live.current = { paused, menu, reducedMotion, screen, raceHudOn, fxOn, muted };
  const platform = useRef(defaultPlatform({ friendId, client })).current;

  const sound = useRef<FriendSoundKit | null>(null);
  useEffect(() => { sound.current = createFriendSoundKit({ muted: true }); return () => sound.current?.dispose(); }, []);
  // Created lazily on the same user gesture that unlocks the SDK sound kit (browsers block audio without one);
  // disposed on unmount. Scheduling state (nextNoteAt/noteIndex) lives alongside it so the render loop below
  // can check "is it time for the next note" cheaply every frame without its own separate interval timer.
  const music = useRef<{ ctx: AudioContext | null; nextNoteAt: number; noteIndex: number; noiseBuffer: AudioBuffer | null }>({
    ctx: null, nextNoteAt: 0, noteIndex: 0, noiseBuffer: null,
  });
  useEffect(() => () => { void music.current.ctx?.close(); }, []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(preference.matches); change(); preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);

  const dirRef = useRef<Dir>(0), heldKeys = useRef(new Set<string>()), heldPointer = useRef<Dir | null>(null);
  const runRef = useRef<Run | null>(null);
  const playedBefore = useRef(false); // for the "land on a star" hint, shown only during the session's first run
  const [isFirstRun, setIsFirstRun] = useState(true);
  // The control hint ("Arrow keys or A/D... hold either side") shows for only the first few seconds of EVERY
  // run, not the whole time — it used to sit at the bottom of the screen for the run's entire length, which
  // is also where the SDK's own toolbar lives (see style.css's --fc-safe-zone comment); moving it under the
  // HUD and timing it out keeps the bottom clear and stops it from becoming permanent on-screen clutter.
  const [controlHintVisible, setControlHintVisible] = useState(true);
  const controlHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (controlHintTimer.current) clearTimeout(controlHintTimer.current); }, []);
  const stop = () => { heldKeys.current.clear(); heldPointer.current = null; dirRef.current = 0; };

  function startGame(nextSeed: number) {
    const tower = generateTower(nextSeed);
    // Snapshot of the current Settings toggles, fixed for this run's whole lifetime — flipping a toggle mid-run
    // (impossible anyway, Settings blocks the scene while open) must never retroactively change an in-progress
    // climb, and a saved/shared run must always replay under the exact rules it was recorded with.
    const rules: RunRules = { chase: chaseOn, drones: dronesOn, powerups: powerupsOn };
    const sameTower = ghosts.filter(run => run.seed === nextSeed);
    // Ghost colors stay inside the black/green/white palette — different opacities of white, plus green for
    // a pasted friend's code — and are told apart by their label, not by introducing another hue.
    const own = sameTower.slice(0, 3).map((run, index) => makeGhost(`run ${index + 1}`, "rgba(255,255,255,0.3)", tower, run.transitions, run.rules));
    const bot = makeGhost("bot", "rgba(255,255,255,0.55)", tower, botRun(nextSeed, undefined, rules).transitions, rules);
    const imported = importedGhost && importedGhost.seed === nextSeed
      ? makeGhost("friend's code", "rgba(204,255,0,0.6)", tower, importedGhost.transitions, importedGhost.rules) : null;
    runRef.current = {
      tower, state: startRun(), transitions: [], rules, lastDir: 0, bot, own, imported,
      particles: [], popups: [], starFlash: 0, milestoneZone: 0, milestoneFlash: 0, shake: 0, hitFlash: 0,
      lastWaveWarned: 0, lavaFlash: 0, droneSpotted: false,
    };
    setIsFirstRun(!playedBefore.current); playedBefore.current = true;
    setControlHintVisible(true);
    if (controlHintTimer.current) clearTimeout(controlHintTimer.current);
    controlHintTimer.current = setTimeout(() => setControlHintVisible(false), 4500);
    setSeed(nextSeed); setImportError(""); setScreen("play");
  }
  function endGame(state: RunState) {
    const score = scoreOf(state), run = runRef.current;
    const transitions = run?.transitions ?? [], rules = run?.rules ?? DEFAULT_RULES;
    setGhosts(previous => {
      const next = [{ seed, transitions, score, rules }, ...previous].slice(0, 12);
      platform.progress.save(next);
      return next;
    });
    setBest(previous => ({ ...previous, [seed]: Math.max(previous[seed] ?? 0, score) }));
    setLastScore(score); setLastHeightPoints(Math.floor(state.peakHeight / HEIGHT_PER_POINT)); setLastStars(state.stars); setLastStarPoints(state.starPoints);
    setLastSummited(state.summited); setLastClimbTicks(state.tick);
    setLastCode(encodeRun(seed, transitions, score, rules)); setCopyFailed(false); setScreen("result");
  }

  // One continuous render loop for the whole component's life: the canvas stays mounted across every screen so
  // this never has to reload the Friend's artwork or reset the camera/particles just because a menu opened over it.
  useEffect(() => {
    const node = canvas.current, ctx = node?.getContext("2d");
    if (!node || !ctx) { setFailed(true); setStatus("This browser cannot render the tower."); return; }
    let cancelled = false, frame = 0, previousTime = 0, accumulator = 0, lastHudUpdate = 0;
    setFailed(false); setStatus("Loading your Friend…");
    // Keeps the backing store's own intrinsic aspect ratio exactly equal to the CSS box's (see style.css: the
    // canvas is width/height:100% of .fc-scene, no max-width/max-height clamp), so there is never a gap on
    // either side for .fc-scene's background to show through. Changing width/height clears the canvas, which
    // is fine: the next animation frame redraws everything regardless.
    const resize = () => {
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const width = Math.max(1, Math.round(REFERENCE_HEIGHT * (box.width / box.height)));
      if (node.width === width && node.height === REFERENCE_HEIGHT) return;
      node.width = width; node.height = REFERENCE_HEIGHT;
      viewRef.current = { width, height: REFERENCE_HEIGHT };
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(node);
    // Built once per mount, reused by drawImage every frame after — see the "Arcade Neon rendering" helpers.
    const glowDot = buildGlowDot(16), hazardPattern = buildHazardPattern(ctx);
    const playerSprites = new Map<string, HTMLCanvasElement>();
    // The initial client.read() has no economy use here, but it is what tells the trusted runtime the
    // session is ready (see examples/scrolling-world, which does the same for a free exploration game).
    void Promise.all([createFriendReader().read(friendId), client.read()]).then(([sprites, snapshot]) => {
      if (cancelled) return;
      if (snapshot.friendId !== friendId) throw new Error("Game session does not match the selected Friend.");
      setStatus("");
      const render = (now: number) => {
        // Shadows the removed module-level constants of the same name on purpose: every reference below is
        // unchanged from before this frame became responsive, it now just reads the current frame shape.
        const VIEW = viewRef.current, LANE_MARGIN = Math.max(10, (VIEW.width - WORLD_WIDTH) / 2);
        const dt = previousTime ? Math.min((now - previousTime) / 1000, 0.05) : 0; previousTime = now;
        const run = runRef.current, active = !live.current.paused && live.current.menu === null && live.current.screen === "play" && !document.hidden;
        if (run && active && run.state.alive) {
          const pressed = (heldPointer.current ?? ((heldKeys.current.has("ArrowRight") || heldKeys.current.has("KeyD") ? 1 : 0)
            - (heldKeys.current.has("ArrowLeft") || heldKeys.current.has("KeyA") ? 1 : 0))) as Dir;
          dirRef.current = pressed;
          accumulator += dt;
          while (accumulator >= DT && run.state.alive) {
            accumulator -= DT;
            if (dirRef.current !== run.lastDir) { run.lastDir = dirRef.current; run.transitions.push({ tick: run.state.tick, dir: dirRef.current }); }
            const previousStars = run.state.stars, previousStarPoints = run.state.starPoints, wasFalling = run.state.vy < 0;
            const previousRocket = run.state.rocketTicks, previousShield = run.state.shield;
            const previousMagnet = run.state.magnetTicks, previousCooldown = run.state.droneCooldown;
            run.state = step(run.tower, run.state, dirRef.current, run.rules);
            run.bot = advanceGhost(run.bot); run.own = run.own.map(advanceGhost);
            if (run.imported) run.imported = advanceGhost(run.imported);
            if (wasFalling && run.state.vy > 0) {
              sound.current?.play("impact");
              if (!live.current.reducedMotion) spawnBurst(run.particles, run.state.x, run.state.height, NEON, 7);
            }
            if (run.state.stars > previousStars) {
              sound.current?.play("reward");
              if (!live.current.reducedMotion) {
                // Shows the actual points this landing earned, combo bonus included, not a fixed +25 — the
                // combo streak that drove it is spelled out right alongside so the bonus isn't a mystery.
                const gained = run.state.starPoints - previousStarPoints;
                const comboSuffix = run.state.comboStreak > 1 ? ` combo x${run.state.comboStreak}` : "";
                run.popups.push({ x: run.state.x, y: run.state.height + 50, life: 0.9, text: `+${gained}${comboSuffix}` });
                spawnBurst(run.particles, run.state.x, run.state.height + 10, NEON, 10);
                run.starFlash = 1;
              }
            }
            // Power-up pickups and the drone hit all read as "this field just went from off to on" rather than
            // needing their own extra RunState flags — simple, and it can never miss or double-fire since
            // exactly one physics tick is where that transition happens.
            if (run.state.rocketTicks > 0 && previousRocket === 0) {
              sound.current?.play("reward");
              if (!live.current.reducedMotion) run.popups.push({ x: run.state.x, y: run.state.height + 40, life: 1, text: "ROCKET" });
            }
            if (run.state.shield && !previousShield) {
              sound.current?.play("reward");
              if (!live.current.reducedMotion) run.popups.push({ x: run.state.x, y: run.state.height + 40, life: 1, text: "SHIELD" });
            }
            if (run.state.magnetTicks > 0 && previousMagnet === 0) {
              sound.current?.play("reward");
              if (!live.current.reducedMotion) run.popups.push({ x: run.state.x, y: run.state.height + 40, life: 1, text: "MAGNET" });
            }
            if (previousShield && !run.state.shield && run.state.alive) {
              // The shield just spent itself to cancel an otherwise-fatal fall — distinct from a normal pickup.
              sound.current?.play("impact");
              if (!live.current.reducedMotion) run.popups.push({ x: run.state.x, y: run.state.height + 40, life: 1, text: "SAVED" });
              if (!live.current.reducedMotion && live.current.fxOn) run.shake = 1;
            }
            if (run.state.droneCooldown > 0 && previousCooldown === 0) {
              sound.current?.play("impact", { volume: 0.8 });
              if (!live.current.reducedMotion && live.current.fxOn) { run.shake = 1; run.hitFlash = 1; }
            }
            // Purely presentational milestone banner/zone tint, every MILESTONE_STEP points of the same
            // score the HUD shows ("Score N") — strictly in sync with it, not a separate height or distance
            // reading, since that was confusing (a "100!" banner next to a HUD reading a different number).
            const zone = Math.floor(scoreOf(run.state) / MILESTONE_STEP);
            if (zone > run.milestoneZone) { run.milestoneZone = zone; run.milestoneFlash = 1; sound.current?.play("reward"); }
            // Announces each wave's ~1.5s warning window exactly once (per wave, via lastWaveWarned), not
            // every frame chaseWaveFloor's `warning` flag happens to read true.
            if (run.rules.chase && run.state.waveIndex > run.lastWaveWarned) {
              const wave = chaseWaveFloor(run.state.waveIndex, run.state.waveTriggerTick, run.state.waveBaseHeight, run.state.tick);
              if (wave.warning) {
                run.lastWaveWarned = run.state.waveIndex; run.lavaFlash = 1;
                if (music.current.ctx && live.current.fxOn && !live.current.muted) playLavaWarning(music.current.ctx);
              }
            }
            if (!run.state.alive && run.state.summited) {
              // A win, not a fall: a reward sound and a bright (not shaking) flash — reusing the same
              // run.hitFlash field for the full-canvas pulse, but never run.shake, which is specifically a
              // "something hit you" cue and would read as a disaster right when the player just won.
              sound.current?.play("reward");
              if (!live.current.reducedMotion && live.current.fxOn) run.hitFlash = 1;
            } else if (!run.state.alive) {
              sound.current?.play("impact", { volume: 0.7 });
              if (!live.current.reducedMotion && live.current.fxOn) { run.shake = 1; run.hitFlash = 1; }
            }
          }
          if (!run.state.alive) endGame(run.state);
        }
        // The chase wave's current floor, computed once per frame and reused by both the music urgency below
        // and the camera/lava rendering further down, so none of the three can ever read a different moment
        // of the same wave from each other.
        const chaseFloor = run?.rules.chase ? chaseWaveFloor(run.state.waveIndex, run.state.waveTriggerTick, run.state.waveBaseHeight, run.state.tick).floor : -Infinity;
        // Procedural music: schedules the next beat whenever it's due, tempo/intensity tied to the current
        // chase wave's own urgency (0 outside a wave, ramping up while one is rising) — never gated by
        // reducedMotion, since this is audio, not an on-screen effect; only by the Music & FX toggle and the
        // existing mute button. See the layer functions' own comments for what joins in when.
        if (run && active && run.state.alive && live.current.fxOn && !live.current.muted && music.current.ctx && now >= music.current.nextNoteAt) {
          const ctx = music.current.ctx, beat = music.current.noteIndex;
          const urgency = run.rules.chase ? chaseWaveUrgency(run.state.waveIndex, run.state.waveTriggerTick, run.state.tick) : 0;
          playMusicNote(ctx, MUSIC_SCALE[beat % MUSIC_SCALE.length], urgency);
          if (beat % 2 === 0) playBassNote(ctx, BASS_NOTES[Math.floor(beat / 2) % BASS_NOTES.length], urgency);
          if (run.state.peakHeight > 40) {
            if (!music.current.noiseBuffer) music.current.noiseBuffer = buildNoiseBuffer(ctx);
            if (beat % 2 === 0) playKick(ctx); else playHihat(ctx, music.current.noiseBuffer);
          }
          music.current.noteIndex = beat + 1;
          music.current.nextNoteAt = now + (420 - 220 * urgency);
        }
        // The camera's world-height reference is the run's own peakHeight, read directly every frame — no
        // easing, no lag. peakHeight only ever increases (tower.ts's own monotonic high-water mark), so this
        // is already smooth during a climb and simply holds still while falling; see CAMERA_ANCHOR's comment
        // above for why only this exact, undamped formula keeps the screen's bottom edge on the death line.
        // With the chase on, the same bottom-edge-is-the-death-line property has to hold against WHICHEVER of
        // FALL_MARGIN or the chase wave is currently stricter — substituting floor = max(peakHeight -
        // FALL_MARGIN, chaseFloor) into the same derivation gives cameraReference = max(peakHeight, chaseFloor
        // + FALL_MARGIN): exactly peakHeight whenever FALL_MARGIN is still the binding constraint (true
        // whenever no wave is active, chaseFloor being -Infinity then), but pulled up to track the rising
        // lava once a wave overtakes it, so the screen keeps reading "this far below you is the end"
        // accurately even when that line is the chase, not the ordinary trailing margin.
        const cameraReference = run ? Math.max(run.state.peakHeight, chaseFloor + FALL_MARGIN) : 0;
        const toScreenY = (height: number) => CAMERA_ANCHOR - (height - cameraReference);

        const motion = !live.current.reducedMotion;
        ctx.clearRect(0, 0, VIEW.width, VIEW.height);
        const zoneIndex = run ? Math.floor(scoreOf(run.state) / MILESTONE_STEP) : 0;
        ctx.fillStyle = ZONE_BACKGROUNDS[zoneIndex % ZONE_BACKGROUNDS.length]; ctx.fillRect(0, 0, VIEW.width, VIEW.height);

        // Screen shake: a small, rapidly-decaying random offset applied to everything drawn below, via one
        // ctx.translate rather than touching every draw call's own coordinates. Decoupled from motion-reduced
        // particles/squash on purpose, since the user asked specifically for "no shake under reduced motion" —
        // run.shake is simply never set above when live.current.reducedMotion is true, so this is a no-op then.
        if (run && run.shake > 0) {
          run.shake = Math.max(0, run.shake - dt / 0.3);
          const magnitude = 6 * run.shake;
          ctx.save();
          ctx.translate((Math.random() * 2 - 1) * magnitude, (Math.random() * 2 - 1) * magnitude);
        }

        if (motion && run) {
          // Parallax: a stable, deterministic star field (never re-randomized — see starsBetween) plus a
          // ground skyline that fades out as the camera climbs away from it. Reduced motion skips both: a
          // still dark lane reads just as clearly and this is the only truly optional layer per frame.
          const topHeight = run.state.peakHeight + VIEW.height - CAMERA_ANCHOR, bottomHeight = run.state.peakHeight - CAMERA_ANCHOR;
          ctx.fillStyle = "#fff"; ctx.globalAlpha = 0.5;
          for (const star of starsBetween(topHeight, bottomHeight, VIEW.width)) {
            const y = toScreenY(star.y); starPath(ctx, star.x, y, star.size * 1.6, star.size * 0.7); ctx.fill();
          }
          ctx.globalAlpha = 1;
          const skylineFade = Math.max(0, 1 - run.state.peakHeight / 900);
          if (skylineFade > 0.02) {
            ctx.globalAlpha = skylineFade * 0.8; ctx.fillStyle = "#0e140a";
            drawSkyline(ctx, toScreenY, VIEW.width);
            ctx.globalAlpha = 1;
          }
        }

        ctx.strokeStyle = "rgba(204,255,0,0.25)"; ctx.lineWidth = 6; ctx.strokeRect(LANE_MARGIN, 0, WORLD_WIDTH, VIEW.height);
        ctx.strokeStyle = NEON; ctx.lineWidth = 2; ctx.strokeRect(LANE_MARGIN, 0, WORLD_WIDTH, VIEW.height);
        // The lane wraps left-right (see tower.ts); these chevrons mark both edges as a portal, not a wall,
        // at a few fixed screen heights so at least one pair stays visible regardless of how far the camera
        // has scrolled. wrappedScreenXs() is what actually draws the Friend/ghosts again on the far side.
        ctx.fillStyle = NEON; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
        for (const chevronY of [VIEW.height * 0.22, VIEW.height * 0.5, VIEW.height * 0.78]) {
          for (const side of [-1, 1] as const) {
            const edgeX = side === -1 ? LANE_MARGIN : LANE_MARGIN + WORLD_WIDTH;
            ctx.beginPath();
            ctx.moveTo(edgeX - side * 9, chevronY - 7); ctx.lineTo(edgeX + side * 2, chevronY); ctx.lineTo(edgeX - side * 9, chevronY + 7);
            ctx.closePath(); ctx.fill(); ctx.stroke();
          }
        }
        if (run) {
          run.tower.platforms.forEach((platform, index) => {
            if (run.state.broken.has(index)) return;
            const y = toScreenY(platform.height);
            if (y < -20 || y > VIEW.height + 20) return;
            const left = LANE_MARGIN + platform.x - platform.width / 2;
            if (platform.breaking) { ctx.fillStyle = hazardPattern; ctx.strokeStyle = NEON; }
            else { ctx.fillStyle = "#111"; ctx.strokeStyle = motion ? "rgba(204,255,0,0.35)" : NEON; }
            if (motion && !platform.breaking) { ctx.lineWidth = 5; ctx.beginPath(); ctx.roundRect(left, y - 6, platform.width, 10, 4); ctx.stroke(); }
            ctx.strokeStyle = NEON; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.roundRect(left, y - 6, platform.width, 10, 4); ctx.fill(); ctx.stroke();
            // A spring is reusable (every bounce off it launches higher, not just the first), so it is marked
            // right on the platform itself, not gated by any collected-state the way a one-shot star is.
            if (platform.spring) {
              ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
              ctx.beginPath();
              const zigzagLeft = left + 6, zigzagWidth = platform.width - 12;
              ctx.moveTo(zigzagLeft, y);
              for (let step = 0; step < 4; step++) ctx.lineTo(zigzagLeft + zigzagWidth * (step + 1) / 4, y + (step % 2 === 0 ? -4 : 4));
              ctx.stroke();
            }
            // Gone once the live player's own run has it — run.state.starsCollected, not platform.star alone,
            // which never changes and used to leave every star showing forever, already collected or not.
            if (platform.star && !run.state.starsCollected.has(index)) {
              if (motion) ctx.drawImage(glowDot, LANE_MARGIN + platform.x - 16, y - 32, 32, 32);
              ctx.fillStyle = NEON; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
              starPath(ctx, LANE_MARGIN + platform.x, y - 16, 8, 3.5); ctx.fill(); ctx.stroke();
            }
            // Power-ups are reusable, like a spring (every landing re-triggers them) — see tower.ts's step —
            // so there is no "collected" gate here, only rules.powerups itself: when that toggle is off, a
            // run never picks these up, so showing the glyph would be actively misleading.
            if (platform.powerup && run.rules.powerups) {
              const px = LANE_MARGIN + platform.x, py = y - 17;
              ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.fillStyle = NEON;
              if (platform.powerup === "rocket") {
                ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px + 5, py + 5); ctx.lineTo(px - 5, py + 5);
                ctx.closePath(); ctx.fill(); ctx.stroke();
              } else if (platform.powerup === "shield") {
                ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
              } else {
                ctx.beginPath(); ctx.arc(px, py, 6, 0.25 * Math.PI, 1.75 * Math.PI); ctx.lineWidth = 3; ctx.strokeStyle = NEON; ctx.stroke();
                ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
              }
            }
          });
          // Drones: drawn only when the toggle that makes them actually dangerous is on — a visible-but-harmless
          // drone would just be confusing clutter, the opposite of what a toggle for comparing mechanics needs.
          if (run.rules.drones) {
            for (const drone of run.tower.drones) {
              const y = toScreenY(drone.height);
              if (y < -20 || y > VIEW.height + 20) continue;
              // The one-shot "first drone spotted" alert uses the strict on-screen bounds (not the wider
              // culling padding just above), so it fires right as a drone genuinely becomes visible, not
              // slightly before — a short, distinct sting, not a repeating per-drone sound.
              if (!run.droneSpotted && y >= 0 && y <= VIEW.height) {
                run.droneSpotted = true;
                if (music.current.ctx && live.current.fxOn && !live.current.muted) playDroneAlert(music.current.ctx);
              }
              const dx = LANE_MARGIN + droneX(drone, run.state.tick);
              ctx.fillStyle = "#111"; ctx.strokeStyle = NEON; ctx.lineWidth = 2;
              ctx.beginPath(); ctx.roundRect(dx - DRONE_RADIUS, y - DRONE_RADIUS * 0.6, DRONE_RADIUS * 2, DRONE_RADIUS * 1.2, 4);
              ctx.fill(); ctx.stroke();
              ctx.fillStyle = run.state.droneCooldown > 0 ? "rgba(204,255,0,0.4)" : NEON;
              ctx.beginPath(); ctx.arc(dx, y, 3, 0, Math.PI * 2); ctx.fill();
            }
          }
          for (const ghost of [run.bot, run.imported, ...run.own].filter((value): value is Ghost => Boolean(value))) {
            if (!ghost.state.alive) continue;
            const y = toScreenY(ghost.state.height);
            if (y < -10 || y > VIEW.height + 10) continue;
            for (const x of wrappedScreenXs(ghost.state.x, LANE_MARGIN)) {
              // A ghost's own short flash when its own replay collects a star — from its own starFlash, which
              // tracks its own state.stars, never the live player's (see advanceGhost).
              if (motion && ghost.starFlash > 0) {
                const flashSize = 60 * (1.4 - ghost.starFlash);
                ctx.globalAlpha = ghost.starFlash * 0.6;
                ctx.drawImage(glowDot, x - flashSize / 2, y - flashSize / 2, flashSize, flashSize);
                ctx.globalAlpha = 1;
              }
              ctx.strokeStyle = ghost.color; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
              ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS * 0.9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
              ctx.fillStyle = ghost.color; ctx.font = "9px monospace"; ctx.textAlign = "center"; ctx.fillText(ghost.label, x, y - 16);
            }
          }
          if (motion) {
            for (let index = run.particles.length - 1; index >= 0; index--) {
              const particle = run.particles[index]; particle.life -= dt; particle.vy -= 500 * dt;
              particle.x += particle.vx * dt; particle.y += particle.vy * dt;
              if (particle.life <= 0) { run.particles.splice(index, 1); continue; }
              const size = 10 * Math.max(0, particle.life / 0.4);
              ctx.globalAlpha = Math.max(0, particle.life / 0.4);
              ctx.drawImage(glowDot, LANE_MARGIN + particle.x - size / 2, toScreenY(particle.y) - size / 2, size, size);
            }
            ctx.globalAlpha = 1;
            if (run.starFlash > 0) {
              run.starFlash = Math.max(0, run.starFlash - dt / 0.3);
              const flashSize = 90 * (1.4 - run.starFlash);
              ctx.globalAlpha = run.starFlash * 0.8;
              ctx.drawImage(glowDot, LANE_MARGIN + run.state.x - flashSize / 2, toScreenY(run.state.height) - flashSize / 2, flashSize, flashSize);
              ctx.globalAlpha = 1;
            }
          }
          const stretch = motion ? Math.max(0.78, Math.min(1.22, 1 + run.state.vy / 2600)) : 1;
          const facing = run.lastDir === -1 ? "left" : "right";
          if (!playerSprites.has(facing)) playerSprites.set(facing, buildPlayerSprite(spriteFrame(sprites, facing, false, 0, facing).frame.rows));
          const sprite = playerSprites.get(facing)!, half = sprite.width / 2;
          for (const x of wrappedScreenXs(run.state.x, LANE_MARGIN)) {
            // Lines the 16x16 mask back up with where the old, unpadded sprite used to sit on screen (bottom
            // near y + 5); the extra PLAYER_SPRITE_PAD on every side is just the glow halo's canvas, not more body.
            const y = toScreenY(run.state.height), top = y - 75 * stretch - PLAYER_SPRITE_PAD;
            ctx.save(); ctx.translate(x, top); ctx.scale(1, stretch);
            ctx.drawImage(sprite, -half, 0);
            ctx.restore();
          }
          if (motion) {
            for (let index = run.popups.length - 1; index >= 0; index--) {
              const popup = run.popups[index]; popup.life -= dt; popup.y += 40 * dt;
              if (popup.life <= 0) { run.popups.splice(index, 1); continue; }
              ctx.globalAlpha = Math.min(1, popup.life / 0.3); ctx.fillStyle = NEON;
              ctx.font = "bold 16px monospace"; ctx.textAlign = "center";
              ctx.fillText(popup.text, LANE_MARGIN + popup.x, toScreenY(popup.y));
              ctx.globalAlpha = 1;
            }
          }
          // An announcement, not a decorative effect, so it still shows with reduced motion on — only its
          // fade timing depends on dt either way. A brief, bright pop (never fully opaque, and under a
          // second total) rather than a lingering block of text, so it reads as a flash and never meaningfully
          // hides a platform underneath it for long enough to matter.
          if (run.milestoneFlash > 0) {
            const fontSize = 34 + 10 * run.milestoneFlash;
            ctx.globalAlpha = Math.min(0.85, run.milestoneFlash * 1.2);
            ctx.fillStyle = NEON; ctx.strokeStyle = "#000"; ctx.lineWidth = 4;
            ctx.font = `bold ${fontSize}px monospace`; ctx.textAlign = "center";
            const text = `${run.milestoneZone * MILESTONE_STEP}!`;
            ctx.strokeText(text, VIEW.width / 2, VIEW.height * 0.3);
            ctx.fillText(text, VIEW.width / 2, VIEW.height * 0.3);
            ctx.globalAlpha = 1;
            run.milestoneFlash = Math.max(0, run.milestoneFlash - dt / 0.9);
          }
          // Each wave's own warning — a longer-held, lower banner than the milestone pop above (it is a
          // genuine threat announcement, not a score celebration), so the two never visually compete even
          // though a wave's trigger is the exact same milestone crossing that pops the banner above it.
          if (run.lavaFlash > 0) {
            ctx.globalAlpha = Math.min(0.9, run.lavaFlash * 1.3);
            ctx.fillStyle = NEON; ctx.strokeStyle = "#000"; ctx.lineWidth = 4;
            ctx.font = "bold 26px monospace"; ctx.textAlign = "center";
            ctx.strokeText("LAVA SURGE!", VIEW.width / 2, VIEW.height * 0.42);
            ctx.fillText("LAVA SURGE!", VIEW.width / 2, VIEW.height * 0.42);
            ctx.globalAlpha = 1;
            run.lavaFlash = Math.max(0, run.lavaFlash - dt / 1.8);
          }
          if (run.rules.chase) {
            // The chase itself IS the death boundary whenever it is ahead of FALL_MARGIN (see cameraReference
            // above), so its screen position is exactly toScreenY(chaseFloor) — never a separate guess. Drawn
            // as a rising, filled "lava" with a wavy top edge (a few sine-offset points, animated by `now` so
            // it visibly churns) rather than a thin line, since the whole point is that it must always read as
            // an advancing, unmissable threat, not a subtle gradient at the very edge of the screen.
            const lavaY = Math.min(VIEW.height + 40, toScreenY(chaseFloor));
            if (lavaY < VIEW.height + 40) {
              const waveAmplitude = motion ? 4 : 0, waveSpeed = now / 220;
              ctx.beginPath(); ctx.moveTo(0, VIEW.height + 2);
              ctx.lineTo(0, lavaY + Math.sin(waveSpeed) * waveAmplitude);
              const steps = 10;
              for (let index = 0; index <= steps; index++) {
                const wx = (VIEW.width / steps) * index;
                ctx.lineTo(wx, lavaY + Math.sin(waveSpeed + index * 0.9) * waveAmplitude);
              }
              ctx.lineTo(VIEW.width, VIEW.height + 2); ctx.closePath();
              const lava = ctx.createLinearGradient(0, lavaY - 20, 0, VIEW.height + 2);
              lava.addColorStop(0, "rgba(204,255,0,0.85)"); lava.addColorStop(0.3, "rgba(10,20,6,0.95)"); lava.addColorStop(1, "#060606");
              ctx.fillStyle = lava; ctx.fill();
              ctx.strokeStyle = NEON; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
              ctx.beginPath();
              for (let index = 0; index <= steps; index++) {
                const wx = (VIEW.width / steps) * index, wy = lavaY + Math.sin(waveSpeed + index * 0.9) * waveAmplitude;
                if (index === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
              }
              ctx.stroke(); ctx.globalAlpha = 1;
            }
          } else {
            // No chase: the plain FALL_MARGIN death boundary, same as before — with CAMERA_ANCHOR derived from
            // FALL_MARGIN, height == peakHeight - FALL_MARGIN always maps to exactly VIEW.height, the very
            // bottom row of the canvas, so this fixed-position band IS the death line, not an approximation.
            const fogHeight = 70;
            const fog = ctx.createLinearGradient(0, VIEW.height - fogHeight, 0, VIEW.height);
            fog.addColorStop(0, "rgba(6,6,6,0)"); fog.addColorStop(1, "rgba(6,6,6,0.55)");
            ctx.fillStyle = fog; ctx.fillRect(0, VIEW.height - fogHeight, VIEW.width, fogHeight);
            ctx.strokeStyle = NEON; ctx.globalAlpha = 0.7; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(0, VIEW.height - 2); ctx.lineTo(VIEW.width, VIEW.height - 2); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        if (run && run.shake > 0) ctx.restore(); // matches the ctx.save()+translate opened above, before any of this frame's world drawing
        if (run && run.hitFlash > 0) {
          // A brief full-canvas color flash on a hit/death, drawn in fixed screen space (after the shake's own
          // restore above) so it never gets an edge gap from the shake offset.
          run.hitFlash = Math.max(0, run.hitFlash - dt / 0.25);
          ctx.globalAlpha = run.hitFlash * 0.5; ctx.fillStyle = "#eafff0";
          ctx.fillRect(0, 0, VIEW.width, VIEW.height); ctx.globalAlpha = 1;
        }
        // ~10 updates/second is plenty for a number that only needs to look alive, and far cheaper than a
        // React re-render on every one of these (up to 60/second).
        if (scoreLabel.current && now - lastHudUpdate > 100) {
          lastHudUpdate = now;
          // Score, not height, is what the HUD leads with: a star's +25 popup used to look like it vanished
          // because only the (unrelated-looking) star count ticked up — showing the number the popup actually
          // added to makes the payoff visible immediately, the same number the result screen settles on.
          scoreLabel.current.textContent = `Score ${run ? scoreOf(run.state) : 0} · ★${run ? run.state.stars : 0}`;
          // Race HUD: rank among every ghost sharing the screen right now (bot + own past runs + any pasted
          // code) plus a direct delta against the bot specifically, since the bot is always present and is
          // the one opponent every player has in common — purely presentational, never read by tower.ts.
          if (raceLabel.current) {
            if (run && live.current.raceHudOn) {
              const ghosts = [run.bot, run.imported, ...run.own].filter((value): value is Ghost => Boolean(value));
              const you = scoreOf(run.state), botScore = scoreOf(run.bot.state);
              const ranked = [you, ...ghosts.map(ghost => scoreOf(ghost.state))].sort((a, b) => b - a);
              const rank = ranked.indexOf(you) + 1;
              const delta = you - botScore;
              const place = rank === 1 ? "1st" : rank === 2 ? "2nd" : rank === 3 ? "3rd" : `${rank}th`;
              raceLabel.current.textContent = `${place} of ${ranked.length} · bot ${delta >= 0 ? "+" : ""}${delta}`;
            } else {
              raceLabel.current.textContent = "";
            }
          }
        }
        node.dataset.x = run ? run.state.x.toFixed(1) : "";
        node.dataset.height = run ? run.state.height.toFixed(1) : "0";
        node.dataset.score = run ? String(scoreOf(run.state)) : "0";
        node.dataset.screen = live.current.screen;
        // Direct physics truth, not routed through React's own screen state the way data-screen is above —
        // endGame() calls setScreen("result") the same frame the physics loop detects death, but live.current
        // (and so data-screen) only updates on React's NEXT render, one or more frames later. A test sampling
        // right at that boundary needs this to tell "still truly alive" from "about to show as dead" without
        // that lag — data-screen alone can read "play" for a frame or more after run.state.alive already
        // flipped false.
        node.dataset.alive = run ? String(run.state.alive) : "";
        // Lets check-browser.mjs catch "the camera lost the Friend" without reading pixels: the Friend must
        // always be within the visible canvas while a run is alive, never scrolled off by a stale camera.
        node.dataset.playerScreenY = run ? toScreenY(run.state.height).toFixed(1) : "";
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => { if (!cancelled) { setFailed(true); setStatus("Your Friend's artwork could not load. Check your connection and retry."); } });
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", stop);
    // Listened on the game's own document, not just the canvas: a keypress right after clicking "Tower of
    // the day"/"Practice" used to do nothing until the player also clicked the canvas itself, since only the
    // canvas's own onKeyDown ever saw the event. Gated on the same conditions as sceneBlocked (via the live
    // ref, so it always reads the current values, not whatever was true when this effect first ran) so a
    // keypress is never captured while a menu is open or the run isn't actually playing — keyup always goes
    // through regardless, so a key released while a menu happens to be open can't get stuck held down.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (live.current.paused || live.current.menu !== null || live.current.screen !== "play") return;
      // event.code names the physical key, not the character it types, so steering works on any keyboard
      // layout — on a Cyrillic layout, for instance, the "A"/"D" keys still report "KeyA"/"KeyD".
      if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(event.code)) { event.preventDefault(); heldKeys.current.add(event.code); }
    };
    const handleKeyUp = (event: KeyboardEvent) => { heldKeys.current.delete(event.code); };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      cancelled = true; cancelAnimationFrame(frame); stop(); resizeObserver.disconnect();
      window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop);
      document.removeEventListener("keydown", handleKeyDown); document.removeEventListener("keyup", handleKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendId, revision]);

  async function copyCode(code: string) {
    try {
      if (!navigator.clipboard) throw new Error("No Clipboard API");
      await navigator.clipboard.writeText(code); setCopyFailed(false);
    } catch { setCopyFailed(true); } // the sandboxed frame may not grant clipboard access; the code stays in a field to select by hand
  }
  function loadImportedCode() {
    try {
      const decoded = decodeRun(importCode);
      setImportedGhost({ seed: decoded.seed, transitions: decoded.transitions, score: decoded.claimedScore, rules: decoded.rules });
      setImportError(decoded.seed === seed ? "" : "That code is from a different tower; pick the matching tower to race it.");
    } catch (error) { setImportError(error instanceof Error ? error.message : "That code could not be read."); }
  }

  const sceneBlocked = paused || menu !== null || screen !== "play" || Boolean(status);
  // A keypress works without ever clicking the canvas (see the document-level listener above), but focus
  // still matters for touch/assistive tech and for the canvas's own aria-label to be announced — moving it
  // here, keyed on sceneBlocked itself, covers both "Tower of the day"/"Practice" (a mouse click) and
  // starting via Enter/Space on a focused button (keyboard), not just one of the two.
  useEffect(() => { if (!sceneBlocked) canvas.current?.focus(); }, [sceneBlocked]);
  return <section className="fc-game" aria-label="Friend Climb">
    <div className="fc-top" inert={paused || undefined}>
      {screen === "play" ? <span ref={scoreLabel}>Score 0</span> : <span>Friend Climb</span>}
      {screen === "play" && raceHudOn && <span ref={raceLabel} style={{ marginRight: 0 }} />}
      <button type="button" aria-pressed={!muted} disabled={Boolean(status)} onClick={() => {
        const next = !muted; setMuted(next); sound.current?.setMuted(next);
        if (!next) {
          void sound.current?.unlock();
          // Same user-gesture requirement as the SDK's own sound kit — created once, on the first unmute.
          if (!music.current.ctx) music.current.ctx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        }
      }}>{muted ? "Sound off" : "Sound on"}</button>
      <button type="button" disabled={Boolean(status)} onClick={() => setMenu("settings")}>Settings</button>
    </div>

    <div className="fc-scene" inert={sceneBlocked || undefined}>
      {/* width/height are a placeholder default; the effect's ResizeObserver sets the real backing-store size
          to exactly match the frame's actual aspect ratio as soon as it mounts. */}
      <canvas ref={canvas} width={Math.round(REFERENCE_HEIGHT * 0.75)} height={REFERENCE_HEIGHT} tabIndex={sceneBlocked ? -1 : 0}
        aria-label="Climbing tower. Arrow keys or A/D to steer, or hold either side of the tower to steer there."
        // Keyboard steering is handled on the document itself (see the main effect), not here — focus is
        // nice to have (see startGame's canvas.current?.focus()) but, unlike before, no longer required for
        // the keyboard to work, so losing it must not stop the run either.
        onPointerDown={event => { if (sceneBlocked) return; event.preventDefault(); event.currentTarget.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          heldPointer.current = (event.clientX - rect.left) / rect.width < 0.5 ? -1 : 1; }}
        onPointerUp={() => { heldPointer.current = null; }} onPointerCancel={() => { heldPointer.current = null; }} />
      {screen === "play" && !status && isFirstRun && <p className="fc-hint fc-star-hint">Land on a star for +{STAR_POINTS}</p>}
      {screen === "play" && !status && controlHintVisible && <p className="fc-hint"><span className="fc-desktop-controls">Arrow keys or A/D · </span>Hold either side of the tower</p>}
    </div>

    {status && <div className="fc-status" role={failed ? "alert" : "status"}><p>{status}</p>
      {failed && <button type="button" disabled={paused} onClick={() => setRevision(value => value + 1)}>Retry loading</button>}</div>}

    {!status && screen === "pick" && <div className="fc-pick">
      <h1>Friend Climb</h1>
      <p>Your Friend bounces up a tower on its own; you only steer left and right. The lane wraps — walk off one
        side and you reappear on the other. Watch the ghosts, and see how high you get.</p>
      <p>Land on a star for +{STAR_POINTS}; chain stars with no plain landing between for a growing combo bonus.
        Zigzag-marked platforms are springs — they launch you higher than a normal bounce.</p>
      <button type="button" disabled={paused} onClick={() => startGame(todaySeed())}>Tower of the day</button>
      <button type="button" disabled={paused} onClick={() => startGame(platform.randomness.nextSeed())}>Practice (new tower)</button>
      <p className="fc-note">Progress and ghosts last only for this open session — closing or reloading the page clears them. There is no save yet.</p>
      <label className="fc-import">
        Race a friend's code
        <input value={importCode} onChange={event => setImportCode(event.target.value)} placeholder="FC6...." disabled={paused} />
        <button type="button" disabled={paused || !importCode} onClick={loadImportedCode}>Load</button>
      </label>
      {importError && <p role="alert">{importError}</p>}
      {importedGhost && !importError && <p>Loaded a code for tower #{importedGhost.seed.toString(36)}. Start that tower to race it (today's tower and practice towers use different seeds).</p>}
    </div>}

    {!status && screen === "result" && <div className="fc-result">
      {lastSummited && <h1 className="fc-summit">SUMMIT!</h1>}
      <h1>Score: {lastScore}</h1>
      {lastSummited && <p>Reached the summit in {formatClimbTime(lastClimbTicks)} — the deterministic climb time encoded right alongside the score, same as everything else here.</p>}
      <p>Height {lastHeightPoints} + {lastStars} star{lastStars === 1 ? "" : "s"} ({lastStarPoints}) = {lastScore}</p>
      <p>Best this session on this tower: {best[seed] ?? lastScore}. Progress resets when this page reloads.</p>
      <button type="button" disabled={paused} onClick={() => startGame(seed)}>Play this tower again</button>
      <button type="button" disabled={paused} onClick={() => setScreen("pick")}>Back</button>
      <label className="fc-import">
        Run code to share
        <input readOnly value={lastCode} onFocus={event => event.currentTarget.select()} />
        <button type="button" disabled={paused} onClick={() => copyCode(lastCode)}>Copy</button>
      </label>
      {copyFailed && <p role="status">Copying is not available here — select the code above and copy it by hand.</p>}
    </div>}

    {menu === "settings" && <GameMenu title="Settings" onClose={() => setMenu(null)}>
      {/* Kept deliberately short: the SDK's own Settings dialog cannot be given a safe-zone the way this
          game's own screens were (see style.css's --fc-safe-zone comment) — its content simply has to stay
          short enough not to reach the SDK toolbar's region in the first place, on any screen size. */}
      <label><input type="checkbox" checked={reducedMotion} disabled={paused} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
      <label><input type="checkbox" checked={chaseOn} disabled={paused} onChange={event => setChaseOn(event.target.checked)} /> Chase</label>
      <label><input type="checkbox" checked={dronesOn} disabled={paused} onChange={event => setDronesOn(event.target.checked)} /> Drones</label>
      <label><input type="checkbox" checked={powerupsOn} disabled={paused} onChange={event => setPowerupsOn(event.target.checked)} /> Power-ups</label>
      <label><input type="checkbox" checked={raceHudOn} disabled={paused} onChange={event => setRaceHudOn(event.target.checked)} /> Race HUD</label>
      <label><input type="checkbox" checked={fxOn} disabled={paused} onChange={event => setFxOn(event.target.checked)} /> Music &amp; FX</label>
      <p className="fc-note">Each toggle is snapshotted into the run and its FC6 code, so a replay always matches how it was recorded.</p>
      <button type="button" disabled={paused} onClick={() => setMenu(null)}>Back</button>
    </GameMenu>}
  </section>;
}
