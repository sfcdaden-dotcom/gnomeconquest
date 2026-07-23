/**
 * The main human gameplay path, played through the browser:
 * start a game → roll off → first turn → harvest → move → plant → fight →
 * respond window → end turn.
 */

import { expect, test } from '@playwright/test';
import { Game, stepToward } from './helpers';

const SEED = 4242;

test('starts a two-player game and reaches the first playable turn', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);

  // Roll-off is the opening decision.
  expect(await g.status()).toBe('rolloff');
  await g.completeRollOff();

  // First turn belongs to the roll-off winner and opens in the Harvest Phase.
  expect(await g.status()).toBe('playing');
  expect(await g.turn()).toBe(1);

  await g.resolveHarvest('wish');
  expect(await g.phase()).toBe('action');
  await expect(page.getByTestId('action-bar')).toBeVisible();
});

test('harvests the Home Garden for a Wish and for a Gnome', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  // Turn 1: take the Wish. Starting Wishes are 3, so the harvest makes 4.
  expect(await g.decision()).toBe('homeHarvest');
  const before = await g.wishes(await g.playerToAct());
  await page.getByTestId('home-harvest-wish').click();
  await g.ready();
  const active = await g.activePlayer();
  expect(await g.wishes(active)).toBe(before + 1);

  // Turn 2 (the other seat): take the Gnome instead — a second unit appears.
  await g.endTurn();
  await g.ready();
  const seat = await g.playerToAct();
  const gnomesBefore = (await g.unitsOf(seat)).reduce((n, u) => n + u.count, 0);
  expect(await g.decision()).toBe('homeHarvest');
  await page.getByTestId('home-harvest-gnome').click();
  await g.ready();
  const gnomesAfter = (await g.unitsOf(seat)).reduce((n, u) => n + u.count, 0);
  expect(gnomesAfter).toBe(gnomesBefore + 1);
});

test('moves a gnome and plants a garden after moving', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  // Players start with 0 gnomes (RULES.md setup ruling) — the Home Garden
  // harvest is how you bootstrap one.
  await g.resolveHarvest('gnome');

  const me = await g.activePlayer();
  const [gnome] = await g.unitsOf(me);
  expect(gnome).toBeTruthy();

  // Selecting shows the legal destinations the engine enumerated.
  await g.select(gnome.pos);
  const targets = await g.moveTargets();
  expect(targets.length).toBeGreaterThan(0);

  const to = targets[0];
  await g.cell(to).click();
  await g.ready();
  expect((await g.unitsOf(me)).some((u) => u.pos === to)).toBe(true);

  // Planting AFTER moving is legal (the gnome's move is spent, planting is
  // not) — this is the regression the plant-after-move fix covered.
  expect(await g.gardenAt(to)).toBeNull();
  await g.select(to);
  const plantButton = page.locator('[data-testid^="plant-"]').first();
  await expect(plantButton).toBeVisible();
  const type = ((await plantButton.getAttribute('data-testid')) ?? '').replace('plant-', '');
  await plantButton.click();
  await g.ready();
  expect(await g.gardenAt(to)).toBe(type);
});

test('preserves a valid unit selection and drops it once it is spent', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('gnome');

  const me = await g.activePlayer();
  const [gnome] = await g.unitsOf(me);
  await g.select(gnome.pos);
  expect(await g.selectedCell()).toBe(gnome.pos);

  // Move it: the selection follows the unit to its new space, because the
  // gnome can still plant there (it is still an actionable selection).
  const to = (await g.moveTargets())[0];
  await g.cell(to).click();
  await g.ready();
  expect(await g.selectedCell()).toBe(to);

  // End the turn: the selection belongs to a seat that is no longer acting,
  // so it must be gone.
  await g.endTurn();
  expect(await g.selectedCell()).toBeNull();
});

test('marches gnomes together and resolves a fight', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  let fought = false;

  // Both seats bootstrap a gnome, then walk them at each other until they
  // collide. Each iteration is one full turn: harvest, one move, end turn.
  for (let turn = 0; turn < 24 && !fought; turn++) {
    const me = await g.activePlayer();
    const foe = me === 0 ? 1 : 0;
    // Take a gnome while we have none, otherwise bank the Wish.
    const haveGnome = (await g.unitsOf(me)).some((u) => u.kind === 'gnome');
    await g.resolveHarvest(haveGnome ? 'wish' : 'gnome');
    if ((await g.status()) === 'finished') break;

    const mine = (await g.unitsOf(me)).filter((u) => u.kind === 'gnome');
    const theirs = (await g.unitsOf(foe)).filter((u) => u.kind === 'gnome');
    if (mine.length > 0 && theirs.length > 0) {
      const from = mine[0];
      const to = stepToward(from, theirs[0]);
      const gnomesBefore = (await g.units()).reduce((n, u) => n + u.count, 0);

      await g.select(from.pos);
      if ((await g.moveTargets()).includes(to)) {
        await g.cell(to).click();

        // Stepping onto an enemy starts a fight. The Respond window only
        // opens for a player holding playable Sudden Magic — with the empty
        // hands of an opening march the engine auto-passes it, so handle both.
        const fightPanel = page.getByTestId('fight-panel');
        if (await fightPanel.isVisible().catch(() => false)) {
          const respondPass = page.getByTestId('fight-respond-pass');
          if (await respondPass.isVisible().catch(() => false)) await respondPass.click();
        }
        await g.ready();

        // A resolved fight always destroys exactly one gnome, so the board's
        // gnome count is the reliable signal that a fight actually happened.
        const gnomesAfter = (await g.units()).reduce((n, u) => n + u.count, 0);
        if (gnomesAfter < gnomesBefore) fought = true;
      }
    }

    if ((await g.status()) === 'finished') break;
    if (!fought) await g.endTurn();
  }

  expect(fought, 'the two gnomes should have met and fought').toBe(true);
  // The game survived the fight and is still coherent.
  expect(['playing', 'finished']).toContain(await g.status());
});

test('plays a card and lets the opponent answer the response window', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  // Build hands: each seat draws whenever it can afford to (1 Wish a card).
  // A response window opens as soon as one seat plays a card while the other
  // holds a playable Sudden card.
  let sawResponseWindow = false;

  for (let turn = 0; turn < 16 && !sawResponseWindow; turn++) {
    const me = await g.activePlayer();
    // A gnome on the board first: most Sudden cards need one to be playable.
    const haveGnome = (await g.unitsOf(me)).some((u) => u.kind === 'gnome');
    await g.resolveHarvest(haveGnome ? 'wish' : 'gnome');
    if ((await g.status()) === 'finished') break;

    // Draw as much as affordable this turn.
    for (let i = 0; i < 3; i++) {
      const draw = page.getByTestId('draw-card');
      if (!(await draw.isEnabled().catch(() => false))) break;
      await draw.click();
      await g.ready();
    }

    // Play the first playable card in hand, if any.
    const playable = page.locator('[data-testid^="play-card-"]:not([disabled])');
    if ((await playable.count()) > 0) {
      await playable.first().click();
      // Targeted cards enter targeting mode: click the offered candidates.
      for (let i = 0; i < 4; i++) {
        if (!(await page.getByTestId('targeting-banner').isVisible().catch(() => false))) break;
        const cand = page.locator('.board button[data-highlight="target"]').first();
        const chip = page.locator('[data-testid="targeting-banner"] .btn.small').first();
        if ((await cand.count()) > 0) await cand.click();
        else if ((await chip.count()) > 0) await chip.click();
        else {
          await page.getByTestId('targeting-cancel').click();
          break;
        }
      }
      // With two human seats the opponent's response window sits behind the
      // pass-the-device overlay; ready() clears it before we look.
      await g.ready();
      if ((await g.decision()) === 'cardResponse') {
        sawResponseWindow = true;
        await expect(page.getByTestId('respond-pass')).toBeVisible();
        await page.getByTestId('respond-pass').click();
        await g.ready();
      }
    }

    if ((await g.status()) === 'finished') break;
    await g.endTurn();
  }

  expect(sawResponseWindow, 'a card response window should have opened').toBe(true);
  expect(['playing', 'finished']).toContain(await g.status());
});

// Seed 2 deals the roll-off winner a playable Plot Twist on their first turn —
// a two-step (space, then adjacent space) targeted card, so it exercises the
// phased narrowing end to end.
const TWO_STEP_SEED = 2;

/** Roll off, take the Home Wish, and draw until Plot Twist is playable. */
async function reachPlayablePlotTwist(g: Game) {
  const page = g.page;
  await g.startTwoPlayer(TWO_STEP_SEED);
  await g.completeRollOff();
  await g.resolveHarvest('wish');
  const playBtn = page.getByTestId('play-card-plot-twist');
  for (let i = 0; i < 6; i++) {
    if ((await playBtn.count()) > 0 && (await playBtn.isEnabled())) break;
    const draw = page.getByTestId('draw-card');
    await expect(draw).toBeEnabled(); // auto-waits for the action bar to paint
    await draw.click();
    await g.ready();
  }
  await expect(playBtn).toBeEnabled();
}

test('phased targeting narrows the second target after the first pick (Plot Twist)', async ({ page }) => {
  const g = new Game(page);
  await reachPlayablePlotTwist(g);
  const targets = page.locator('.board button[data-highlight="target"]');
  const banner = page.getByTestId('targeting-banner');

  // Play the card: the engine opens phased targeting, step 1 of 2.
  await page.getByTestId('play-card-plot-twist').click();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('1/2');
  expect(await g.decision()).toBe('cardTargeting');

  // Step 1 offers every board space; more than a single-cell neighbourhood.
  const step1Count = await targets.count();
  expect(step1Count).toBeGreaterThan(4);

  // Pick the first target; the banner advances and the set NARROWS to the
  // chosen cell's orthogonal neighbours (at most 4), with the pick marked.
  await targets.first().click();
  await expect(banner).toContainText('2/2');
  const step2Count = await targets.count();
  expect(step2Count).toBeLessThan(step1Count);
  expect(step2Count).toBeLessThanOrEqual(4);
  await expect(page.locator('.board button[data-highlight="picked"]')).toHaveCount(1);

  // Pick the second target: the card resolves and targeting closes.
  await targets.first().click();
  await g.ready();
  await expect(banner).toBeHidden();
  expect(await g.decision()).not.toBe('cardTargeting');
});

test('cancelling phased targeting returns the card to the hand', async ({ page }) => {
  const g = new Game(page);
  await reachPlayablePlotTwist(g);
  const banner = page.getByTestId('targeting-banner');

  await page.getByTestId('play-card-plot-twist').click();
  await expect(banner).toBeVisible();

  // Back out: the banner closes, no card was played, and Plot Twist is still
  // in hand and playable again.
  await page.getByTestId('targeting-cancel').click();
  await g.ready();
  await expect(banner).toBeHidden();
  expect(await g.decision()).not.toBe('cardTargeting');
  await expect(page.getByTestId('play-card-plot-twist')).toBeEnabled();
});
