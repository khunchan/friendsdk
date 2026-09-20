// Browser check for Friend Rooms. Uses the SDK's public runner with the same mocked, read-only wallet fixture as the SDK checks.
// Run from the SDK root: node games/friend-rooms/check-browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { FAMILIES_REGISTRY_ABI, GENERATION_SPRITE_MANIFEST } from '../../dist/generation-sprites.js';
import { project } from '../../dist/friend-world.js';
import { buildGame, createGameServer } from '../../scripts/dev-game.mjs';
import { installFixture, assertBounds } from '../../scripts/check-runtime-browser.mjs';

const source = await readFile(new URL('../../examples/fishing/sample-sprites.ts', import.meta.url), 'utf8');
const section = source.split('"7730": decodeGenerationSprites')[1].split(']),')[0];
const frames = [...section.matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));
assert.equal(frames.length, 64, 'The browser test uses all 64 canonical sample frames');
function artworkCall(call) {
  assert.equal(call.to.toLowerCase(), GENERATION_SPRITE_MANIFEST.registry.toLowerCase());
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  let result;
  if (functionName === 'familyOf') result = 5;
  else if (functionName === 'seedOf') result = 7730;
  else if (functionName === 'frames') { assert.deepEqual(args, [5, 7730]); result = frames; }
  else throw new Error(`Unexpected artwork read ${functionName}`);
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}
async function gameBounds(child) {
  assert.deepEqual(await child.locator('body').evaluate(() => {
    const bounds = document.body.getBoundingClientRect(), problems = [];
    if (document.querySelector('.rf-game-frame,nav')) problems.push('Game contains application scaffolding');
    for (const node of document.querySelectorAll('.rf-frame-menu,.rf-world-prompt,.fr-hud')) {
      const box = node.getBoundingClientRect();
      if (box.left < -1 || box.right > bounds.right + 1 || box.top < -1 || box.bottom > bounds.bottom + 1) problems.push(`Outside viewport: ${node.className}`);
    }
    const prompts = [...document.querySelectorAll('.rf-world-prompt')].map(node => node.getBoundingClientRect());
    prompts.forEach((a, i) => prompts.slice(i + 1).forEach(b => {
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) problems.push('Door labels overlap');
    }));
    return problems;
  }), []);
}

/** The SDK toolbar sits over the bottom of the frame. Nothing the player must press may sit under it. */
async function barClear(child) {
  const page = child.owner().page();
  const toolbar = await page.locator('.rf-frame-toolbar').boundingBox();
  assert(toolbar, 'The SDK toolbar is present');
  const buttons = child.locator('.fr-room-bar button, .fr-room-bar .fr-speed');
  for (let index = 0; index < await buttons.count(); index++) {
    const box = await buttons.nth(index).boundingBox();
    if (!box) continue;
    const overlaps = box.x < toolbar.x + toolbar.width && toolbar.x < box.x + box.width && box.y < toolbar.y + toolbar.height && toolbar.y < box.y + box.height;
    assert(!overlaps, `Button ${index} sits under the SDK toolbar`);
  }
}

const directory = await mkdtemp(join(tmpdir(), 'friend-rooms-browser-'));
const shots = process.env.FRIEND_ROOMS_SHOTS;
let build, server, browser;
try {
  build = await buildGame(resolve('games/friend-rooms'), { outdir: join(directory, 'dist') });
  server = createGameServer(build.outdir);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1100, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await installFixture(page, origin, { artworkCall });
    const child = page.frameLocator('iframe');
    const button = name => child.getByRole('button', { name, exact: true });
    const worldReady = () => child.locator('canvas[data-x]').waitFor();
    const walk = async point => {
      const canvas = child.locator('canvas'), box = await canvas.boundingBox(), [x, y] = project(...point);
      const position = { x: (x - 320) / 960 * box.width, y: (y - 330) / 640 * box.height };
      if (width < 500) await canvas.tap({ position }); else await canvas.click({ position });
      await page.waitForTimeout(1600);
    };
    await page.goto(origin);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await page.getByRole('button', { name: /^Friend #7730\b/ }).click(); await worldReady();
    if (shots) await page.screenshot({ path: join(shots, `hall-${width}.png`) });
    await assertBounds(page); await gameBounds(child);
    assert.match(await child.locator('.fr-hud').textContent(), /SIMULATED.*20 RF.*0 tickets/);

    // Keyboard movement.
    const canvas = child.locator('canvas'), before = await canvas.getAttribute('data-x');
    await canvas.focus(); await page.keyboard.down('ArrowRight'); await page.waitForTimeout(150); await page.keyboard.up('ArrowRight');
    assert.notEqual(await canvas.getAttribute('data-x'), before, 'The owned Friend moves with the keyboard');

    // Locked door: message only, nothing to buy.
    await walk([100, 232]);
    await child.getByRole('button', { name: /^Room 1,000 RF/ }).click();
    await child.getByText('Room 1,000 RF needs future SDK support.', { exact: true }).waitFor();
    assert.equal(await child.getByRole('button', { name: /Enter the room|Buy/ }).count(), 0, 'Locked doors sell nothing');
    if (shots) await page.screenshot({ path: join(shots, `locked-${width}.png`) });
    await gameBounds(child); await button('Close').click();

    // Working door: rules, then a real SDK flow: buy, use, then the Friend plays every game on its own.
    const confirm = () => page.getByRole('button', { name: 'Confirm preview', exact: true }).click();
    const receiptRow = async label => (await child.getByRole('row', { name: new RegExp(`^${label}`) }).textContent()).replace(label, '').trim();
    await walk([340, 322]);
    await child.getByRole('button', { name: /^Room 100 RF/ }).click();
    await child.getByText(/Room 100 RF · preview tickets 1 RF \(SDK preview wallet is fixed at 20 RF\)\./).waitFor();
    await child.getByText('The table has 10 seats: your Friend and 9 simulated bots.', { exact: true }).waitFor();
    if (shots) await page.screenshot({ path: join(shots, `door-${width}.png`) });
    await gameBounds(child);
    const range = child.getByLabel('Games to play');
    assert.equal(await range.getAttribute('max'), '11', 'The SDK prize backing limits one run to 11 games');
    await range.fill('3');
    await child.getByText(/two SDK prompts: buy the tickets, then use them/).waitFor();
    await button('Play 3 games · 3 RF').click();
    await confirm(); await confirm();
    // The receipt never opens by itself: the last round stays visible until the player asks for it.
    await button('Session receipt').waitFor();
    await page.waitForTimeout(400);
    assert.equal(await child.getByRole('dialog').count(), 0, 'The receipt does not cover the last round');
    await button('Session receipt').click();
    await child.getByRole('heading', { name: 'Session receipt' }).waitFor({ timeout: 5000 });
    assert.equal(await receiptRow('Games played'), '3');
    const wins = Number(await receiptRow('Wins'));
    assert(wins >= 0 && wins <= 3);
    assert.equal(await receiptRow('Tickets spent'), '3 RF SIMULATED');
    assert.equal(await receiptRow('Prizes won'), `${9 * wins} RF SIMULATED`);
    assert.equal(await receiptRow('Burned at the tables'), '3 RF model');
    assert.equal(await receiptRow('Your share of the burn'), '0.3 RF model');
    await button('Close').click();
    // The last table: ten unique numbers, and the highest-number marker agrees with the SDK result.
    const numbers = (await child.locator('.fr-sr li').evaluateAll(items => items.map(item => Number(item.dataset.number))));
    assert.equal(numbers.length, 10); assert.equal(new Set(numbers).size, 10);
    assert(numbers.every(number => Number.isInteger(number) && number >= 1 && number <= 100));
    const summary = await child.locator('.fr-result b').textContent();
    assert.match(summary, /^(Your \d+ — \d+ short of \d+|Your \d+ is the highest number\.)$/);
    assert.equal(await child.locator('.fr-sr li[data-winner="true"]').count(), 1);
    assert.equal(await child.locator('.fr-sr li[data-seat="friend"][data-winner="true"]').count(), summary.includes('highest') ? 1 : 0);
    assert.match(summary, new RegExp(`Your ${numbers[0]}\\b`), 'The Friend seat shows the Friend number');
    assert.equal(Math.max(...numbers) === numbers[0], summary.includes('highest'), 'The highest number belongs to the Friend exactly on a win');
    assert.match(await child.locator('.fr-sr li[data-seat="friend"]').textContent(), /Friend #7730 \(\w+\)/, 'The seat names the Friend and its SDK character family');
    if (shots) await page.screenshot({ path: join(shots, `table-${width}.png`) });
    await gameBounds(child); await barClear(child);
    assert.match(await child.locator('.fr-hud').textContent(), new RegExp(`${17} RF · 0 tickets`), 'The HUD balance follows the SDK ledger');

    // Stop after one round: the rest stay unfinished, then Resume settles those same plays without buying more tickets.
    await button('Back to the hall').click(); await worldReady();
    await button('Settings').click(); await child.getByLabel('Reduce motion').uncheck(); await button('Close Settings').click();
    await child.getByRole('button', { name: /^Room 100 RF/ }).click();
    await child.getByLabel('Games to play').fill('3');
    await button('Play 3 games · 3 RF').click(); await confirm(); await confirm();
    if (shots) { await page.waitForTimeout(3200); await page.screenshot({ path: join(shots, `reveal-${width}.png`) }); await barClear(child); }
    await button('Stop after this round').click();
    await button('Resume 2 unfinished rounds').waitFor({ timeout: 15000 });
    assert.equal(await child.getByRole('dialog').count(), 0, 'Stopping does not open the receipt by itself');
    await button('Session receipt').click();
    await child.getByRole('heading', { name: 'Session receipt' }).waitFor({ timeout: 5000 });
    assert.equal(await receiptRow('Games played'), '4');
    await button('Close').click();
    assert.equal(await page.getByRole('button', { name: 'Confirm preview', exact: true }).count(), 0);
    await button('Resume 2 unfinished rounds').click();
    await button('Back to the hall').waitFor({ timeout: 15000 });
    await button('Session receipt').click();
    await child.getByRole('heading', { name: 'Session receipt' }).waitFor({ timeout: 5000 });
    assert.equal(await receiptRow('Games played'), '6');
    assert.equal(await page.getByRole('button', { name: 'Confirm preview', exact: true }).count(), 0, 'Resume asks for no second purchase');
    const allWins = Number(await receiptRow('Wins'));
    if (allWins > 0) { await button('Collect winnings').click(); await confirm(); await child.getByText(`Collected ${9 * allWins} RF (SIMULATED).`).waitFor(); }
    await button('Close').click();
    assert.match(await child.locator('.fr-hud').textContent(), new RegExp(`${14 + 9 * allWins} RF · 0 tickets`));
    await button('Back to the hall').click(); await worldReady();
    const [rx, ry] = [await canvas.getAttribute('data-x'), await canvas.getAttribute('data-y')].map(Number);
    assert(Math.hypot(rx - 288, ry - 330) < 90, 'Returning from the room puts the Friend next to the door');

    // Settings: mute and reduced motion.
    await button('Settings').click(); assert.equal(await child.getByLabel('Reduce motion').isChecked(), false);
    await button('Sound off').click(); await button('Sound on').waitFor();
    await button('Sound on').click(); await button('Sound off').waitFor();
    await gameBounds(child); await button('Close Settings').click();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS Friend Rooms ${width}px: canonical Friend, movement, locked door, buy/use/play flow, table numbers, receipt, stop and resume, collect, settings, bounds.`);
  }
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await build?.close(); await rm(directory, { recursive: true, force: true });
}
