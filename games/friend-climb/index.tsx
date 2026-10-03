"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, spriteFrame } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";
import {
  DT, WORLD_WIDTH, PLAYER_RADIUS, HEIGHT_PER_POINT, STAR_POINTS,
  type Dir, type Tower, type RunState, type Transition,
  seedForDate, generateTower, startRun, step, scoreOf, botRun, encodeRun, decodeRun,
} from "./tower";

// The canvas's backing store always matches the SDK frame's actual CSS aspect ratio exactly (see the
// ResizeObserver below) — the whole point is that there is never a gap on any side to letterbox. Only the
// width varies by frame shape; the height stays fixed at this reference so the *amount* of tower visible,
// the camera and the physics constants tuned against it never depend on the screen size.
const REFERENCE_HEIGHT = 640;
// Between two platforms the Friend's real height naturally dips below the last peak by as much as FALL_MARGIN
// (losing more than that ends the run) before the next bounce resets it — so the anchor needs that much room
// below it on screen, not just room above it for the camera's climb lag, or an ordinary mid-run dip pushes the
// Friend toward the bottom edge even though nothing is wrong.
const CAMERA_ANCHOR = REFERENCE_HEIGHT * 0.34;
/** How quickly the camera's world-height reference catches up to the Friend's highest point. Exponential
 * smoothing: with a constant climb speed v, the camera settles to a steady lag of v / CAMERA_CATCH_UP_RATE
 * world units behind the peak. The fastest sustained climb measured in tower.test.mjs's bot runs is well
 * under 400 units/s, so this keeps the lag under roughly 100px — nowhere near falling off the top of a
 * 640px-tall view. See the render loop for the one line that actually applies it. */
const CAMERA_CATCH_UP_RATE = 4;
/** The whole scene stays inside this three-color palette: black, white and Rare Friends' signal green. */
const NEON = "#ccff00";
const todaySeed = () => seedForDate(new Date().toISOString().slice(0, 10));
const randomSeed = () => { const words = new Uint32Array(1); crypto.getRandomValues(words); return words[0]; };

type Ghost = Readonly<{ label: string; color: string; tower: Tower; transitions: readonly Transition[]; dir: Dir; state: RunState; index: number; starFlash: number }>;
type RunRecord = Readonly<{ seed: number; transitions: readonly Transition[]; score: number }>;
type Screen = "pick" | "play" | "result";
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
type Popup = { x: number; y: number; life: number; text: string };

function makeGhost(label: string, color: string, tower: Tower, transitions: readonly Transition[]): Ghost {
  return { label, color, tower, transitions, dir: 0, state: startRun(), index: 0, starFlash: 0 };
}
/** A ghost is its own independent replay — tower.ts tracks its starsCollected separately from the live
 * player's, exactly like two different runs of the same tower naturally would — so its own star flash fires
 * from its own state, never the player's, even when a ghost is standing right where the player is. */
function advanceGhost(ghost: Ghost): Ghost {
  if (!ghost.state.alive) return { ...ghost, starFlash: Math.max(0, ghost.starFlash - DT / 0.3) };
  let { dir, index } = ghost;
  while (index < ghost.transitions.length && ghost.transitions[index].tick <= ghost.state.tick) { dir = ghost.transitions[index].dir; index++; }
  const previousStars = ghost.state.stars, state = step(ghost.tower, ghost.state, dir);
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
function spawnBurst(particles: Particle[], x: number, y: number, color: string, count: number) {
  for (let index = 0; index < count; index++) {
    const angle = Math.PI * (0.15 + 0.7 * Math.random());
    particles.push({ x, y, vx: Math.cos(angle) * 90 * (Math.random() - 0.5) * 2, vy: Math.sin(angle) * 90, life: 0.4, color });
  }
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

/** Height-point multiples at which a milestone banner fires and the background tint shifts; purely
 * presentational — never read by tower.ts, so it cannot affect score or determinism. */
const MILESTONE_STEP = 100;
/** Cycled by zone index for a barely-perceptible background shift every MILESTONE_STEP height-points — stays
 * inside the dark/near-black register the Arcade Neon palette calls for, not a new bright hue. */
const ZONE_BACKGROUNDS: readonly string[] = ["#060606", "#06090a", "#060a07", "#0a0906", "#090609"];

type Run = {
  tower: Tower; state: RunState; transitions: Transition[]; lastDir: Dir; bot: Ghost; own: Ghost[]; imported: Ghost | null;
  // Per-run camera/particle state. These used to live outside the Run object and never reset between games,
  // so a second run started after climbing high in the first one rendered the Friend far below the visible
  // canvas — invisible, camera stuck at the previous run's height. Keeping them here fixes that at the root:
  // a fresh Run means a fresh camera, exactly like a fresh tower and a fresh score.
  cameraHeight: number; particles: Particle[]; popups: Popup[]; starFlash: number;
  // Highest milestone zone (height-points / MILESTONE_STEP, floored) already announced, plus how long its
  // banner still has left to show; both purely presentational, derived from state.peakHeight, never fed back.
  milestoneZone: number; milestoneFlash: number;
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
  const [status, setStatus] = useState("Loading your Friend…"), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  const [screen, setScreen] = useState<Screen>("pick");
  const [seed, setSeed] = useState<number>(() => todaySeed());
  const [best, setBest] = useState<Record<number, number>>({}); // this session only; see the disclaimer in the menu
  const [ghosts, setGhosts] = useState<readonly RunRecord[]>([]); // this session's own past runs, newest first
  const [lastScore, setLastScore] = useState(0), [lastCode, setLastCode] = useState("");
  const [lastHeightPoints, setLastHeightPoints] = useState(0), [lastStars, setLastStars] = useState(0), [lastStarPoints, setLastStarPoints] = useState(0);
  const [importCode, setImportCode] = useState(""), [importError, setImportError] = useState("");
  const [importedGhost, setImportedGhost] = useState<RunRecord | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [menu, setMenu] = useState<"settings" | null>(null), [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false);
  const live = useRef({ paused, menu, reducedMotion, screen }); live.current = { paused, menu, reducedMotion, screen };

  const sound = useRef<FriendSoundKit | null>(null);
  useEffect(() => { sound.current = createFriendSoundKit({ muted: true }); return () => sound.current?.dispose(); }, []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(preference.matches); change(); preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);

  const dirRef = useRef<Dir>(0), heldKeys = useRef(new Set<string>()), heldPointer = useRef<Dir | null>(null);
  const runRef = useRef<Run | null>(null);
  const playedBefore = useRef(false); // for the "land on a star" hint, shown only during the session's first run
  const [isFirstRun, setIsFirstRun] = useState(true);
  const stop = () => { heldKeys.current.clear(); heldPointer.current = null; dirRef.current = 0; };

  function startGame(nextSeed: number) {
    const tower = generateTower(nextSeed);
    const sameTower = ghosts.filter(run => run.seed === nextSeed);
    // Ghost colors stay inside the black/green/white palette — different opacities of white, plus green for
    // a pasted friend's code — and are told apart by their label, not by introducing another hue.
    const own = sameTower.slice(0, 3).map((run, index) => makeGhost(`run ${index + 1}`, "rgba(255,255,255,0.3)", tower, run.transitions));
    const bot = makeGhost("bot", "rgba(255,255,255,0.55)", tower, botRun(nextSeed).transitions);
    const imported = importedGhost && importedGhost.seed === nextSeed ? makeGhost("friend's code", "rgba(204,255,0,0.6)", tower, importedGhost.transitions) : null;
    runRef.current = { tower, state: startRun(), transitions: [], lastDir: 0, bot, own, imported, cameraHeight: 0, particles: [], popups: [], starFlash: 0, milestoneZone: 0, milestoneFlash: 0 };
    setIsFirstRun(!playedBefore.current); playedBefore.current = true;
    setSeed(nextSeed); setImportError(""); setScreen("play");
  }
  function endGame(state: RunState) {
    const score = scoreOf(state), transitions = runRef.current?.transitions ?? [];
    setGhosts(previous => [{ seed, transitions, score }, ...previous].slice(0, 12));
    setBest(previous => ({ ...previous, [seed]: Math.max(previous[seed] ?? 0, score) }));
    setLastScore(score); setLastHeightPoints(Math.floor(state.peakHeight / HEIGHT_PER_POINT)); setLastStars(state.stars); setLastStarPoints(state.starPoints);
    setLastCode(encodeRun(seed, transitions, score)); setCopyFailed(false); setScreen("result");
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
            run.state = step(run.tower, run.state, dirRef.current);
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
            // Purely presentational milestone banner/zone tint, every MILESTONE_STEP height-points of the
            // run's own high-water mark — derived from peakHeight, never fed back into tower.ts's state.
            const zone = Math.floor(Math.floor(run.state.peakHeight / HEIGHT_PER_POINT) / MILESTONE_STEP);
            if (zone > run.milestoneZone) { run.milestoneZone = zone; run.milestoneFlash = 1; sound.current?.play("reward"); }
            if (!run.state.alive) sound.current?.play("impact", { volume: 0.7 });
          }
          if (!run.state.alive) endGame(run.state);
        }
        if (run) {
          // The bug this replaces: cameraHeight snapped straight to (height - CAMERA_ANCHOR) every frame while
          // climbing, which substituted into toScreenY below to exactly 0 — the Friend was pinned to the very
          // top pixel of the canvas on every new peak, not held at the anchor. Easing toward run.state.peakHeight
          // itself (tower.ts's own monotonic high-water mark, already proven never to decrease) fixes both: the
          // Friend now settles AT the anchor with a smooth lag instead of snapping past it, and because the
          // target never decreases, neither does cameraHeight — falling never pulls the camera back down.
          const catchUp = 1 - Math.exp(-CAMERA_CATCH_UP_RATE * dt);
          run.cameraHeight += (run.state.peakHeight - run.cameraHeight) * catchUp;
        }
        const toScreenY = (height: number) => CAMERA_ANCHOR - (height - (run?.cameraHeight ?? 0));

        const motion = !live.current.reducedMotion;
        ctx.clearRect(0, 0, VIEW.width, VIEW.height);
        const zoneIndex = Math.floor(Math.floor((run?.state.peakHeight ?? 0) / HEIGHT_PER_POINT) / MILESTONE_STEP);
        ctx.fillStyle = ZONE_BACKGROUNDS[zoneIndex % ZONE_BACKGROUNDS.length]; ctx.fillRect(0, 0, VIEW.width, VIEW.height);

        if (motion && run) {
          // Parallax: a stable, deterministic star field (never re-randomized — see starsBetween) plus a
          // ground skyline that fades out as the camera climbs away from it. Reduced motion skips both: a
          // still dark lane reads just as clearly and this is the only truly optional layer per frame.
          const topHeight = run.cameraHeight + VIEW.height - CAMERA_ANCHOR, bottomHeight = run.cameraHeight - CAMERA_ANCHOR;
          ctx.fillStyle = "#fff"; ctx.globalAlpha = 0.5;
          for (const star of starsBetween(topHeight, bottomHeight, VIEW.width)) {
            const y = toScreenY(star.y); starPath(ctx, star.x, y, star.size * 1.6, star.size * 0.7); ctx.fill();
          }
          ctx.globalAlpha = 1;
          const skylineFade = Math.max(0, 1 - run.cameraHeight / 900);
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
          });
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
          // fade timing depends on dt either way.
          if (run.milestoneFlash > 0) {
            ctx.globalAlpha = Math.min(1, run.milestoneFlash);
            ctx.fillStyle = NEON; ctx.strokeStyle = "#000"; ctx.lineWidth = 4;
            ctx.font = "bold 40px monospace"; ctx.textAlign = "center";
            const text = `${run.milestoneZone * MILESTONE_STEP}!`;
            ctx.strokeText(text, VIEW.width / 2, VIEW.height * 0.3);
            ctx.fillText(text, VIEW.width / 2, VIEW.height * 0.3);
            ctx.globalAlpha = 1;
            run.milestoneFlash = Math.max(0, run.milestoneFlash - dt / 1.4);
          }
        }
        // ~10 updates/second is plenty for a number that only needs to look alive, and far cheaper than a
        // React re-render on every one of these (up to 60/second).
        if (scoreLabel.current && now - lastHudUpdate > 100) {
          lastHudUpdate = now;
          // Score, not height, is what the HUD leads with: a star's +25 popup used to look like it vanished
          // because only the (unrelated-looking) star count ticked up — showing the number the popup actually
          // added to makes the payoff visible immediately, the same number the result screen settles on.
          scoreLabel.current.textContent = `Score ${run ? scoreOf(run.state) : 0} · ★${run ? run.state.stars : 0}`;
        }
        node.dataset.x = run ? run.state.x.toFixed(1) : "";
        node.dataset.height = run ? run.state.height.toFixed(1) : "0";
        node.dataset.score = run ? String(scoreOf(run.state)) : "0";
        node.dataset.screen = live.current.screen;
        // Lets check-browser.mjs catch "the camera lost the Friend" without reading pixels: the Friend must
        // always be within the visible canvas while a run is alive, never scrolled off by a stale camera.
        node.dataset.playerScreenY = run ? toScreenY(run.state.height).toFixed(1) : "";
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => { if (!cancelled) { setFailed(true); setStatus("Your Friend's artwork could not load. Check your connection and retry."); } });
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", stop);
    return () => {
      cancelled = true; cancelAnimationFrame(frame); stop(); resizeObserver.disconnect();
      window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop);
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
      setImportedGhost({ seed: decoded.seed, transitions: decoded.transitions, score: decoded.claimedScore });
      setImportError(decoded.seed === seed ? "" : "That code is from a different tower; pick the matching tower to race it.");
    } catch (error) { setImportError(error instanceof Error ? error.message : "That code could not be read."); }
  }

  const sceneBlocked = paused || menu !== null || screen !== "play" || Boolean(status);
  return <section className="fc-game" aria-label="Friend Climb">
    <div className="fc-top" inert={paused || undefined}>
      {screen === "play" ? <span ref={scoreLabel}>Score 0</span> : <span>Friend Climb</span>}
      <button type="button" aria-pressed={!muted} disabled={Boolean(status)} onClick={() => {
        const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock();
      }}>{muted ? "Sound off" : "Sound on"}</button>
      <button type="button" disabled={Boolean(status)} onClick={() => setMenu("settings")}>Settings</button>
    </div>

    <div className="fc-scene" inert={sceneBlocked || undefined}>
      {/* width/height are a placeholder default; the effect's ResizeObserver sets the real backing-store size
          to exactly match the frame's actual aspect ratio as soon as it mounts. */}
      <canvas ref={canvas} width={Math.round(REFERENCE_HEIGHT * 0.75)} height={REFERENCE_HEIGHT} tabIndex={sceneBlocked ? -1 : 0}
        aria-label="Climbing tower. Arrow keys or A/D to steer, or hold either side of the tower to steer there."
        onBlur={stop}
        // event.code names the physical key, not the character it types, so steering works on any keyboard
        // layout — on a Cyrillic layout, for instance, the "A"/"D" keys still report "KeyA"/"KeyD".
        onKeyDown={event => { if (sceneBlocked) return;
          if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(event.code)) { event.preventDefault(); heldKeys.current.add(event.code); } }}
        onKeyUp={event => heldKeys.current.delete(event.code)}
        onPointerDown={event => { if (sceneBlocked) return; event.preventDefault(); event.currentTarget.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          heldPointer.current = (event.clientX - rect.left) / rect.width < 0.5 ? -1 : 1; }}
        onPointerUp={() => { heldPointer.current = null; }} onPointerCancel={() => { heldPointer.current = null; }} />
      {screen === "play" && !status && isFirstRun && <p className="fc-hint fc-star-hint">Land on a star for +{STAR_POINTS}</p>}
      {screen === "play" && !status && <p className="fc-hint"><span className="fc-desktop-controls">Arrow keys or A/D · </span>Hold either side of the tower</p>}
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
      <button type="button" disabled={paused} onClick={() => startGame(randomSeed())}>Practice (new tower)</button>
      <p className="fc-note">Progress and ghosts last only for this open session — closing or reloading the page clears them. There is no save yet.</p>
      <label className="fc-import">
        Race a friend's code
        <input value={importCode} onChange={event => setImportCode(event.target.value)} placeholder="FC3...." disabled={paused} />
        <button type="button" disabled={paused || !importCode} onClick={loadImportedCode}>Load</button>
      </label>
      {importError && <p role="alert">{importError}</p>}
      {importedGhost && !importError && <p>Loaded a code for tower #{importedGhost.seed.toString(36)}. Start that tower to race it (today's tower and practice towers use different seeds).</p>}
    </div>}

    {!status && screen === "result" && <div className="fc-result">
      <h1>Score: {lastScore}</h1>
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
      <label><input type="checkbox" checked={reducedMotion} disabled={paused} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
      <p>Turns off landing squash-and-stretch and bounce sparks; never changes the physics or score.</p>
      <p>Ghosts (your past runs, the bot and any pasted code) are presentation only — they cannot affect your run. The bot is always labeled "bot", never a Friend.</p>
      <button type="button" disabled={paused} onClick={() => setMenu(null)}>Back</button>
    </GameMenu>}
  </section>;
}
