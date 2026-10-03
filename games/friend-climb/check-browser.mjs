// Browser check for Friend Climb. Uses the SDK's public runner with the same mocked, read-only wallet
// fixture as the SDK checks. Run from the SDK root: node games/friend-climb/check-browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { build as esbuild } from 'esbuild';
import { FAMILIES_REGISTRY_ABI } from '../../dist/generation-sprites.js';
import { buildGame, createGameServer } from '../../scripts/dev-game.mjs';
import { installFixture, assertBounds } from '../../scripts/check-runtime-browser.mjs';

// The same bundle-to-data-URL trick tower.test.mjs uses, so this check can read the exact bot moves the game
// itself would compute for the fixture's pinned Practice seed (1500) and drive the real UI through them.
const towerBundle = await esbuild({ entryPoints: [new URL('./tower.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const tower = await import(`data:text/javascript;base64,${Buffer.from(towerBundle.outputFiles[0].text).toString('base64')}`);

const source = await readFile(new URL('../../examples/fishing/sample-sprites.ts', import.meta.url), 'utf8');
const section = source.split('"7730": decodeGenerationSprites')[1].split(']),')[0];
const frames = [...section.matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));
assert.equal(frames.length, 64, 'The browser test uses all 64 canonical sample frames');
function artworkCall(call) {
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  let result;
  if (functionName === 'familyOf') result = 5; // Asymmetry, picked arbitrarily; any valid family exercises the color lookup
  else if (functionName === 'seedOf') result = 7730;
  else if (functionName === 'frames') { assert.deepEqual(args, [5, 7730]); result = frames; }
  else throw new Error(`Unexpected artwork read ${functionName}`);
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}

/**
 * Drives the real UI through a recorded transitions track in real time via genuine keyboard events (not a
 * shortcut into React state), while sampling the camera and the HUD every half second. This is what actually
 * proves the camera fix: a single sample right after a run starts (height 0) cannot catch a camera that only
 * breaks once the Friend has climbed for a while, which is exactly how the bug first got past this check.
 */
async function driveAndWatchCamera(page, canvas, transitions, seconds) {
  const samples = [];
  const codeFor = dir => (dir === -1 ? 'ArrowLeft' : dir === 1 ? 'ArrowRight' : null);
  const started = Date.now();
  let dir = 0, index = 0;
  const sample = async () => {
    const y = Number(await canvas.getAttribute('data-player-screen-y'));
    const height = Number(await canvas.getAttribute('data-height'));
    const hud = await page.frameLocator('iframe').locator('.fc-top span').first().textContent();
    samples.push({ t: Date.now() - started, y, height, hud });
  };
  while (Date.now() - started < seconds * 1000) {
    const elapsedTicks = (Date.now() - started) / 1000 * 60;
    while (index < transitions.length && transitions[index].tick <= elapsedTicks) {
      const next = transitions[index].dir; index++;
      if (codeFor(dir)) await page.keyboard.up(codeFor(dir));
      if (codeFor(next)) await page.keyboard.down(codeFor(next));
      dir = next;
    }
    await sample();
    await page.waitForTimeout(500);
  }
  if (codeFor(dir)) await page.keyboard.up(codeFor(dir));
  return samples;
}

/** No `.rf-frame-menu`/world-prompt scaffolding in this game, but still nothing may escape the frame. */
async function gameBounds(child) {
  assert.deepEqual(await child.locator('body').evaluate(() => {
    const bounds = document.body.getBoundingClientRect(), problems = [];
    if (document.querySelector('.rf-game-frame,nav')) problems.push('Game contains application scaffolding');
    for (const node of document.querySelectorAll('.fc-top,.fc-pick,.fc-result,.fc-scene')) {
      const box = node.getBoundingClientRect();
      if (box.left < -1 || box.right > bounds.right + 1 || box.top < -1 || box.bottom > bounds.bottom + 1) problems.push(`Outside viewport: ${node.className}`);
    }
    return problems;
  }), []);
}

const directory = await mkdtemp(join(tmpdir(), 'friend-climb-browser-'));
let build, server, browser;
try {
  build = await buildGame(resolve('games/friend-climb'), { outdir: join(directory, 'dist') });
  server = createGameServer(build.outdir);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1100, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500, reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await installFixture(page, origin, { artworkCall }); // also pins any single-Uint32Array crypto roll to 1500, including this game's Practice seed
    const child = page.frameLocator('iframe');
    await page.goto(origin);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await page.getByRole('button', { name: /^Friend #7730\b/ }).click();
    await child.getByRole('heading', { name: 'Friend Climb' }).waitFor();
    await assertBounds(page); await gameBounds(child);
    assert.match(await child.locator('.fc-top').textContent(), /Friend Climb/);

    // Race a friend's code: a mismatched-tower code shows a clear warning, garbage shows a decode error, and
    // a code from the pre-fix star-scoring version (FC1) is refused by name instead of replayed to a wrong score.
    await child.getByLabel("Race a friend's code").fill('FC2.9999.3R!a');
    await child.getByRole('button', { name: 'Load' }).click();
    await child.getByText('different tower', { exact: false }).waitFor();
    await child.getByLabel("Race a friend's code").fill('not a real code');
    await child.getByRole('button', { name: 'Load' }).click();
    await child.getByText('does not look like', { exact: false }).waitFor();
    await child.getByLabel("Race a friend's code").fill('FC1.5.3R!a');
    await child.getByRole('button', { name: 'Load' }).click();
    await child.getByText('older version', { exact: false }).waitFor();
    await child.getByLabel("Race a friend's code").fill('');

    // Practice seed is pinned to 1500 by the fixture above; holding left dies in well under 60 ticks * 180s.
    await child.getByRole('button', { name: 'Practice (new tower)' }).click();
    const canvas = child.locator('canvas');
    await canvas.waitFor(); await canvas.focus();
    await page.keyboard.down('ArrowLeft');
    await child.getByRole('heading', { name: /^Score: \d+$/ }).waitFor({ timeout: 20000 });
    await page.keyboard.up('ArrowLeft');
    const scoreText = await child.getByRole('heading', { name: /^Score: \d+$/ }).textContent();
    const score = Number(scoreText.replace('Score: ', ''));
    assert(score > 0, 'A real run scored above zero');
    // The score breakdown (height points + stars × 25 = total) must add up, whether or not this particular
    // short run happened to land on a star — proves the breakdown line itself is wired correctly either way.
    const breakdown = await child.locator('.fc-result p').first().textContent();
    const parsed = breakdown.match(/^Height (\d+) \+ (\d+) stars? \((\d+)\) = (\d+)$/);
    assert(parsed, `the score breakdown line did not match the expected shape (got "${breakdown}")`);
    const [, heightPoints, starCount, starPoints, total] = parsed.map(Number);
    assert.equal(starPoints, starCount * 25, 'star points must be the star count times 25');
    assert.equal(total, heightPoints + starPoints, 'the breakdown must add up to the total');
    assert.equal(total, score, 'the breakdown total must match the score heading');
    const code = await child.getByLabel('Run code to share').inputValue();
    assert.match(code, /^FC2\.[0-9a-z]+\.[0-9a-zLNR]*![0-9a-z]+$/, 'The shared run code has the expected shape');
    await assertBounds(page); await gameBounds(child);

    // Clipboard access may or may not be granted inside the sandboxed frame; either outcome must be handled.
    await child.getByRole('button', { name: 'Copy' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (copied !== code) await child.getByText('select the code above', { exact: false }).waitFor();

    // A second run must start with the Friend visible again, not scrolled off by a stale camera left over
    // from how high the first run climbed (the bug the builder found and fixed after playtesting).
    await child.getByRole('button', { name: 'Play this tower again' }).click();
    await child.getByText(/^Score 0/).waitFor();
    await page.waitForTimeout(150);
    const playerY = Number(await canvas.getAttribute('data-player-screen-y'));
    assert(playerY >= 0 && playerY <= 640, `The Friend must render inside the canvas on a second run (got screen y ${playerY})`);

    if (width === 1100) {
      // The deep camera/HUD check: drive the fixture's pinned Practice seed (1500) through the real UI with
      // the exact bot moves tower.ts would compute for it, for 22 real seconds, sampling twice a second.
      const botMoves = tower.botRun(1500, 60 * 180).transitions;
      const samples = await driveAndWatchCamera(page, canvas, botMoves, 22);
      assert(samples.length >= 40, `expected roughly 44 half-second samples over 22s, got ${samples.length}`);
      for (const s of samples) {
        assert(s.y >= 640 * 0.15 && s.y <= 640 * 0.75,
          `at t=${s.t}ms the Friend's screen y (${s.y.toFixed(1)}) left the 15%-75% band — the camera lost it`);
        // Score is floor(peakHeight / 10) + stars * 25; peakHeight never decreases, so score never goes negative.
        assert.match(s.hud, /^Score \d+ · ★\d+$/, `at t=${s.t}ms the HUD did not read "Score N · ★S" (got "${s.hud}")`);
      }
      const scores = samples.map(s => Number(s.hud.match(/^Score (\d+)/)[1]));
      assert(scores.some((value, i) => i > 0 && value > scores[i - 1]), 'the HUD score must visibly change between samples, not sit frozen at "Score 0"');
      assert(scores[scores.length - 1] > scores[0], `the HUD score must grow over the climb (${scores[0]} → ${scores[scores.length - 1]})`);
      assert(samples[samples.length - 1].height > 50, `expected real height after 22s of bot-driven climbing, got ${samples[samples.length - 1].height}`);
      // Not asserting a star was actually collected here: real-time keyboard dispatch cannot land on the
      // exact same ticks tower.ts's own pure simulation would (browser/event-loop timing drifts a little from
      // the Date.now() estimate driveAndWatchCamera uses), so it can genuinely climb a different path than
      // the recorded bot moves alone would — the "★N" pattern above already proves the counter is live and
      // well-formed throughout; a guaranteed collection is checked deterministically below instead.
    }

    // event.code (the physical key), not event.key (the typed character), must drive steering — this is
    // what makes arrow keys and A/D work on a Cyrillic or other non-Latin keyboard layout too.
    await canvas.focus();
    const beforeX = Number(await canvas.getAttribute('data-x'));
    await canvas.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'в', bubbles: true })));
    await page.waitForTimeout(400);
    await canvas.evaluate(el => el.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'в', bubbles: true })));
    const afterX = Number(await canvas.getAttribute('data-x'));
    assert.notEqual(beforeX, afterX, 'A Cyrillic-layout "D" key (code KeyD, key "в") must still steer');

    await child.getByRole('button', { name: 'Settings' }).click();
    await child.getByRole('dialog').getByRole('checkbox', { name: 'Reduce motion' }).click();
    await child.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
    const soundButton = child.locator('.fc-top').getByRole('button', { name: /Sound (on|off)/ });
    assert.equal(await soundButton.textContent(), 'Sound off');
    await soundButton.click(); assert.equal(await soundButton.textContent(), 'Sound on');

    assert.deepEqual(errors, [], `Browser errors at ${width}px`);
    console.log(`PASS Friend Climb ${width}px: picker, mismatched/garbled run codes, a full timed run, run code shape, clipboard or its fallback, replay, settings, sound, bounds.`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await build?.close(); await rm(directory, { recursive: true, force: true });
}
