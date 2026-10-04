/**
 * The ONLY seams between Friend Climb's own code and the platform it runs on. Modeled directly on
 * penalty-kings' game/platform.ts — the exact pattern Rare Friends used to fork that game onto SDK v0.2.0
 * with a Nakama backend and real on-chain/card payments (confirmed live on rarefriends.com/arcade). Every
 * other file in this game is meant to talk to these interfaces, never to a wallet, a backend or a random
 * source directly, so bringing Friend Climb's own persistence/money layer online later means swapping the
 * implementations wired up in `defaultPlatform()` below — not touching tower.ts, index.tsx or any test.
 *
 * Today (SDK v0.1.4, fully simulated, no money on the line anywhere):
 * - Identity is exactly what GameComponentProps already gives the component — nothing to seam here at all;
 *   penalty-kings found the same thing (a loaned Friend is still just a runtime-verified friendId).
 * - Persistence is session-only: the sandboxed iframe has no localStorage/IndexedDB (HOST_INTEGRATION.md),
 *   so "saving" just keeps an in-memory array alive for as long as the tab is open — the same thing index.tsx
 *   already did with plain useState before this file existed, just behind a named interface now.
 * - Randomness is a plain client-side crypto seed. That is fine today because no run here decides a real
 *   prize; it stops being fine the moment one does (see the INTEGRATION POINT comment below).
 */

import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import type { Transition } from "../tower";

/** Who is playing. Unchanged across the integration — a loaned or owned Friend is still just a
 * runtime-verified friendId plus the fixed action client the SDK sandbox already supplies. */
export type Identity = Readonly<{ friendId: GameComponentProps["friendId"]; client: GameComponentProps["client"] }>;

export type RunRecord = Readonly<{ seed: number; transitions: readonly Transition[]; score: number }>;

/** Where a player's own past runs/best scores live between sessions.
 * INTEGRATION POINT: swap for Nakama-backed storage when this game moves to a platform fork with real
 * persistence (see penalty-kings' ProgressStore / remoteProgressStore) — everything that calls `load`/`save`
 * stays unchanged. */
export type ProgressStore = Readonly<{
  load: () => readonly RunRecord[];
  save: (runs: readonly RunRecord[]) => void;
}>;

/** Where an unpredictable number no player could have precomputed comes from.
 * INTEGRATION POINT: today's seed is plain client-side crypto, which is fine only because nothing here
 * decides a real prize yet. Once a run can win RF, swap this for a commit-then-public-beacon scheme
 * (penalty-kings' game/randomness.ts / docs/RNG-INTEGRATION.md: hash the deterministic inputs *before* the
 * beacon round that will seed them is even known, so a result can never be chosen after the fact) — and keep
 * server verification scoped to money-bearing runs only, never every climb, same as their rule. */
export type RandomnessSource = Readonly<{ nextSeed: () => number }>;

export type Platform = Readonly<{ identity: Identity; progress: ProgressStore; randomness: RandomnessSource }>;

const memoryProgress: RunRecord[] = []; // session-only: lost on reload, matching today's actual behavior exactly

function sessionProgressStore(): ProgressStore {
  return {
    load: () => Object.freeze(memoryProgress.slice()),
    save: runs => { memoryProgress.length = 0; memoryProgress.push(...runs); },
  };
}

function clientRandomness(): RandomnessSource {
  return {
    nextSeed: () => { const words = new Uint32Array(1); crypto.getRandomValues(words); return words[0]; },
  };
}

export function defaultPlatform(identity: Identity): Platform {
  return { identity, progress: sessionProgressStore(), randomness: clientRandomness() };
}
