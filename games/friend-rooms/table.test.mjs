// Run from the SDK root: node --test games/friend-rooms/table.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { simulate } from './simulate.mjs';

const bundle = await build({ entryPoints: [new URL('./table.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const table = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const game = JSON.parse(await readFile(new URL('./game.json', import.meta.url), 'utf8'));

/** Small seeded generator so every failure is reproducible. */
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
const numbersOf = deal => [deal.friendNumber, ...deal.bots.map(bot => bot.number)];

test('every table has ten unique numbers from 1 to 100 and nine uniquely named bots', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const deal = table.dealTable(seed % 2 === 0, seeded(seed));
    const numbers = numbersOf(deal);
    assert.equal(numbers.length, table.SEATS);
    assert.equal(new Set(numbers).size, table.SEATS, `seed ${seed}: no repeated numbers`);
    assert(numbers.every(number => Number.isInteger(number) && number >= 1 && number <= table.NUMBER_MAX));
    assert.equal(deal.bots.length, table.SEATS - 1);
    assert.equal(new Set(deal.bots.map(bot => bot.name)).size, table.SEATS - 1, `seed ${seed}: bot names differ`);
    assert.equal(deal.highest, Math.max(...numbers));
  }
});

test('the Friend holds the highest number exactly when the SDK result is a win', () => {
  for (let seed = 1; seed <= 1000; seed++) {
    const won = table.dealTable(true, seeded(seed)), lost = table.dealTable(false, seeded(seed + 7000));
    assert.equal(won.friendNumber, won.highest); assert.equal(won.gap, 0); assert.equal(won.won, true);
    assert(lost.friendNumber < lost.highest, `seed ${seed}: a loss is never the highest number`);
    assert.equal(lost.gap, lost.highest - lost.friendNumber); assert.equal(lost.won, false);
    assert(won.bots.every(bot => bot.number < won.friendNumber), 'no bot beats a winning Friend');
    assert(lost.bots.some(bot => bot.number === lost.highest), 'a bot holds the highest number after a loss');
  }
});

test('after a loss the Friend lands evenly among the nine lower places', () => {
  const places = new Array(9).fill(0), random = seeded(42), trials = 18000;
  for (let trial = 0; trial < trials; trial++) {
    const deal = table.dealTable(false, random);
    places[numbersOf(deal).filter(number => number > deal.friendNumber).length - 1]++;
  }
  for (const count of places) assert(Math.abs(count / trials - 1 / 9) < 0.02, `place counts ${places}`);
});

test('bots open from the lowest number up and the Friend is never in the bot order', () => {
  const deal = table.dealTable(false, seeded(9)), order = table.revealOrder(deal);
  assert.equal(order.length, table.SEATS - 1);
  assert.deepEqual([...order].sort((a, b) => a - b), deal.bots.map((_, index) => index));
  const opened = order.map(index => deal.bots[index].number);
  assert.deepEqual(opened, [...opened].sort((a, b) => a - b));
});

test('result text shows the gap after a loss', () => {
  assert.equal(table.describeResult({ friendNumber: 87, highest: 92, gap: 5, won: false, bots: [] }), 'Your 87 — 5 short of 92');
  assert.equal(table.describeResult({ friendNumber: 92, highest: 92, gap: 0, won: true, bots: [] }), 'Your 92 is the highest number.');
});

test('the table money follows the game definition: each ticket splits into a pot share and a 10% table fee', () => {
  const price = BigInt(game.price), prize = game.outcomes.reduce((max, outcome) => BigInt(outcome.reward) > max ? BigInt(outcome.reward) : max, 0n);
  const economy = table.tableEconomy(price, prize);
  assert(economy, 'game.json describes a table with a 10% fee');
  assert.equal(economy.fee, price / 10n, 'the table fee is a tenth of the ticket');
  assert.equal(economy.entry, price - economy.fee, 'the rest of the ticket goes into the pot');
  assert.equal(economy.entry + economy.fee, price);
  assert.equal(economy.pot, 10n * economy.entry, 'ten entries fill the pot');
  assert.equal(economy.pot, prize, 'the highest number takes the whole pot, which is exactly the top prize');
  assert.equal(economy.tableFees, 10n * economy.fee);
  assert.equal(economy.pot + economy.tableFees, 10n * price, 'pot plus fees equal what ten seats pay in');
  assert.equal(table.tableEconomy(price, 8n * price), null, 'a different payout is not shown as a table with a 10% fee');
  assert.equal(table.tableEconomy(price, 0n), null);
});

test('game.json keeps the 10% chance, the 9x prize and a 90% return', () => {
  const price = BigInt(game.price);
  assert.equal(game.outcomes.reduce((sum, outcome) => sum + outcome.chanceBps, 0), 10000);
  const win = game.outcomes.find(outcome => BigInt(outcome.reward) > 0n);
  assert.equal(win.chanceBps, 1000); assert.equal(BigInt(win.reward), 9n * price);
  const expected = game.outcomes.reduce((sum, outcome) => sum + BigInt(outcome.reward) * BigInt(outcome.chanceBps), 0n) / 10000n;
  assert.equal(expected * 10n, price * 9n, 'expected reward is 90% of the ticket price');
});

test('career tracks games, wins, best number and win streaks', () => {
  const deal = (won, friendNumber) => ({ won, friendNumber, highest: won ? friendNumber : 99, gap: 0, bots: [] });
  let career = table.NEW_CAREER;
  for (const step of [deal(true, 95), deal(true, 90), deal(false, 40), deal(true, 97)]) career = table.recordRound(career, step);
  assert.deepEqual({ ...career }, { played: 4, wins: 3, bestNumber: 97, streak: 1, bestStreak: 2 });
});

test('10,000 plays through the SDK preview client match the numbers in the README', async () => {
  const result = await simulate({ plays: 10_000, seed: 20260920 });
  assert.equal(result.wins, 989); assert.equal(result.spentRf, 10_000); assert.equal(result.redeemedRf, 8_901);
  assert.equal(result.tableChecks, 10_000);
  assert.equal(result.wholeTableFeesRf, 10_000); assert.equal(result.playerTableFeesRf, 1_000);
  const other = await simulate({ plays: 10_000, seed: 7 });
  assert(Math.abs(other.winRate - 0.1) < 0.015, `win rate ${other.winRate} stays near 10%`);
  assert(Math.abs(other.returnRate - 0.9) < 0.14, `return ${other.returnRate} stays near 90%`);
});
