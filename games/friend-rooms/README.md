# Friend Rooms

SDK version **v0.1**. Your Rare Friend walks through a black-and-white isometric hall to a numbered
room door. Behind the working door, ten seats share one table: your Friend and nine simulated bots. Every seat draws a
unique number from 1 to 100 and the highest number wins.

**Everything is simulated.** Prices, balances and prizes use the SDK preview ledger; the table fee and its burn are a labeled model.
Nothing is sent on-chain. An owned Generations NFT is still required; the SDK runtime checks it.

**Playable preview:** https://khunchan.github.io/friendsdk/ (a static build from commit `b44a4b5`). You need a browser wallet holding a hardwired Rare Friends
Generations NFT (generation 1 or higher) on Robinhood mainnet; the SDK verifies ownership before play. Everything is
simulated, so no RF, private key or transaction signature is needed. The SDK panel says "Local preview": that is the SDK's
label for its simulated mode. The Rare Friends team [welcomed this hosted preview](https://github.com/spokesz/rarefriends-vibeathon/pull/7#issuecomment-5748019728).

## Screenshots

![One game: the numbers open one by one, bots from the lowest up and the Friend last, then a win with HIGHEST! and +9 RF SIMULATED](media/round.gif)

*One game, played at x1 speed: bots open from the lowest number up, the Friend's number opens last, then the win.*

| Hall with the working door and three locked doors | Table during the reveal (closed plates show ?) |
| --- | --- |
| ![The hall: Room 100 RF is open, Rooms 1,000, 10,000 and 100,000 RF are locked](media/hall.png) | ![The table mid-reveal, some plates still closed](media/reveal.png) |
| **A win: HIGHEST! and +9 RF SIMULATED** | **Session receipt** |
| ![A win at the table](media/win.png) | ![The session receipt](media/receipt.png) |

*These images come from the game running in the SDK's public runner with the SDK's mocked, read-only test wallet and its
sample Friend #7730. The preview rolls are scripted (a loss, a win, a loss) so that a win can be shown; all amounts are
simulated. Regenerate them with `node games/friend-rooms/capture-media.mjs` (needs Python 3 with Pillow).*

## How to play

- Move with WASD, the arrow keys, or tap/click a destination. Walk to a door and press E (or tap its label).
- The **Room 100 RF** door opens the room menu. Choose how many games to play, then confirm the SDK prompts:
  one to buy the tickets and one to use them. Your Friend then plays every game on its own.
- Use **Stop after this game** to pause a run. Unfinished games stay with your Friend; **Resume** settles those
  same games and never buys or uses another ticket.
- Winnings wait in your inventory until you press **Collect winnings** (one more SDK prompt).
- Sound is off by default. The small **Sound** button in the top bar (in the hall and at the table) and the button in Settings turn it on and off; each says whether sound is on or off and what pressing it does. Settings also has reduce motion, which is also read from your system setting.
- The three other doors (Room 1,000 / 10,000 / 100,000 RF) are locked: they need future SDK support.

## Rules and economy

| Rule | Exact value |
| --- | --- |
| Room shown on the working door | Room 100 RF (design size) |
| Preview ticket | 1 RF (`1000000000000000000` base units). The SDK preview wallet is fixed at 20 RF, so the room runs at 1/100 of its design size |
| Highest number | 10% (1,000 basis points), prize 9 RF |
| Lower number | 90% (9,000 basis points), prize 0 RF |
| Expected reward | 0.9 RF per ticket (90% return) |
| Table | 10 seats: your Friend plus 9 simulated bots, always full |
| Ticket split | Each 1 RF ticket splits at entry: 0.9 RF goes into the pot and 0.1 RF (10%) is a table fee, burned in the model |
| Pot | 10 seats x 0.9 RF = 9 RF. The highest number takes the whole pot, which is exactly the 9 RF prize |
| Backing | Each ticket reserves 9 RF of prize backing, so one run is limited to 11 games in the SDK preview |
| Redemption | Fixed value, no expiry, paid to the selected Friend's wallet in a future approved integration |

**The SDK result decides your outcome.** After each game the SDK settles the ticket. The table is then dealt to match it:
a win gives your Friend the highest number, a loss gives it one of the lower numbers, chosen evenly. Because one table
seat in ten wins, this matches the 10% chance in `game.json`. The numbers and bots are presentation only.

**The table fee is a model.** The fee is separated from the pot when you enter, not taken from the winnings at the end;
the odds and amounts are the same either way. SDK v0.1 does not burn RF: the whole 1 RF ticket stays in the preview ledger
as game backing, and the SDK pays the 9 RF prize from it. The menus and the receipt label the fee "burned in the model"
because it models a future room contract. Bot tickets and bot fees are simulated too.

## Measured behavior

The check plays tickets through the SDK preview client (`createGamePreview`, batches of 99 like the runtime bridge),
settles every play, redeems every win and confirms that the SDK ledger adds up. Each settled play also deals a table
and checks that the Friend holds the highest number exactly when the SDK result is a win.

| Run | Plays | Wins | Win rate (95% interval) | RF spent | RF redeemed | Measured return |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Seed 20260920 (reproducible) | 10,000 | 989 | **9.89%** (9.32% to 10.49%) | 10,000 | 8,901 | **89.01%** |
| Expected from `game.json` | | | 10.00% | | | 90.00% |

*Measured 9.89% win rate over 10,000 preview plays; the average reward was 0.8901 RF per 1 RF ticket.* The seed was
fixed before the run and not chosen afterwards. Two one-off runs with the SDK's own browser randomness agree: 9.85% and
88.65% return over 10,000 plays, and 9.93% and 89.34% over 100,000 plays. With 10,000 plays the win rate has a standard
error of about 0.3 points and the return about 2.7 points, so differences of this size are expected.

In the model, the table fees of those 10,000 games came to 10,000 RF in total (1 RF per table, simulated bots included), and
your Friend's own fees were 0.1 RF per game, 1,000 RF. These fees are a model; the SDK preview does not burn RF.

Reproduce it from the SDK root: `node games/friend-rooms/simulate.mjs 10000 20260920` (leave out the seed to use the SDK's
randomness). `table.test.mjs` pins the seeded numbers above, so this section cannot drift from the code.

## Design decisions

- **Scale 1/100.** The SDK preview wallet is fixed at 20 RF, so "Room 100 RF" is played with 1 RF tickets. The ratios (a 10% table fee, a 9x prize) are the same as at full size.
- **The fee is separated at entry.** Each ticket splits into 0.9 RF for the pot and 0.1 RF for the table fee. The pot is known in full from the start, and in a future contract the fee pays the costs of a round before the rest is burned. Odds and amounts are the same as taking 10% at the end.
- **Bots are tokens, not Friends.** Neighbors are plain round tokens marked SIMULATED, so no Friend artwork is faked. In a real room they would be real Friends at the same scale.
- **Burn example (estimate).** At the 100 RF level a table of 10 players pays 100 RF in table fees. If the costs of that round are about $0.10 (about 32 RF at the estimated prices below), about 68 RF per table is burned, so 1,000 such tables burn about 68,000 RF. Estimate as of 2026-09-20; see "Minimum ticket size".
- **A tournament prize is always covered.** A tournament starts only with a minimum number of entrants, or its prize grows with the number of entry fees paid, so the prize never depends on money that has not come in.
- **Several accounts give no edge.** Sitting at a duel table against yourself is pointless: both seats have equal chances and the table fee is paid anyway. Every ticket keeps the same 90% average return, so extra accounts cannot beat the table.

## Future SDK support

**Roadmap in five steps**

1. **Duel:** two real players at one table of 2 (needs shared rooms and a room contract).
2. **Rounds on a timer:** tables of 2 to 10 for whoever has signed up, with one keeper transaction and one Dice randomness per round.
3. **Stake levels:** the locked doors, Room 1,000 / 10,000 / 100,000 RF, become playable.
4. **Tournaments with an NFT prize:** a bracket of tables of 10 ending in a final table (needs wearable NFTs and NFT prizes).
5. **A Friend's own world as style:** the hall takes its look from the selected Friend's Scenery and Floor.

Friend Rooms is a preview. A real version needs SDK capabilities that do not exist in v0.1. Nothing in this game
pretends otherwise: every amount is labeled SIMULATED and the locked doors say so.

| Needed capability | Why | In this preview |
| --- | --- | --- |
| Shared rooms with real players | Table seats filled by other owners' Friends | Nine simulated bots |
| Several ticket tiers (Room 100 / 1,000 / 10,000 / 100,000 RF) | Different stakes | One ticket type; the locked doors show the plan |
| A room contract with one allowance | Approve once, then sign up for rounds without a prompt each time | Preview ledger; the SDK asks to confirm buy and use |
| A round timer, a keeper bot and unattended settlement | Rounds start on a timer (for example once a minute), not when a hall fills. A keeper settles every table of the round without a player click | The player's own client settles; the table is always full |
| Seating at tables of 2 to 10 | Everyone who signed up in time is seated at tables of up to 10. A table needs at least 2 players; a player left alone waits for the next round or gets the whole ticket back | One table of 10 with 9 bots |
| One Dice randomness per round | A single random value, used in a single transaction, gives the numbers of every table in the round | Browser randomness; numbers are dealt to match the SDK result |
| A table fee separated from the pot at entry | Each ticket is split when a player signs up: the pot share goes to the pot and the fee is set aside. A player left without an opponent gets the whole ticket back | Shown in the menus and the receipt only |
| Gas and randomness paid from the table fees | Players pay only the ticket; the costs of a round are shared by all its players | Not modeled |
| Burning the remainder of the fees at once | The fees pay the round's costs first and the rest is burned immediately, not at the end | A labeled model, not executed |
| Reading shared round state from game code | Who has signed up, the tables and their results | Not available |
| A choice of table size (optional) | A duel (2 players) or a full table (10): the same 90% average return, a different risk | One table size |
| Tournaments | Special events with an NFT prize: a bracket of tables of 10 whose winners meet at a final table of 10 real Friends. Needs wearable NFTs, NFT prizes and tournament contracts | Not available |
| A preview wallet larger than 20 RF | Play a real 100 RF ticket | The room runs at 1/100 scale |
| Friend traits as a style source | Scenery, Floor and Generation could style the hall | One hall (Circuit Courtyard) for every Friend |

### How real Friends join rooms

In this preview every neighbor is a bot. In a future version a room is played in rounds, and a round is made of tables. (In
this preview one ticket is one "game"; below, a "round" is one timer-started batch of tables.)

1. **The unit of play is a table of up to 10 seats.** The rooms (100, 1,000, 10,000 and 100,000 RF) are stake levels, not
   sizes. A player sees only their own table, with neighbors at the scale of today's table, and the numbers of that table
   open exactly as in this preview. One screen cannot hold 100 Friends, and opening 100 numbers one by one would take far
   too long.
2. **The room lives in a contract.** It holds the list of players who signed up for the next round and the results of past
   rounds.
3. **Players sign up with one allowance.** A player approves RF once; signing up then takes one transaction. The ticket is
   split at entry: 0.9 of it goes into the pot and 0.1 is the table fee.
4. **Rounds run on a timer,** for example once a minute, not when a hall fills. Everyone who signed up in time is seated at
   tables of up to 10. A table needs at least 2 players: a player left alone waits for the next round or gets the whole
   ticket back.
5. **Any table of n players (2 to 10) works the same way.** Its pot is n x 0.9 x ticket and the highest number takes it, so
   every player has a 1/n chance and the average return is 90%. The player could also choose the table size: a duel (2) and
   a full table (10) have the same average return but different risk.
6. **One keeper transaction and one Dice randomness per round.** Anyone can act as keeper. The keeper asks Dice for one
   random value and settles every table of the round in one transaction. Each table's numbers are derived from that value,
   so every client can recompute them, and the costs are shared by all players of the round.
7. **Each player's client reads the result of their own table from the chain** and draws its real participants with their
   canonical Friend sprites.

**Why rounds on a timer.** At launch there will be few players. A room that waits for a full hall would stay empty, while a
timer runs a round with whoever has signed up, even two players. Nobody waits for a crowd, and liquidity can build up
gradually.

A contract is better than a separate server because fairness can be checked on-chain. No operator can pick the winners, hold
the pots or replay a round, and anyone can recompute every table from the published randomness. If a keeper goes offline,
another one can start the round. What the SDK lacks for this: reading shared round state from game code, multiplayer room
contracts, and timers with unattended settlement.

### Tournaments

Large rooms are needed only for tournaments: special events with an NFT prize, for example a wearable inventory item for a
Friend.

- **A bracket of the same tables of 10.** 100 entrants play 10 qualifying tables. The 10 table winners sit at a final table
  of 10, and the winner of the final gets the NFT. 1,000 entrants take three stages: 100 tables, then 10 tables, then the
  final.
- **Every player always sees one table of 10.** The final table is a shared show with 10 real Friends.
- **The entry fee is paid in RF.** Part of it is burned and part goes to the prize.
- **What the SDK lacks:** wearable NFTs, NFT prizes and tournament contracts. None of them exists in v0.1.

### Minimum ticket size (estimate)

Prices for ETH and RF move a lot, so the rule is a formula, not a fixed number. A round is viable while its costs are no more
than its table fees:

```text
round costs (USD) = (gas + RNG fee, in ETH) x ETH price
table fees  (USD) = 10% x players in the round x ticket (RF) x RF price
viable when round costs <= table fees, so
minimum ticket (RF) = round costs / (10% x players in the round x RF price)
```

All tables of a round are settled in one transaction with one Dice randomness, so the costs are shared by every player of the
round, not only by the players of one table.

Fee model: the 10% table fee is separated from the pot when a player signs up. It pays the actual costs of the round (gas and
randomness) first, and whatever is left is burned immediately. The pot is never touched, and a player left without an
opponent gets the whole ticket back. If costs exceed the fees, the round should not start and its players wait for the next
one.

*Estimate as of 2026-09-20. Inputs: ETH about $2,450 and 100,000 RF about 0.128 ETH (a community tracker, not independently
verified), so 1 RF is about $0.0031. The SDK caps a Dice request at 0.000025 ETH (about $0.06); gas is an assumption, and
round costs are taken as about $0.10 in total. Rare Friends plans to subsidize randomness costs, which would lower this.
Settling many tables in one transaction adds some gas, so the real cost of a large round would need to be measured.*

With 10 players in the round (one table):

| Ticket | Paid in by 10 players | Table fees (10%) | Fees / costs | Burned after costs |
| ---: | ---: | ---: | ---: | ---: |
| 1 RF | $0.03 | $0.003 | 0.03x, not viable | none |
| 10 RF | $0.31 | $0.031 | 0.31x, not viable | none |
| 100 RF | $3.14 | $0.314 | 3.1x | about 68% of the fees |
| 1,000 RF | $31.36 | $3.14 | 31x | about 97% |
| 10,000 RF | $313.60 | $31.36 | 314x | about 100% |
| 100,000 RF | $3,136 | $313.60 | 3,136x | about 100% |

With 10 players in the round the minimum is about 32 RF, so 100 RF is the smallest listed room that works. The minimum
falls in proportion to the number of players who share the costs of a round. That is why the working door is Room 100 RF:
it stays viable even when a round has only 10 players.

Protections a future contract should have: the RF/ETH rate comes from a time-weighted average price (TWAP) of a pool, not the
spot price; a round does not start when its costs are above a threshold; and the minimum denomination is a configurable
parameter, not a constant.

### A Friend's own world as style

Every Friend has on-chain Scenery and Floor traits (for example Industrial or Rooftop, Plain or Hatch), and its world reflects
its generation. SDK v0.1 does not give game code access to them, and its six world presets do not cover every Scenery value.
A future SDK could expose these traits and a matching set of worlds. The hall layout would stay the same for everybody, and
only its style (floor, decor, objects) would follow the selected Friend.

## Files

`index.tsx` (hall, door menu, SDK flow), `room.tsx` (table scene), `table.ts` (numbers, economy, career), `table.test.mjs`
(unit tests), `simulate.mjs` (10,000-play measurement), `check-browser.mjs` (browser check), `capture-media.mjs` and `assemble-media.py`
(the images in `media/`), `game.json` (ticket price and outcomes).

## Checks

Run on 2026-09-20 with SDK v0.1 and Node.js 22, from the SDK root:

| Command | Result |
| --- | --- |
| `npm test` | 111 tests: 109 passed, 0 failed, 2 skipped (they need Foundry, which is not installed here) |
| `npm run typecheck` | passed |
| `npm run check:games` | passed, including `games/friend-rooms` |
| `npm run check:browser` | all SDK browser checks passed. They cover the SDK runtime and examples, not this game |
| `node --test games/friend-rooms/table.test.mjs` | 9 passed: table rules, economy and the 10,000-play measurement |
| `node games/friend-rooms/check-browser.mjs` | passed at 1100 px and 360 px with the SDK's mocked, read-only wallet fixture: canonical Friend movement, locked door, buy and use through the SDK, table numbers, receipt, Stop and Resume, Collect winnings, settings, container bounds and no button under the SDK toolbar |

The browser check needs `npx playwright install chromium` once.

## Known limits

- The SDK preview wallet is fixed at 20 RF, so tickets cost 1 RF (Room 100 RF at 1/100 scale) and one run is limited to 11 games by the prize backing.
- Bots, the shared table and the table fee burn are simulated; SDK v0.1 has no shared rooms and does not burn RF.
- Progress resets when the preview session ends.
- On a 360 px wide screen the SDK container is only 360 x 240, so the table is small.
- Automated checks use a mocked wallet and a sample Friend. The builder played more than 40 games by hand with a real wallet and two Friends: Generation 2 (Cellular) and Generation 4 (Skeleton).
