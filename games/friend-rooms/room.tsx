import { useEffect, useRef, useState } from "react";
import { loadWorldAssets } from "@rarefriends/friendsdk/assets";
import { getWorldPreset, validateWorld } from "@rarefriends/friendsdk/world";
import { createFriendReader, spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { SEATS, revealOrder, type Deal } from "./table.js";

/**
 * The room scene: a black-and-white isometric platform from the SDK world renderer, a pixel-art table, numbered
 * plates, simulated bot tokens and the selected Friend drawn from its canonical sprite. Everything is drawn on one
 * 960 x 640 canvas that is scaled to fit. The Friend's pixels are never altered; effects are drawn around them.
 */
const VIEW = { x: 320, y: 410, width: 960, height: 640 } as const;
const INK = "#000", PAPER = "#fff", SIGNAL = "#ccff00";

/** A square platform: in the SDK projection it reads as a wide diamond about 940 px across. */
const roomWorld = (() => {
  const base = getWorldPreset("02-circuit-courtyard-complete");
  return validateWorld({ ...base, id: "friend-rooms-table", name: "Friend Rooms table", actors: [], paths: [], signals: [], patches: [],
    geometry: { polygons: [[[107, 11], [469, 11], [469, 373], [107, 373]]], holes: [], depth: 22 },
    props: [
      { type: "tank", x: 128, y: 338, scale: 0.9 }, { type: "terminal", x: 450, y: 52, scale: 0.9 },
      { type: "crate", x: 452, y: 352, scale: 0.7 },
    ] });
})();

/**
 * The table is a slab seen from the front (an isometric table turned 45 degrees). Positions are screen offsets from the
 * table centre, which is the platform centre. The Friend sits in the middle of the far side, partly hidden by the table.
 */
const CENTER = { x: 480, y: 690 - VIEW.y } as const;
const spot = (dx: number, dy: number) => [CENTER.x + dx, CENTER.y + dy] as const;
const TABLE = { half: 200, halfDepth: 35, lift: 16 } as const;
const FRIEND_SEAT = spot(0, -50);
const FAR_BOTS = [-170, -85, 85, 170].map(dx => spot(dx, -75));
const NEAR_BOTS = [-170, -85, 0, 85, 170].map(dx => spot(dx, 75));
const BOT_SEATS = [...FAR_BOTS, ...NEAR_BOTS];

/** A 3 x 5 pixel font, enough for numbers, names and a few words. */
const glyph = (rows: string) => rows.split("/");
const FONT: Readonly<Record<string, readonly string[]>> = {
  "0": glyph("XXX/X.X/X.X/X.X/XXX"), "1": glyph(".X./XX./.X./.X./XXX"), "2": glyph("XXX/..X/XXX/X../XXX"),
  "3": glyph("XXX/..X/XXX/..X/XXX"), "4": glyph("X.X/X.X/XXX/..X/..X"), "5": glyph("XXX/X../XXX/..X/XXX"),
  "6": glyph("XXX/X../XXX/X.X/XXX"), "7": glyph("XXX/..X/..X/.X./.X."), "8": glyph("XXX/X.X/XXX/X.X/XXX"),
  "9": glyph("XXX/X.X/XXX/..X/XXX"),
  A: glyph(".X./X.X/XXX/X.X/X.X"), B: glyph("XX./X.X/XX./X.X/XX."), C: glyph(".XX/X../X../X../.XX"),
  D: glyph("XX./X.X/X.X/X.X/XX."), E: glyph("XXX/X../XX./X../XXX"), F: glyph("XXX/X../XX./X../X.."),
  G: glyph(".XX/X../X.X/X.X/.XX"), H: glyph("X.X/X.X/XXX/X.X/X.X"), I: glyph("XXX/.X./.X./.X./XXX"),
  J: glyph("..X/..X/..X/X.X/.X."), K: glyph("X.X/X.X/XX./X.X/X.X"), L: glyph("X../X../X../X../XXX"),
  M: glyph("X.X/XXX/XXX/X.X/X.X"), N: glyph("XX./X.X/X.X/X.X/X.X"), O: glyph(".X./X.X/X.X/X.X/.X."),
  P: glyph("XX./X.X/XX./X../X.."), Q: glyph(".X./X.X/X.X/XX./.XX"), R: glyph("XX./X.X/XX./X.X/X.X"),
  S: glyph(".XX/X../.X./..X/XX."), T: glyph("XXX/.X./.X./.X./.X."), U: glyph("X.X/X.X/X.X/X.X/XXX"),
  V: glyph("X.X/X.X/X.X/X.X/.X."), W: glyph("X.X/X.X/XXX/XXX/X.X"), X: glyph("X.X/X.X/.X./X.X/X.X"),
  Y: glyph("X.X/X.X/.X./.X./.X."), Z: glyph("XXX/..X/.X./X../XXX"),
  "?": glyph("XXX/..X/.XX/.../.X."), "#": glyph("X.X/XXX/X.X/XXX/X.X"), ".": glyph(".../.../.../.../.X."),
  "!": glyph(".X./.X./.X./.../.X."), "-": glyph(".../.../XXX/.../..."), " ": glyph(".../.../.../.../..."),
};
const textWidth = (value: string, scale: number) => value.length * 4 * scale - scale;

type Align = "left" | "center" | "right";
function drawText(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, scale: number, color = INK, align: Align = "center") {
  const width = textWidth(value, scale);
  let cursor = Math.round(align === "center" ? x - width / 2 : align === "right" ? x - width : x);
  ctx.fillStyle = color;
  for (const character of value.toUpperCase()) {
    const rows = FONT[character] ?? FONT[" "];
    rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "X") ctx.fillRect(cursor + px * scale, y + py * scale, scale, scale); }));
    cursor += 4 * scale;
  }
}

const DISC = ["..XXXXX..", ".XXXXXXX.", "XXXXXXXXX", "XXXXXXXXX", "XXXXXXXXX", "XXXXXXXXX", "XXXXXXXXX", ".XXXXXXX.", "..XXXXX.."];
const DISC_INNER = [".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX."];
function drawMask(ctx: CanvasRenderingContext2D, rows: readonly string[], left: number, top: number, scale: number, color: string) {
  ctx.fillStyle = color;
  rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "X") ctx.fillRect(left + px * scale, top + py * scale, scale, scale); }));
}

/** A simulated bot: a plain round token on a stool. Deliberately not Friend artwork. */
function drawBot(ctx: CanvasRenderingContext2D, x: number, y: number, hop: number, winner: boolean) {
  ctx.fillStyle = INK; ctx.fillRect(x - 18, y - 6, 36, 8); ctx.fillRect(x - 12, y - 12, 24, 8);
  ctx.fillStyle = PAPER; ctx.fillRect(x - 12, y - 10, 24, 2);
  const left = x - 18, top = y - 26 - hop - 18;
  drawMask(ctx, DISC, left, top, 4, INK);
  drawMask(ctx, DISC_INNER, left + 4, top + 4, 4, winner ? SIGNAL : PAPER);
  ctx.fillStyle = INK; ctx.fillRect(x - 2, top + 9, 4, 18); ctx.fillRect(x - 9, top + 16, 18, 4);
}

interface PlateStyle { hidden: boolean; winner: boolean; mine: boolean; lift: number; blink: boolean }
function drawPlate(ctx: CanvasRenderingContext2D, cx: number, bottom: number, label: string, style: PlateStyle) {
  const scale = 4, width = textWidth(label, scale) + 20, height = 5 * scale + 14;
  const left = Math.round(cx - width / 2), top = Math.round(bottom - height - style.lift);
  ctx.fillStyle = INK; ctx.fillRect(left + 4, top + 4, width, height);
  if (style.mine) { ctx.fillStyle = INK; ctx.fillRect(left - 4, top - 4, width + 8, height + 8); ctx.fillStyle = PAPER; ctx.fillRect(left - 2, top - 2, width + 4, height + 4); }
  ctx.fillStyle = INK; ctx.fillRect(left, top, width, height);
  ctx.fillStyle = style.hidden ? (style.blink ? SIGNAL : PAPER) : style.winner ? SIGNAL : PAPER;
  ctx.fillRect(left + 3, top + 3, width - 6, height - 6);
  drawText(ctx, label, left + width / 2, top + 7, scale, INK);
  if (style.winner) {
    const tag = Math.max(width, textWidth("HIGHEST!", 2) + 12);
    ctx.fillStyle = INK; ctx.fillRect(Math.round(left + width / 2 - tag / 2), top - 24, tag, 20);
    drawText(ctx, "HIGHEST!", left + width / 2, top - 20, 2, SIGNAL);
  }
}

/** Canonical Friend pixels: black mask with a one pixel white halo, clipped to the 80 x 80 box. Never altered. */
function drawFriend(ctx: CanvasRenderingContext2D, sprites: GenerationSprites, facing: "down" | "up" | "left" | "right", walking: boolean, frame: number, x: number, y: number) {
  const rows = spriteFrame(sprites, facing, walking, frame, "right").frame.rows;
  const pixels = rows.flatMap((row, py) => [...row].flatMap((pixel, px) => pixel === "#" ? [[px, py]] : []));
  const left = Math.round(x) - 40, top = Math.round(y) - 75;
  ctx.save(); ctx.beginPath(); ctx.rect(left, top, 80, 80); ctx.clip(); ctx.fillStyle = PAPER;
  for (const [px, py] of pixels) ctx.fillRect(left + px * 5 - 5, top + py * 5 - 5, 15, 15);
  ctx.fillStyle = INK;
  for (const [px, py] of pixels) ctx.fillRect(left + px * 5, top + py * 5, 5, 5);
  ctx.restore();
}

function drawTable(ctx: CanvasRenderingContext2D, potLabel: string, feeLabel: string) {
  const { half, halfDepth, lift } = TABLE, left = CENTER.x - half, top = CENTER.y - halfDepth - lift, width = half * 2, height = halfDepth * 2;
  ctx.fillStyle = INK;
  ctx.fillRect(left + 12, top + height + lift, 14, 22); ctx.fillRect(left + width - 26, top + height + lift, 14, 22);
  ctx.fillRect(left, top + height, width, lift);
  ctx.fillRect(left - 4, top - 4, width + 8, height + 8);
  ctx.fillStyle = PAPER; ctx.fillRect(left, top, width, height);
  ctx.fillStyle = INK;
  for (let y = top + 3; y < top + height; y += 6) for (let x = left + 3 + ((y - top - 3) / 6 % 2) * 3; x < left + width; x += 6) ctx.fillRect(x, y, 1, 1);
  ctx.fillStyle = PAPER; ctx.fillRect(left + 10, top + 8, width - 20, height - 16);
  ctx.fillStyle = INK; ctx.fillRect(left + 10, top + 8, width - 20, 2); ctx.fillRect(left + 10, top + height - 10, width - 20, 2);
  ctx.fillRect(left + 10, top + 8, 2, height - 16); ctx.fillRect(left + width - 12, top + 8, 2, height - 16);
  drawText(ctx, `POT ${potLabel}`, CENTER.x - 118, top + 16, 3, INK);
  drawText(ctx, `FEES ${feeLabel}`, CENTER.x + 112, top + 16, 3, INK);
}

export type RoomSceneProps = Readonly<{
  friendId: bigint; deal: Deal | null;
  /** Numbers opened so far in reveal order: the nine bots first, the Friend last. */
  revealed: number;
  reducedMotion: boolean; potLabel: string; feeLabel: string;
}>;

export function RoomScene({ friendId, deal, revealed, reducedMotion, potLabel, feeLabel }: RoomSceneProps) {
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 960, height: 640 });
  const [status, setStatus] = useState("Loading the room and your Friend…"), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [family, setFamily] = useState("");
  const live = useRef({ deal, revealed, reducedMotion, potLabel, feeLabel, family });
  live.current = { deal, revealed, reducedMotion, potLabel, feeLabel, family };
  const anim = useRef<{ deal: Deal | null; opened: Map<string, number>; last: number; finishedAt: number }>({ deal: null, opened: new Map(), last: 0, finishedAt: 0 });

  useEffect(() => {
    const node = wrap.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.min(entry.contentRect.width, entry.contentRect.height * 1.5);
      setSize({ width, height: width / 1.5 });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context) { setFailed(true); setStatus("This browser cannot render the room."); return; }
    const ctx = context, abort = new AbortController();
    let frame = 0;
    setFailed(false); setStatus("Loading the room and your Friend…");
    void Promise.all([loadWorldAssets(roomWorld, { signals: false }, abort.signal), createFriendReader().read(friendId)]).then(([assets, sprites]) => {
      if (abort.signal.aborted) return;
      setStatus(""); setFamily(sprites.familyName);
      const render = (now: number) => {
        const state = live.current, memory = anim.current, order = state.deal ? revealOrder(state.deal) : [];
        if (memory.deal !== state.deal) { memory.deal = state.deal; memory.opened = new Map(); memory.last = 0; memory.finishedAt = 0; }
        if (state.revealed !== memory.last) {
          for (let step = memory.last; step < state.revealed; step++) memory.opened.set(step < SEATS - 1 ? `bot${order[step]}` : "friend", now);
          if (state.revealed >= SEATS) memory.finishedAt = now;
          memory.last = state.revealed;
        }
        const moving = !state.reducedMotion, finished = Boolean(state.deal) && state.revealed >= SEATS;
        const sinceOpen = (key: string) => memory.opened.has(key) ? now - memory.opened.get(key)! : Infinity;
        const pop = (key: string) => moving && sinceOpen(key) < 260 ? Math.round(Math.sin(sinceOpen(key) / 260 * Math.PI) * 12) : 0;
        ctx.clearRect(0, 0, VIEW.width, VIEW.height); ctx.imageSmoothingEnabled = false;
        ctx.save(); ctx.translate(-VIEW.x, -VIEW.y); ctx.drawImage(assets.terrain, 0, 0); ctx.restore();
        const scene = () => {
          const botOpen = (index: number) => Boolean(state.deal) && order.indexOf(index) < state.revealed;
          const botWinner = (index: number) => finished && !state.deal!.won && state.deal!.bots[index]?.number === state.deal!.highest;
          const hop = (index: number) => botWinner(index) && moving ? Math.round(Math.abs(Math.sin((now - memory.finishedAt) / 160)) * 10) : 0;
          // Far side first: the Friend and four bots sit behind the table.
          FAR_BOTS.forEach(([px, py], slot) => drawBot(ctx, px, py, hop(slot), botWinner(slot)));
          const [fx, fy] = FRIEND_SEAT;
          const since = now - memory.finishedAt, won = finished && state.deal!.won;
          let facing: "down" | "left" | "right" = "down", walking = false, lift = 0, step = 0;
          if (finished && moving && won && since < 2200) { walking = true; lift = Math.round(Math.abs(Math.sin(since / 140)) * 14); step = Math.floor(now / 110) % 8; }
          else if (finished && moving && !won && since < 1400) { facing = since < 400 ? "left" : since < 800 ? "right" : "down"; }
          drawFriend(ctx, sprites, facing, walking, step, fx, fy - lift);
          drawTable(ctx, state.potLabel, state.feeLabel);
          NEAR_BOTS.forEach(([px, py], slot) => drawBot(ctx, px, py, hop(FAR_BOTS.length + slot), botWinner(FAR_BOTS.length + slot)));
          // Plates and names sit on top of everything.
          const label = (index: number) => state.deal && botOpen(index) ? String(state.deal.bots[index].number) : "?";
          BOT_SEATS.forEach(([px, py], index) => {
            const key = `bot${index}`;
            drawPlate(ctx, px, py - 52 - hop(index), label(index), { hidden: !botOpen(index), winner: botWinner(index), mine: false, lift: pop(key), blink: false });
            drawText(ctx, state.deal ? state.deal.bots[index].name : "", px, py + (index < FAR_BOTS.length ? 4 : 9), 2, INK);
          });
          const friendOpen = Boolean(state.deal) && state.revealed >= SEATS;
          const suspense = Boolean(state.deal) && state.revealed === SEATS - 1 && moving && Math.floor(now / 300) % 2 === 0;
          drawPlate(ctx, fx, fy - 84 - lift, friendOpen ? String(state.deal!.friendNumber) : "?", { hidden: !friendOpen, winner: won, mine: true, lift: pop("friend"), blink: suspense });
          drawText(ctx, `FRIEND ${friendId}${state.family ? ` - ${state.family}` : ""}`, fx, fy - 158 - lift, 2, INK);
          if (finished && moving && won && since < 2400) {
            for (let piece = 0; piece < 36; piece++) {
              const seed = (piece * 9301 + 49297) % 233280, spread = (seed % 400) - 200, drift = (seed % 97) / 97;
              const px = fx + spread + Math.round(Math.sin(since / 300 + piece) * 8), py = fy - 130 + Math.round(((since / 1000) * (90 + drift * 120) + drift * 60) % 230);
              ctx.fillStyle = piece % 2 ? SIGNAL : INK; ctx.fillRect(px, py, 6, 6);
              if (piece % 2) { ctx.fillStyle = INK; ctx.fillRect(px, py + 6, 6, 1); }
            }
          }
          if (finished && moving && !won && since < 1600) { ctx.fillStyle = INK; const dy = Math.floor(since / 60) % 8 * 2; ctx.fillRect(fx + 34, fy - 66 + dy, 4, 6); ctx.fillRect(fx + 35, fy - 68 + dy, 2, 2); }
        };
        // Props are sorted by depth; the table scene sits at the table's own depth.
        const layers = assets.objects.map(object => ({ depth: object.depth, draw: () => { ctx.save(); ctx.translate(-VIEW.x, -VIEW.y); ctx.drawImage(object.image, 0, 0); ctx.restore(); } }));
        layers.push({ depth: 480, draw: scene });
        layers.sort((a, b) => a.depth - b.depth).forEach(layer => layer.draw());
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => { if (!abort.signal.aborted) { setFailed(true); setStatus("The room or Friend artwork could not load. Check your connection and retry."); } });
    return () => { abort.abort(); cancelAnimationFrame(frame); };
  }, [friendId, attempt]);

  const items = [{ key: "friend", name: `Friend #${friendId}${family ? ` (${family})` : ""}`, number: deal?.friendNumber, winner: Boolean(deal?.won) },
    ...(deal?.bots ?? []).map((bot, index) => ({ key: `bot${index}`, name: `${bot.name}, bot, SIMULATED`, number: bot.number, winner: !deal!.won && bot.number === deal!.highest }))];
  const order = deal ? revealOrder(deal) : [];
  const open = (key: string) => key === "friend" ? revealed >= SEATS : order.indexOf(Number(key.slice(3))) < revealed;

  return <div className="fr-scene" ref={wrap}>
    <canvas ref={canvas} width={VIEW.width} height={VIEW.height} style={size} role="img"
      aria-label="A table with ten seats: your Friend and nine simulated bots. Each seat shows a number from 1 to 100 once it is opened." />
    <ul className="fr-sr" aria-label="Table numbers">
      {items.map(item => <li key={item.key} data-seat={item.key} data-number={deal && open(item.key) ? item.number : undefined} data-winner={deal && revealed >= SEATS ? String(item.winner) : undefined}>
        {item.name}: {deal && open(item.key) ? `number ${item.number}${revealed >= SEATS && item.winner ? ", highest" : ""}` : "not opened yet"}</li>)}
    </ul>
    {status && <div className="fr-scene-status" role={failed ? "alert" : "status"}><p>{status}</p>{failed && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry artwork</button>}</div>}
  </div>;
}
