"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameWorld, type GameWorldInteraction } from "@rarefriends/friendsdk/world-view";
import { getWorldPreset, validateWorld } from "@rarefriends/friendsdk/world";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GameClient, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { RoomScene } from "./room.js";
import { NEW_CAREER, SEATS, dealTable, describeResult, recordRound, tableEconomy, type Career, type Deal } from "./table.js";
import "./world-view.css";
import "./style.css";

/**
 * The SDK preview wallet is fixed at 20 RF, so the playable room runs at 1/100 of its design size:
 * a "Room 100 RF" ticket is sold as a 1 RF preview ticket. The ticket price itself comes from game.json only.
 */
const DESIGN_SCALE = 100n;
/** The SDK bridge accepts quantities from 1 to 99. */
const MAX_GAMES = 99;
/** Reveal pacing at x1 speed, in milliseconds. x2 halves every wait; Skip removes them. */
const BOT_STEP_MS = 450, SUSPENSE_MS = 1500, HOLD_MS = 1800, HOLD_REDUCED_MS = 1200;
/** Rooms that need SDK features v0.1 does not have. They are shown, never sold. */
const LOCKED_ROOMS = [
  { id: "door-1000", rf: 1_000, position: [58, 192] },
  { id: "door-10000", rf: 10_000, position: [288, 58] },
  { id: "door-100000", rf: 100_000, position: [520, 192] },
] as const;

const courtyard = getWorldPreset("02-circuit-courtyard-complete");
const world = validateWorld({ ...courtyard, actors: [], props: [
  { type: "tank", x: 95, y: 74, scale: 1.1 }, { type: "pipe", x: 158, y: 68, scale: 0.95 },
  { type: "tank", x: 88, y: 296, scale: 0.8 }, { type: "crate", x: 132, y: 344, scale: 0.8 },
  { type: "terminal", x: 288, y: 330, scale: 1.5 },
  ...LOCKED_ROOMS.map(room => ({ type: "terminal" as const, x: room.position[0], y: room.position[1], scale: 1.2 })),
] });
const START = [190, 322] as const;
const AT_DOOR = [345, 322] as const;

type Screen = "hall" | "room";
type Menu = "door" | "locked" | "settings" | "receipt" | null;
type Phase = "playing" | "stopped" | "done";
type Round = Readonly<{ number: number; deal: Deal }>;
type Speed = 1 | 2;

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;
const count = (value: number) => value.toLocaleString("en-US");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

/** Most games the SDK lets this Friend start now: tickets already owned plus what the balance and prize backing allow. */
async function affordableGames(client: GameClient, snapshot: GameSnapshot): Promise<number> {
  const owned = Number(snapshot.consumables > BigInt(MAX_GAMES) ? BigInt(MAX_GAMES) : snapshot.consumables);
  let low = owned, high = Math.min(MAX_GAMES, owned + Number(snapshot.rfBalance / client.definition.price));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (await client.canBuy(BigInt(middle - owned))) low = middle; else high = middle - 1;
  }
  return low;
}

export default function FriendRooms({ friendId, client, paused }: GameComponentProps) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [screen, setScreen] = useState<Screen>("hall"), [menu, setMenu] = useState<Menu>(null);
  const [lockedRoom, setLockedRoom] = useState<number>(LOCKED_ROOMS[0].rf), [visited, setVisited] = useState(false);
  const [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false), [narrow, setNarrow] = useState(false);
  const [busy, setBusy] = useState(false), [games, setGames] = useState(1), [maxGames, setMaxGames] = useState(0);
  const [round, setRound] = useState<Round | null>(null), [revealed, setRevealed] = useState(0);
  const [phase, setPhase] = useState<Phase>("done"), [progress, setProgress] = useState({ done: 0, total: 0 }), [stopping, setStopping] = useState(false);
  const [career, setCareer] = useState<Career>(NEW_CAREER);
  const [speed, setSpeed] = useState<Speed>(1), [skipping, setSkipping] = useState(false);
  const sound = useRef<FriendSoundKit | null>(null), epoch = useRef(0), locked = useRef(false), stop = useRef(false), skip = useRef(false);
  const live = useRef({ paused, reducedMotion, speed }); live.current = { paused, reducedMotion, speed };
  const definition = client.definition;
  const designRf = count(Number(definition.price * DESIGN_SCALE / 10n ** 18n));
  const prize = maximumPrize(definition);
  const economy = useMemo(() => tableEconomy(definition.price, prize), [definition, prize]);
  const winIndex = definition.outcomes.findIndex(outcome => outcome.reward === prize);

  const load = useCallback(() => {
    const version = epoch.current;
    setError("");
    client.read().then(value => { if (version === epoch.current) setSnapshot(value); }).catch(cause => {
      if (version === epoch.current) setError(errorText(cause, "Could not load the preview."));
    });
  }, [client]);

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: true });
    setSnapshot(null); setScreen("hall"); setMenu(null); setVisited(false); setMuted(true); setBusy(false); setMessage("");
    setRound(null); setRevealed(0); setPhase("done"); setProgress({ done: 0, total: 0 }); setStopping(false); setCareer(NEW_CAREER); setSkipping(false);
    locked.current = false; stop.current = false; skip.current = false;
    load();
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches); update();
    preference.addEventListener("change", update);
    const width = window.matchMedia("(max-width: 520px)");
    const resize = () => setNarrow(width.matches); resize();
    width.addEventListener("change", resize);
    return () => {
      epoch.current = version + 1; sound.current?.dispose(); sound.current = null;
      preference.removeEventListener("change", update); width.removeEventListener("change", resize);
    };
  }, [client, friendId, load]);

  // The door menu asks the SDK how many games can be started right now.
  useEffect(() => {
    if (menu !== "door" || !snapshot) return;
    let current = true;
    void affordableGames(client, snapshot).then(value => {
      if (!current) return;
      setMaxGames(value); setGames(previous => Math.min(Math.max(previous, 1), Math.max(value, 1)));
    }).catch(cause => { if (current) setError(errorText(cause, "Could not check what you can afford.")); });
    return () => { current = false; };
  }, [menu, snapshot, client]);

  const interactions = useMemo<readonly GameWorldInteraction[]>(() => [
    { id: "door-100", label: `Room ${designRf} RF`, position: [288, 330], reach: 90, labelOffset: 18 },
    ...LOCKED_ROOMS.map(room => ({ id: room.id, label: `Room ${count(room.rf)} RF${narrow ? "" : " · locked"}`, position: [room.position[0], room.position[1]] as const, reach: 90, labelOffset: narrow ? -148 : -172 })),
  ], [designRf, narrow]);

  if (!snapshot) return <div className="fr-loading" role={error ? "alert" : "status"}>{error || "Loading game…"}
    {error && <button type="button" disabled={paused} onClick={load}>Retry</button>}</div>;
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;
  if (!economy || winIndex < 0) return <p role="alert">This game definition does not match the table rules, so it cannot be played.</p>;

  const unfinished = snapshot.plays.filter(play => play.outcomeId === null);
  const winsWaiting = snapshot.inventory[winIndex];
  const winningsWaiting = winsWaiting * prize;
  const openMenu = (next: Menu) => { if (!paused) { setMenu(next); setError(""); setMessage(""); } };
  const onInteract = (id: string) => {
    const door = LOCKED_ROOMS.find(room => room.id === id);
    if (door) { setLockedRoom(door.rf); openMenu("locked"); } else openMenu("door");
  };

  /** Runs one guarded SDK action. Only one runs at a time and a changed session drops its result. */
  async function run(work: (version: number) => Promise<void>) {
    if (locked.current || live.current.paused) return;
    const version = epoch.current; locked.current = true; setBusy(true); setError(""); setMessage(""); void sound.current?.unlock();
    try { await work(version); }
    catch (cause) { if (version === epoch.current) setError(errorText(cause, "The preview action failed.")); }
    finally { if (version === epoch.current) { locked.current = false; setBusy(false); } }
  }

  /** Wait for a delay scaled by the chosen speed. Skip or a changed session ends it early; Stop can end a hold. */
  const pace = (ms: number, version: number, endOnStop = false) => new Promise<void>(resolve => {
    const end = Date.now() + ms / live.current.speed;
    const tick = () => { if (skip.current || (endOnStop && stop.current) || version !== epoch.current || Date.now() >= end) resolve(); else setTimeout(tick, 40); };
    tick();
  });

  /** Open the numbers one by one: bots from the lowest up, then a pause, then the Friend's number last. */
  async function reveal(version: number) {
    if (live.current.reducedMotion || skip.current) { setRevealed(SEATS); return; }
    for (let opened = 1; opened < SEATS; opened++) {
      await pace(BOT_STEP_MS, version);
      if (version !== epoch.current) return;
      if (skip.current) break;
      setRevealed(opened); sound.current?.play("select");
    }
    if (!skip.current) { sound.current?.play("anticipation"); await pace(SUSPENSE_MS, version); }
    if (version !== epoch.current) return;
    setRevealed(SEATS);
  }

  /** Settle each round with the SDK, then deal a table that matches its result and open it. */
  async function playRounds(ids: readonly bigint[], version: number) {
    stop.current = false; skip.current = false; setStopping(false); setSkipping(false);
    setScreen("room"); setVisited(true); setPhase("playing"); setRound(null); setRevealed(0);
    let done = 0; setProgress({ done, total: ids.length });
    try {
      for (const id of ids) {
        if (stop.current) break;
        while (live.current.paused && version === epoch.current) await sleep(150);
        if (version !== epoch.current) return;
        const result = await client.settle(id);
        if (version !== epoch.current) return;
        const outcome = result.outcomeId === null ? undefined : definition.outcomes[result.outcomeId - 1];
        if (!outcome) throw new Error("This round is still pending. Use Resume to continue it.");
        const deal = dealTable(outcome.reward > 0n);
        done++;
        setRound({ number: done, deal }); setRevealed(0); setProgress({ done, total: ids.length });
        setCareer(previous => recordRound(previous, deal));
        const fresh = await client.read();
        if (version !== epoch.current) return;
        setSnapshot(fresh);
        await reveal(version);
        if (version !== epoch.current) return;
        sound.current?.play(deal.won ? "reward" : "impact");
        if (done < ids.length && !stop.current) await pace(live.current.reducedMotion ? HOLD_REDUCED_MS : HOLD_MS, version, true);
        if (version !== epoch.current) return;
      }
    } catch (cause) {
      if (version === epoch.current) { setError(errorText(cause, "A round could not be settled.")); setPhase("stopped"); void client.read().then(setSnapshot); }
      return;
    }
    const after = await client.read();
    if (version !== epoch.current) return;
    setSnapshot(after);
    setPhase(after.plays.some(play => play.outcomeId === null) ? "stopped" : "done"); setStopping(false);
  }

  /** One SDK prompt to buy the missing tickets, one to use them, then the rounds play one after another. */
  const start = (gamesToPlay: number) => run(async version => {
    const current = await client.read();
    const missingTickets = BigInt(gamesToPlay) - current.consumables;
    if (missingTickets > 0n) await client.buy(missingTickets);
    const plays = await client.play(BigInt(gamesToPlay));
    if (version !== epoch.current) return;
    setMenu(null);
    await playRounds(plays.map(play => play.id), version);
  });

  /** Unfinished rounds stay with the Friend. Resume settles those same plays; it never buys or uses another ticket. */
  const resume = () => run(async version => {
    const pending = (await client.read()).plays.filter(play => play.outcomeId === null).map(play => play.id);
    if (!pending.length) { load(); return; }
    setMenu(null);
    await playRounds(pending, version);
  });

  const collect = () => run(async version => {
    const owned = (await client.read()).inventory[winIndex];
    if (owned > 0n) await client.redeem(winIndex + 1, owned > BigInt(MAX_GAMES) ? BigInt(MAX_GAMES) : owned);
    const fresh = await client.read();
    if (version !== epoch.current) return;
    setSnapshot(fresh); setMessage(owned > 0n ? `Collected ${rf(owned * prize)} (SIMULATED).` : "Nothing to collect.");
  });

  const backToHall = () => { setMenu(null); setScreen("hall"); };
  const missing = Math.max(0, games - Number(snapshot.consumables));
  const blocked = unfinished.length > 0 ? "Finish your unfinished rounds first." : maxGames === 0
    ? (snapshot.rfBalance < definition.price ? "Not enough simulated RF for a ticket." : "New tickets are paused until winnings are collected and prize backing is free again.") : "";
  const hud = <div className="fr-hud"><span><b className="fr-tag">SIMULATED</b> {rf(snapshot.rfBalance)} · {snapshot.consumables.toString()} tickets
    {screen === "room" && progress.total > 0 && <> · game {progress.done}/{progress.total}</>}</span>
    {screen === "hall" && <button type="button" onClick={() => openMenu("settings")}>Settings</button>}</div>;
  const status = <p role={error ? "alert" : "status"}>{error || message || (busy ? "Waiting for SDK confirmation…" : "All RF amounts are SIMULATED.")}</p>;

  return <section className="fr-game" aria-label={definition.name} aria-busy={busy}>
    {screen === "hall" ? <div className="fr-world" inert={Boolean(menu) || paused || undefined}>
      <GameWorld world={world} spawn={visited ? AT_DOOR : START} interactions={interactions} friendId={friendId}
        paused={Boolean(menu) || paused} reducedMotion={reducedMotion} onInteract={onInteract} />
      {hud}
      <p className="fr-hint"><span className="fr-desktop-hint">WASD / arrows to walk · Tap a destination · E near a door</span>
        <span className="fr-mobile-hint">Tap to walk · E / tap near a door</span></p>
    </div> : <div className="fr-room" inert={Boolean(menu) || paused || undefined}>
      <RoomScene friendId={friendId} deal={round?.deal ?? null} revealed={revealed} reducedMotion={reducedMotion}
        potLabel={rf(economy.pot)} prizeLabel={rf(economy.prize)} />
      {hud}
      <p className="fr-room-title">{round ? `Room ${designRf} RF · round ${round.number} of ${progress.total}` : `Room ${designRf} RF`}</p>
      <p className="fr-result">{round && revealed >= SEATS
        ? <><b role="status">{describeResult(round.deal)}</b>{round.deal.won && <span> +{rf(prize)} SIMULATED</span>}</>
        : <b role="status">{round ? "Opening the numbers…" : phase === "playing" ? "Dealing the table…" : "Table closed."}</b>}</p>
      <div className="fr-room-bar">
        {phase === "playing" ? <>
          <span className="fr-speed" role="group" aria-label="Autoplay speed">
            <button type="button" aria-pressed={speed === 1} onClick={() => setSpeed(1)}>x1</button>
            <button type="button" aria-pressed={speed === 2} onClick={() => setSpeed(2)}>x2</button></span>
          <button type="button" disabled={skipping || paused} onClick={() => { skip.current = true; setSkipping(true); }}>{skipping ? "Skipping…" : "Skip to summary"}</button>
          <button type="button" disabled={stopping || paused} onClick={() => { stop.current = true; setStopping(true); }}>{stopping ? "Stopping…" : "Stop after this round"}</button></> : <>
          {phase === "stopped" && unfinished.length > 0 && <button type="button" className="rf-frame-primary" disabled={busy || paused} onClick={() => void resume()}>Resume {unfinished.length} unfinished {unfinished.length === 1 ? "round" : "rounds"}</button>}
          <button type="button" className={phase === "done" ? "rf-frame-primary" : undefined} disabled={paused} onClick={() => setMenu("receipt")}>Session receipt</button>
          <button type="button" disabled={busy || paused} onClick={backToHall}>Back to the hall</button></>}
      </div>
      {error && <p className="fr-room-error" role="alert">{error}</p>}
    </div>}
    {menu && <GameMenu title={menu === "door" ? `Room ${designRf} RF` : menu === "locked" ? `Room ${count(lockedRoom)} RF · locked` : menu === "receipt" ? "Session receipt" : "Settings"}
      onClose={busy ? undefined : () => setMenu(null)}>
      {menu === "door" ? <>
        <p>Room {designRf} RF · preview tickets {rf(definition.price)} (SDK preview wallet is fixed at 20 RF).</p>
        <ul>
          <li>The table has {SEATS} seats: your Friend and {SEATS - 1} simulated bots.</li>
          <li>Everyone draws a unique number from 1 to 100. The highest number wins.</li>
          <li>The pot is {SEATS} tickets. The winner takes {rf(economy.prize)} (90%); 10% is burned in the model.</li>
          <li>The SDK result decides your outcome first. The table is then dealt to match it.</li>
        </ul>
        <table><thead><tr><th>Result</th><th>Chance</th><th>Prize</th></tr></thead><tbody>{definition.outcomes.map(item =>
          <tr key={item.name}><td>{item.name}</td><td>{item.chanceBps / 100}%</td><td>{rf(item.reward)}</td></tr>)}</tbody></table>
        {winsWaiting > 0n && <p>Winnings waiting: {rf(winningsWaiting)}. <button type="button" disabled={busy || paused} onClick={() => void collect()}>Collect winnings</button></p>}
        {unfinished.length > 0 && <p>You have {unfinished.length} unfinished {unfinished.length === 1 ? "round" : "rounds"}.
          {" "}<button type="button" className="rf-frame-primary" disabled={busy || paused} onClick={() => void resume()}>Finish unfinished rounds</button></p>}
        <label>Games to play: <b>{games}</b>
          <input type="range" min={1} max={Math.max(maxGames, 1)} value={games} disabled={maxGames < 2 || busy || paused} aria-label="Games to play"
            onChange={event => setGames(Number(event.target.value))} /></label>
        <p>Total: {rf(definition.price * BigInt(games))} (SIMULATED). You confirm {missing > 0 ? "two SDK prompts: buy the tickets, then use them" : "one SDK prompt: use your tickets"}. The Friend then plays all games on its own.</p>
        <button type="button" className="rf-frame-primary" disabled={Boolean(blocked) || busy || paused} onClick={() => void start(games)}>Play {games} {games === 1 ? "game" : "games"} · {rf(definition.price * BigInt(games))}</button>
        {blocked && <p>{blocked}</p>}
        <p>Each ticket reserves {rf(prize)} of prize backing in the SDK preview, so a run is limited to {maxGames} {maxGames === 1 ? "game" : "games"} right now.</p>
      </> : menu === "locked" ? <>
        <p>Room {count(lockedRoom)} RF needs future SDK support.</p>
        <p>SDK v0.1 sells one ticket type in a private preview. Higher stakes need several ticket tiers, shared rooms and a room contract.</p>
        <button type="button" onClick={() => setMenu(null)}>Close</button>
      </> : menu === "receipt" ? <>
        <table><tbody>
          <tr><th>Games played</th><td>{career.played}</td></tr>
          <tr><th>Wins</th><td>{career.wins}</td></tr>
          <tr><th>Best number</th><td>{career.bestNumber || "–"}</td></tr>
          <tr><th>Win streak (best)</th><td>{career.streak} ({career.bestStreak})</td></tr>
          <tr><th>Tickets spent</th><td>{rf(definition.price * BigInt(career.played))} SIMULATED</td></tr>
          <tr><th>Prizes won</th><td>{rf(prize * BigInt(career.wins))} SIMULATED</td></tr>
          <tr><th>Burned at the tables</th><td>{rf(economy.burn * BigInt(career.played))} model</td></tr>
          <tr><th>Your share of the burn</th><td>{rf(economy.burnShare * BigInt(career.played))} model</td></tr>
        </tbody></table>
        <p>The burn is a model of a future room contract. SDK v0.1 does not burn RF; the 10% stays as game backing.</p>
        {winsWaiting > 0n && <p>Winnings waiting: {rf(winningsWaiting)}. <button type="button" className="rf-frame-primary" disabled={busy || paused} onClick={() => void collect()}>Collect winnings</button></p>}
        {unfinished.length > 0 && <p>{unfinished.length} unfinished {unfinished.length === 1 ? "round remains" : "rounds remain"}. Use Resume at the table.</p>}
        <button type="button" onClick={() => setMenu(null)}>Close</button>
      </> : <>
        <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>{muted ? "Sound off" : "Sound on"}</button>
        <label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
        <p>All economy actions are simulated. Reloading resets this preview. Wallet connection and ownership checks are provided by the SDK.</p>
      </>}{status}
    </GameMenu>}
  </section>;
}
