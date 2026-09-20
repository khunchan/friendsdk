// Captures the screenshots and the animation used in the READMEs. It drives the real game in the SDK's public runner
// with the SDK's mocked, read-only wallet fixture and sample Friend #7730, and scripts the preview rolls so the
// captured session is: a loss, a win, a loss. Nothing here changes the game or its rules.
// Run from the SDK root (needs `npx playwright install chromium` once, and Python 3 with Pillow for the images):
//   node games/friend-rooms/capture-media.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { FAMILIES_REGISTRY_ABI } from '../../dist/generation-sprites.js';
import { project } from '../../dist/friend-world.js';
import { buildGame, createGameServer } from '../../scripts/dev-game.mjs';
import { installFixture } from '../../scripts/check-runtime-browser.mjs';

const source = await readFile(new URL('../../examples/fishing/sample-sprites.ts', import.meta.url), 'utf8');
const frames = [...source.split('"7730": decodeGenerationSprites')[1].split(']),')[0].matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));
const artworkCall = call => {
  const { functionName } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result: functionName === 'familyOf' ? 5 : functionName === 'seedOf' ? 7730 : frames });
};

const work = await mkdtemp(join(tmpdir(), 'friend-rooms-media-'));
const output = resolve('games/friend-rooms/media');
let build, server, browser;
try {
  await mkdir(join(work, 'raw'), { recursive: true }); await mkdir(join(work, 'gif'), { recursive: true }); await mkdir(output, { recursive: true });
  build = await buildGame(resolve('games/friend-rooms'), { outdir: join(work, 'dist') });
  server = createGameServer(build.outdir);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Grayscale text smoothing keeps coloured fringes out of the black-and-white images.
  browser = await chromium.launch({ headless: true, args: ['--disable-lcd-text'] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  await installFixture(page, origin, { artworkCall });
  // The fixture pins every preview roll to a loss. Queue the rolls for this session: a loss, a win (roll 500 is inside the
  // 10% winning range), a loss. Other random calls are untouched.
  await page.addInitScript(() => {
    const previous = crypto.getRandomValues.bind(crypto);
    window.__rolls = [];
    crypto.getRandomValues = array => {
      if (array instanceof Uint32Array && array.length === 1 && window.__rolls.length) { array[0] = window.__rolls.shift(); return array; }
      return previous(array);
    };
  });
  const child = page.frameLocator('iframe'), game = page.locator('iframe');
  const button = name => child.getByRole('button', { name, exact: true });
  const confirm = () => page.getByRole('button', { name: 'Confirm preview', exact: true }).click();
  const walk = async point => {
    const canvas = child.locator('canvas'), box = await canvas.boundingBox(), [x, y] = project(...point);
    await canvas.click({ position: { x: (x - 320) / 960 * box.width, y: (y - 330) / 640 * box.height } });
    await page.waitForTimeout(1600);
  };
  const shot = name => game.screenshot({ path: join(work, 'raw', `${name}.png`) });

  await page.goto(origin);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: /^Friend #7730\b/ }).click();
  await child.locator('canvas[data-x]').waitFor();
  await walk([340, 322]);
  await child.getByRole('button', { name: /^Room 100 RF/ }).waitFor();
  await shot('hall');

  await page.evaluate(() => window.__rolls.push(1500, 500, 1500));
  await child.getByRole('button', { name: /^Room 100 RF/ }).click();
  await child.getByLabel('Games to play').fill('3');
  await button('Play 3 games · 3 RF').click();

  // Grab frames as fast as the browser allows for the whole run and note what each one shows.
  const grabbed = [];
  let grabbing = true;
  const grabber = (async () => {
    while (grabbing) {
      const buffer = await game.screenshot(), time = Date.now();
      const meta = await child.locator('body').evaluate(() => ({
        title: document.querySelector('.fr-room-title')?.textContent ?? '', result: document.querySelector('.fr-result b')?.textContent ?? '',
        opened: document.querySelectorAll('.fr-sr li[data-number]').length,
      })).catch(() => ({ title: '', result: '', opened: 0 }));
      grabbed.push({ time, buffer, ...meta });
    }
  })();
  await confirm(); await confirm();
  await button('Session receipt').waitFor({ timeout: 90000 });
  await page.waitForTimeout(400);
  grabbing = false; await grabber;

  const round = number => grabbed.filter(frame => frame.title.includes(`game ${number} of 3`));
  const reveal = round(1).find(frame => frame.opened >= 5 && !frame.result.startsWith('Your'));
  assert(reveal, 'A frame in the middle of a reveal was captured');
  await writeFile(join(work, 'raw', 'reveal.png'), reveal.buffer);
  const winning = round(2), finished = winning.filter(frame => frame.result.includes('highest'));
  assert(finished.length > 2, 'The winning game was captured');
  const winFrame = finished[Math.min(finished.length - 1, Math.max(1, Math.floor(finished.length / 3)))];
  assert.match(winFrame.result, /^Your \d+ is the highest number\.$/);
  await writeFile(join(work, 'raw', 'win.png'), winFrame.buffer);
  const timing = [];
  for (const [index, frame] of winning.entries()) {
    await writeFile(join(work, 'gif', `${String(index).padStart(3, '0')}.png`), frame.buffer);
    timing.push(index + 1 < winning.length ? winning[index + 1].time - frame.time : 900);
  }
  await writeFile(join(work, 'gif', 'timing.json'), JSON.stringify(timing));

  await button('Session receipt').click();
  await child.getByRole('heading', { name: 'Session receipt' }).waitFor();
  await shot('receipt');
  console.log(`Captured ${grabbed.length} frames; the animation uses ${winning.length}.`);

  const result = spawnSync('python3', [new URL('./assemble-media.py', import.meta.url).pathname, work, output], { stdio: 'inherit' });
  assert.equal(result.status, 0, 'The images were assembled');
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await build?.close(); await rm(work, { recursive: true, force: true });
}
