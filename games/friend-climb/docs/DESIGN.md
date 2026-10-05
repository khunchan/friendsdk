# Friend Climb: stages 1–2 design

This is the technical/economic plan referenced from the main `README.md`'s "Status" line. Stage 0 (this
repo, today) is a free, fully simulated prototype on SDK v0.1.4 — nothing here is live or funded. Stages 1–2
describe what moving past that actually requires, and are **not implemented**; no code in this repo creates,
funds or moves anything. The numbers below (fees, splits, minimums) are a first proposal for the user to
confirm or change, same spirit as `SUMMIT_SCORE` in `tower.ts` being "a constant to retune."

## Why a staged plan, not one jump

Friend Climb's deterministic core (`tower.ts`) was built from day one so that a recorded run always replays
to the exact same outcome — that is what makes every stage below possible without rewriting the game itself.
Each stage only adds a layer around that core:

- **Stage 0 (done).** Fully client-side, fully simulated. No persistence (session-only), no identity beyond
  the connected Friend, no money. `game/platform.ts` already names the three seams (Identity, Persistence,
  Randomness) the next stages plug into, modeled on how `penalty-kings` actually did this — confirmed live on
  `rarefriends.com/arcade` on SDK v0.2.0, not a hypothetical.
- **Stage 1 (needs SDK v0.2+).** Real persistence (`ProgressStore` → Nakama-backed, per `game/platform.ts`'s
  own comment) and shared leaderboards/ghosts across players, not just this session. Still **no money** —
  this stage is about making "tower of the day" and practice feel like a real shared game, nothing more.
- **Stage 2 (this document's main subject).** Paid daily tournaments with a real prize pool. Needs Stage 1's
  persistence plus a server-side run verifier (separate module, same `tower.ts` core, deployed once this
  stage is actually funded — see "What this needs from SDK v0.2" below) and real on-chain settlement.

## What "free" stays free (Stage 2 and beyond)

- **Practice** (`Practice (new tower)`) and **Tower of the day** stay exactly as they are today: free, no
  wallet charge, no prize. They are the on-ramp — the free practice-page idea from the `penalty-kings`
  research (a standalone bundle of `tower.ts` with no SDK/wallet code at all, for play before even connecting
  a wallet) is a Stage 1 candidate, not gated behind any of the tournament mechanics below.
- Only a **separate, explicitly-entered daily tournament mode** (Stage 2) costs anything. A player who never
  touches that mode never pays for anything, ever.

## Daily tournament: proposed tokenomics

**Entry.** Approximately **$1**, paid in RF at the prevailing rate at entry time. **3 attempts** per entry;
the **best of the 3 scores** is the one that counts for that entry. **Re-entry is allowed** — a player may buy
another entry (another $1, another 3 attempts) and it stacks as a separate scored entry, not a replacement.

**Fee.** **12%** if paid in USDC, **9%** if paid in RF (RF is cheaper to process end to end, so the lower rate
passes that through rather than charging the same percentage either way). Of the fee itself: **75% to the
developer, 25% to Rare Friends**.

**Pool.** `pool = sum(entries) - fee`. The **entire pool is always distributed** — nothing is retained,
nothing rolls over to the next day.

**Payout, if at least one entrant reaches the summit (`SUMMIT_SCORE`, currently 25000):**
- **50% of the pool**, split **equally** among every entrant who summited that day (on any of their
  attempts/entries) — reaching the top is itself worth something, regardless of how fast.
- **50% of the pool**, to the **5 fastest climb times** among everyone who summited, split **40% / 25% / 15%
  / 12% / 8%** for 1st through 5th place. Climb time is `tower.ts`'s own deterministic tick count
  (`state.tick` at the summit, already tracked — see `RunState.summited`), never a wall-clock reading, so it
  is exactly reproducible from the winning run's code.

**Payout, if nobody reaches the summit that day:** the **entire pool** goes to the **top 5 by score**, same
**40% / 25% / 15% / 12% / 8%** split. Score ties would need a tiebreak rule (earliest submission, or shared
split) — not decided yet, flag for the next round of this doc.

**Minimum entrants.** A **minimum entrant count** (exact number not yet set — needs real traffic data from
Stage 1 to pick sensibly) is required for a day's tournament to actually run. Below that minimum, **all
entries for that day are refunded in full**, no fee taken.

## What this needs from SDK v0.2 (beyond what Stage 1 already needs)

- **Real on-chain or card payment rails** for the $1 entry and payouts — this repo has never implemented
  wallet/payment code itself (see AGENTS.md's "Prototype scope" rule) and SDK v0.1.4 has no such rails; v0.2.0
  (per the `penalty-kings` precedent) does.
- **A server-side run verifier**, scoped to money-bearing tournament runs only — never every practice/daily
  climb — following the exact rule `penalty-kings` already proved out in production ("server verification
  matters only when a kick decides a prize"). Shape: a thin, stateless wrapper around `tower.ts` (already
  pure, zero SDK/wallet dependencies, same as `penalty-kings`' own `packages/engine`): accept a submitted run
  code, replay it with `simulate()`, compare the replayed score/summit status against what was claimed, and
  either confirm or reject. This is Stage 2's own separate build item, tracked outside this document.
- **A source of randomness no player can bias**, if any part of entry/payout ever depends on one (today's
  tower generation is a public seed — `seedForDate` for the daily tower — which is already fine precisely
  because it is symmetric and public; this only matters if a *future* mechanic needed a value no one could
  predict in advance, which none of the above currently does).
- **Nakama-backed persistence** (Stage 1's own requirement) so a day's entries/attempts/scores survive across
  sessions and players, not just the open tab.

## Legal/trust groundwork to do before this goes live

Flagged by the `penalty-kings` research as what the platform actually required before promoting a paid game
live: an 18+ gate, a restricted-region notice, responsible-play copy, odds/payout structure disclosed before
purchase (this document is the start of that disclosure), no "you will win" language, and a dedicated
`STATUS.md`-style ledger once any of this is real (`penalty-kings`' own convention: live-on-chain / real-but-
not-deployed / simulated-and-labelled, with every simulated economic figure in the UI marked as such). None of
this exists yet because nothing here is real yet; Stage 2 should not ship without it.

## Open questions for the next round

1. Exact minimum-entrant threshold (needs Stage 1 traffic data).
2. Score-tie handling in the "nobody summited" payout.
3. Whether `SUMMIT_SCORE` (25000) is the right bar once there is real playtesting data on how long that takes
   at a realistic pace — it is a plain constant in `tower.ts` specifically so this is cheap to revisit.
4. Whether re-entries on the same day should have any cap, or stay unlimited as proposed above.
