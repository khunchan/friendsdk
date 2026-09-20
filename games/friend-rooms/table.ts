/**
 * Table rules for Friend Rooms. Everything here is presentation built around the SDK result:
 * the SDK ticket outcome decides whether the Friend wins, and the numbers are dealt to match it.
 */
export const SEATS = 10;
export const NUMBER_MAX = 100;
/** Short simulated neighbours. Plain tokens, never Friend artwork. */
export const BOT_NAMES = [
  "Pip", "Moss", "Dot", "Byte", "Rook", "Wick", "Fern", "Zed",
  "Nib", "Lark", "Ash", "Orb", "Tack", "Bolt", "Cog", "Sprig",
] as const;

export type Random = () => number;
export type Bot = Readonly<{ name: string; number: number }>;
export type Deal = Readonly<{
  friendNumber: number; bots: readonly Bot[]; highest: number; won: boolean;
  /** How far the Friend's number is below the highest number; 0 for a win. */
  gap: number;
}>;

/** Presentation randomness only. Paid results come from the SDK. */
export function secureRandom(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return (words[0] * 2 ** 21 + (words[1] >>> 11)) / 2 ** 53;
}

function shuffle<T>(items: readonly T[], random: Random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

/**
 * Deal SEATS unique numbers from 1..NUMBER_MAX. A win gives the Friend the highest number at the table.
 * A loss gives the Friend one of the other numbers, chosen evenly, so the table looks like a fair draw.
 */
export function dealTable(won: boolean, random: Random = secureRandom): Deal {
  const pool = Array.from({ length: NUMBER_MAX }, (_, index) => index + 1);
  const drawn = shuffle(pool, random).slice(0, SEATS).sort((a, b) => b - a);
  const friendIndex = won ? 0 : 1 + Math.floor(random() * (SEATS - 1));
  const friendNumber = drawn[friendIndex], highest = drawn[0];
  const names = shuffle(BOT_NAMES, random);
  const bots = shuffle(drawn.filter((_, index) => index !== friendIndex), random)
    .map((number, index) => ({ name: names[index], number }));
  return Object.freeze({ friendNumber, bots: Object.freeze(bots), highest, won, gap: highest - friendNumber });
}

/** Bots open from the lowest number up. The Friend's number always opens last. */
export function revealOrder(deal: Deal): readonly number[] {
  return deal.bots.map((bot, index) => ({ bot, index })).sort((a, b) => a.bot.number - b.bot.number).map(entry => entry.index);
}

export function describeResult(deal: Deal): string {
  return deal.won
    ? `Your ${deal.friendNumber} is the highest number.`
    : `Your ${deal.friendNumber} — ${deal.gap} short of ${deal.highest}`;
}

export type Economy = Readonly<{
  /** What one ticket adds to the pot. */
  entry: bigint;
  /** The table fee taken from each ticket at entry; burned in the model. */
  fee: bigint;
  /** The pot: every seat's entry. The highest number takes all of it. */
  pot: bigint;
  /** The fees of the whole table, simulated bots included. */
  tableFees: bigint;
}>;
/**
 * The table's money, derived from the game definition. Each ticket is split at entry into a share for the pot and a table
 * fee, so SEATS tickets fill a pot that equals the top prize and the fees pay for the table. Returns null when the
 * definition is not a table with a 10% fee, so nothing untrue is shown.
 */
export function tableEconomy(price: bigint, prize: bigint): Economy | null {
  const paidIn = price * BigInt(SEATS);
  if (prize <= 0n || prize * 10n !== paidIn * 9n) return null;
  const tableFees = paidIn - prize;
  if (tableFees % BigInt(SEATS) !== 0n) return null;
  const fee = tableFees / BigInt(SEATS);
  return Object.freeze({ entry: price - fee, fee, pot: prize, tableFees });
}

export type Career = Readonly<{ played: number; wins: number; bestNumber: number; streak: number; bestStreak: number }>;
export const NEW_CAREER: Career = Object.freeze({ played: 0, wins: 0, bestNumber: 0, streak: 0, bestStreak: 0 });

export function recordRound(career: Career, deal: Deal): Career {
  const streak = deal.won ? career.streak + 1 : 0;
  return Object.freeze({
    played: career.played + 1, wins: career.wins + (deal.won ? 1 : 0),
    bestNumber: Math.max(career.bestNumber, deal.friendNumber), streak, bestStreak: Math.max(career.bestStreak, streak),
  });
}
