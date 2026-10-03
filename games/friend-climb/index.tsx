"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, spriteFrame } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";
import {
  DT, WORLD_WIDTH, PLAYER_RADIUS,
  type Dir, type Tower, type RunState, type Transition,
  seedForDate, generateTower, startRun, step, scoreOf, botRun, encodeRun, decodeRun,
} from "./tower";

const VIEW = { width: 360, height: 640 };
const LANE_MARGIN = (VIEW.width - WORLD_WIDTH) / 2; // 30px either side of the 300-wide lane
const CAMERA_ANCHOR = VIEW.height * 0.62; // how far down the screen the Friend sits while climbing
/** One accent color per family, used only for this game's own particle and ghost-marker effects. */
const FAMILY_COLORS: Record<string, string> = {
  Skeleton: "#9bd1ff", Mask: "#ffb3e6", Family: "#ffd36e", Cellular: "#8effa0",
  Asymmetry: "#ff8e6e", Hoverer: "#b7a6ff", Colossus: "#ffe36e", Sparkling: "#ccff00", Hollow: "#c9c9c9",
};
const todaySeed = () => seedForDate(new Date().toISOString().slice(0, 10));
const randomSeed = () => { const words = new Uint32Array(1); crypto.getRandomValues(words); return words[0]; };

type Ghost = Readonly<{ label: string; color: string; tower: Tower; transitions: readonly Transition[]; dir: Dir; state: RunState; index: number }>;
type RunRecord = Readonly<{ seed: number; transitions: readonly Transition[]; score: number }>;
type Screen = "pick" | "play" | "result";
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };

function makeGhost(label: string, color: string, tower: Tower, transitions: readonly Transition[]): Ghost {
  return { label, color, tower, transitions, dir: 0, state: startRun(), index: 0 };
}
function advanceGhost(ghost: Ghost): Ghost {
  if (!ghost.state.alive) return ghost;
  let { dir, index } = ghost;
  while (index < ghost.transitions.length && ghost.transitions[index].tick <= ghost.state.tick) { dir = ghost.transitions[index].dir; index++; }
  return { ...ghost, dir, index, state: step(ghost.tower, ghost.state, dir) };
}
/** The lane wraps left-right (see tower.ts); draw whichever copy of x is on screen, sometimes both near an edge. */
function wrappedScreenXs(x: number): number[] {
  const xs = [LANE_MARGIN + x];
  if (x < PLAYER_RADIUS) xs.push(LANE_MARGIN + x + WORLD_WIDTH);
  if (x > WORLD_WIDTH - PLAYER_RADIUS) xs.push(LANE_MARGIN + x - WORLD_WIDTH);
  return xs;
}
function spawnBurst(particles: Particle[], x: number, y: number, color: string, count: number) {
  for (let index = 0; index < count; index++) {
    const angle = Math.PI * (0.15 + 0.7 * Math.random());
    particles.push({ x, y, vx: Math.cos(angle) * 90 * (Math.random() - 0.5) * 2, vy: Math.sin(angle) * 90, life: 0.4, color });
  }
}

type Run = {
  tower: Tower; state: RunState; transitions: Transition[]; lastDir: Dir; bot: Ghost; own: Ghost[]; imported: Ghost | null;
  // Per-run camera/particle state. These used to live outside the Run object and never reset between games,
  // so a second run started after climbing high in the first one rendered the Friend far below the visible
  // canvas — invisible, camera stuck at the previous run's height. Keeping them here fixes that at the root:
  // a fresh Run means a fresh camera, exactly like a fresh tower and a fresh score.
  cameraHeight: number; particles: Particle[];
};

export default function FriendClimb({ friendId, client, paused }: GameComponentProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Loading your Friend…"), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  const [screen, setScreen] = useState<Screen>("pick");
  const [seed, setSeed] = useState<number>(() => todaySeed());
  const [best, setBest] = useState<Record<number, number>>({}); // this session only; see the disclaimer in the menu
  const [ghosts, setGhosts] = useState<readonly RunRecord[]>([]); // this session's own past runs, newest first
  const [lastScore, setLastScore] = useState(0), [lastCode, setLastCode] = useState("");
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
  const stop = () => { heldKeys.current.clear(); heldPointer.current = null; dirRef.current = 0; };

  function startGame(nextSeed: number) {
    const tower = generateTower(nextSeed);
    const sameTower = ghosts.filter(run => run.seed === nextSeed);
    const own = sameTower.slice(0, 3).map((run, index) => makeGhost(`run ${index + 1}`, "#8a8a8a", tower, run.transitions));
    const bot = makeGhost("bot", "#444", tower, botRun(nextSeed).transitions);
    const imported = importedGhost && importedGhost.seed === nextSeed ? makeGhost("friend's code", "#1b7a3d", tower, importedGhost.transitions) : null;
    runRef.current = { tower, state: startRun(), transitions: [], lastDir: 0, bot, own, imported, cameraHeight: 0, particles: [] };
    setSeed(nextSeed); setImportError(""); setScreen("play");
  }
  function endGame(score: number) {
    const transitions = runRef.current?.transitions ?? [];
    setGhosts(previous => [{ seed, transitions, score }, ...previous].slice(0, 12));
    setBest(previous => ({ ...previous, [seed]: Math.max(previous[seed] ?? 0, score) }));
    setLastScore(score); setLastCode(encodeRun(seed, transitions, score)); setCopyFailed(false); setScreen("result");
  }

  // One continuous render loop for the whole component's life: the canvas stays mounted across every screen so
  // this never has to reload the Friend's artwork or reset the camera/particles just because a menu opened over it.
  useEffect(() => {
    const node = canvas.current, ctx = node?.getContext("2d");
    if (!node || !ctx) { setFailed(true); setStatus("This browser cannot render the tower."); return; }
    let cancelled = false, frame = 0, previousTime = 0, accumulator = 0;
    setFailed(false); setStatus("Loading your Friend…");
    // The initial client.read() has no economy use here, but it is what tells the trusted runtime the
    // session is ready (see examples/scrolling-world, which does the same for a free exploration game).
    void Promise.all([createFriendReader().read(friendId), client.read()]).then(([sprites, snapshot]) => {
      if (cancelled) return;
      if (snapshot.friendId !== friendId) throw new Error("Game session does not match the selected Friend.");
      setStatus("");
      const color = FAMILY_COLORS[sprites.familyName] ?? "#ccff00";
      const render = (now: number) => {
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
            const previousStars = run.state.stars, wasFalling = run.state.vy < 0;
            run.state = step(run.tower, run.state, dirRef.current);
            run.bot = advanceGhost(run.bot); run.own = run.own.map(advanceGhost);
            if (run.imported) run.imported = advanceGhost(run.imported);
            if (wasFalling && run.state.vy > 0) {
              sound.current?.play("impact");
              if (!live.current.reducedMotion) spawnBurst(run.particles, run.state.x, run.state.height, color, 7);
            }
            if (run.state.stars > previousStars) {
              sound.current?.play("reward");
              if (!live.current.reducedMotion) spawnBurst(run.particles, run.state.x, run.state.height + 10, "#ccff00", 10);
            }
            if (!run.state.alive) sound.current?.play("impact", { volume: 0.7 });
          }
          if (!run.state.alive) endGame(scoreOf(run.state));
        }
        if (run) run.cameraHeight = Math.max(run.cameraHeight, run.state.height - CAMERA_ANCHOR);
        const toScreenY = (height: number) => CAMERA_ANCHOR - (height - (run?.cameraHeight ?? 0));

        ctx.clearRect(0, 0, VIEW.width, VIEW.height);
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, VIEW.width, VIEW.height);
        ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.strokeRect(LANE_MARGIN, 0, WORLD_WIDTH, VIEW.height);
        // The lane wraps left-right (see tower.ts); these chevrons mark both edges as a portal, not a wall,
        // at a few fixed screen heights so at least one pair stays visible regardless of how far the camera
        // has scrolled. wrappedScreenXs() is what actually draws the Friend/ghosts again on the far side.
        ctx.fillStyle = "#ccff00"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
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
            ctx.fillStyle = platform.breaking ? "#fff" : "#000"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.roundRect(LANE_MARGIN + platform.x - platform.width / 2, y - 6, platform.width, 10, 4);
            ctx.fill(); ctx.stroke();
            if (platform.star) {
              ctx.fillStyle = "#ccff00"; ctx.strokeStyle = "#000";
              ctx.beginPath(); ctx.arc(LANE_MARGIN + platform.x, y - 16, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            }
          });
          for (const ghost of [run.bot, run.imported, ...run.own].filter((value): value is Ghost => Boolean(value))) {
            if (!ghost.state.alive) continue;
            const y = toScreenY(ghost.state.height);
            if (y < -10 || y > VIEW.height + 10) continue;
            for (const x of wrappedScreenXs(ghost.state.x)) {
              ctx.globalAlpha = 0.55; ctx.fillStyle = ghost.color;
              ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS * 0.8, 0, Math.PI * 2); ctx.fill();
              ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.font = "9px monospace"; ctx.textAlign = "center"; ctx.fillText(ghost.label, x, y - 16);
            }
          }
          if (!live.current.reducedMotion) {
            for (let index = run.particles.length - 1; index >= 0; index--) {
              const particle = run.particles[index]; particle.life -= dt; particle.vy -= 500 * dt;
              particle.x += particle.vx * dt; particle.y += particle.vy * dt;
              if (particle.life <= 0) { run.particles.splice(index, 1); continue; }
              ctx.globalAlpha = Math.max(0, particle.life / 0.4); ctx.fillStyle = particle.color;
              ctx.fillRect(LANE_MARGIN + particle.x - 2, toScreenY(particle.y) - 2, 4, 4);
            }
            ctx.globalAlpha = 1;
          }
          const stretch = live.current.reducedMotion ? 1 : Math.max(0.78, Math.min(1.22, 1 + run.state.vy / 2600));
          const facing = run.lastDir === -1 ? "left" : "right";
          const rows = spriteFrame(sprites, facing, false, 0, facing).frame.rows;
          for (const x of wrappedScreenXs(run.state.x)) {
            const y = toScreenY(run.state.height), top = y - 75 * stretch;
            ctx.save(); ctx.translate(x, top); ctx.scale(1, stretch);
            ctx.beginPath(); ctx.rect(-40, 0, 80, 80); ctx.clip();
            ctx.fillStyle = "#fff"; rows.forEach((row: string, py: number) => [...row].forEach((pixel, px) => { if (pixel === "#") ctx.fillRect((px - 8) * 5 - 5, py * 5 - 5, 15, 15); }));
            ctx.fillStyle = "#000"; rows.forEach((row: string, py: number) => [...row].forEach((pixel, px) => { if (pixel === "#") ctx.fillRect((px - 8) * 5, py * 5, 5, 5); }));
            ctx.restore();
          }
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
      cancelled = true; cancelAnimationFrame(frame); stop();
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
      <span>{screen === "play" && runRef.current ? `Height ${Math.floor(runRef.current.state.height / 10)}` : "Friend Climb"}</span>
      <button type="button" aria-pressed={!muted} disabled={Boolean(status)} onClick={() => {
        const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock();
      }}>{muted ? "Sound off" : "Sound on"}</button>
      <button type="button" disabled={Boolean(status)} onClick={() => setMenu("settings")}>Settings</button>
    </div>

    <div className="fc-scene" inert={sceneBlocked || undefined}>
      <canvas ref={canvas} width={VIEW.width} height={VIEW.height} tabIndex={sceneBlocked ? -1 : 0}
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
      {screen === "play" && !status && <p className="fc-hint"><span className="fc-desktop-controls">Arrow keys or A/D · </span>Hold either side of the tower</p>}
    </div>

    {status && <div className="fc-status" role={failed ? "alert" : "status"}><p>{status}</p>
      {failed && <button type="button" disabled={paused} onClick={() => setRevision(value => value + 1)}>Retry loading</button>}</div>}

    {!status && screen === "pick" && <div className="fc-pick">
      <h1>Friend Climb</h1>
      <p>Your Friend bounces up a tower on its own; you only steer left and right. The lane wraps — walk off one
        side and you reappear on the other. Reach for stars, watch the ghosts, and see how high you get.</p>
      <button type="button" disabled={paused} onClick={() => startGame(todaySeed())}>Tower of the day</button>
      <button type="button" disabled={paused} onClick={() => startGame(randomSeed())}>Practice (new tower)</button>
      <p className="fc-note">Progress and ghosts last only for this open session — closing or reloading the page clears them. There is no save yet.</p>
      <label className="fc-import">
        Race a friend's code
        <input value={importCode} onChange={event => setImportCode(event.target.value)} placeholder="FC1...." disabled={paused} />
        <button type="button" disabled={paused || !importCode} onClick={loadImportedCode}>Load</button>
      </label>
      {importError && <p role="alert">{importError}</p>}
      {importedGhost && !importError && <p>Loaded a code for tower #{importedGhost.seed.toString(36)}. Start that tower to race it (today's tower and practice towers use different seeds).</p>}
    </div>}

    {!status && screen === "result" && <div className="fc-result">
      <h1>Score: {lastScore}</h1>
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
