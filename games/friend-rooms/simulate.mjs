// Plays many tickets through the SDK preview client and measures the win rate and the return.
// Run from the SDK root: node games/friend-rooms/simulate.mjs [plays] [seed]
// With a seed the SDK preview roll is reproducible; without one it uses the SDK's browser randomness.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createGamePreview, parseChanceGame, RF } from '../../dist/game.js';

const bundle = await build({ entryPoints: [new URL('./table.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const table = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const definition = parseChanceGame(JSON.parse(await readFile(new URL('./game.json', import.meta.url), 'utf8')));

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wilson score interval for a win rate at 95% confidence. */
function wilson(wins, plays) {
  const z = 1.96, p = wins / plays, denominator = 1 + z * z / plays;
  const centre = (p + z * z / (2 * plays)) / denominator, margin = z * Math.sqrt(p * (1 - p) / plays + z * z / (4 * plays * plays)) / denominator;
  return [centre - margin, centre + margin];
}

export async function simulate({ plays = 10_000, seed } = {}) {
  const random = seed === undefined ? undefined : seeded(seed);
  const start = 1_000_000n * RF;
  const preview = createGamePreview(definition, { stake: start * 10n, rfBalance: start, ...(random ? { draw: () => Math.floor(random() * 10_000) } : {}) });
  const client = preview.client, prize = definition.outcomes.reduce((max, outcome) => outcome.reward > max ? outcome.reward : max, 0n);
  const dealRandom = random ?? Math.random;
  let played = 0, wins = 0, redeemed = 0n, tableChecks = 0;
  while (played < plays) {
    // Batches of 99, the largest quantity the SDK bridge accepts.
    const batch = Math.min(99, plays - played);
    await client.buy(BigInt(batch));
    const started = await client.play(BigInt(batch));
    let batchWins = 0n;
    for (const play of started) {
      const result = await client.settle(play.id), won = definition.outcomes[result.outcomeId - 1].reward === prize;
      const deal = table.dealTable(won, dealRandom);
      // The dealt table must agree with the SDK result: the Friend holds the highest number exactly on a win.
      if ((deal.friendNumber === deal.highest) !== won) throw new Error('The dealt table disagrees with the SDK result.');
      tableChecks++;
      if (won) { wins++; batchWins++; }
    }
    if (batchWins > 0n) { await client.redeem(definition.outcomes.findIndex(outcome => outcome.reward === prize) + 1, batchWins); redeemed += batchWins * prize; }
    played += batch;
  }
  const final = await client.read(), spent = BigInt(plays) * definition.price;
  if (final.rfBalance !== start - spent + redeemed) throw new Error('The SDK ledger does not add up.');
  const economy = table.tableEconomy(definition.price, prize);
  return {
    plays, seed: seed ?? null, wins, winRate: wins / plays, winRateInterval95: wilson(wins, plays),
    spentRf: Number(spent / RF), redeemedRf: Number(redeemed / RF), returnRate: Number(redeemed) / Number(spent),
    averageRewardPerTicketRf: Number(redeemed) / Number(RF) / plays, tableChecks,
    modelBurnAtTablesRf: Number(economy.burn * BigInt(plays) / RF), modelBurnShareOfPlayerRf: Number(economy.burnShare * BigInt(plays)) / Number(RF),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const plays = Number(process.argv[2] ?? 10_000), seed = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  const result = await simulate({ plays, seed });
  const percent = value => `${(value * 100).toFixed(2)}%`;
  console.log(JSON.stringify(result, null, 2));
  console.log(`measured ${percent(result.winRate)} win rate over ${result.plays.toLocaleString('en-US')} preview plays (95% interval ${percent(result.winRateInterval95[0])} to ${percent(result.winRateInterval95[1])}); return ${percent(result.returnRate)}`);
}
