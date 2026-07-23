/**
 * Page-object helpers for the browser tests.
 *
 * Everything here goes through the DOM the way a player does: click a seat
 * button, click a board cell, press "End turn". The only shortcut is reading
 * the `data-*` attributes the game screen already publishes (status, phase,
 * whose decision is open, unit ownership per cell) so a test can WAIT for a
 * condition instead of sleeping or scraping prose.
 */

import { expect, type Locator, type Page } from '@playwright/test';

export interface BoardUnit {
  pos: string; // "x,y"
  x: number;
  y: number;
  owner: number;
  kind: 'gnome' | 'snail';
  count: number;
}

export class Game {
  constructor(readonly page: Page) {}

  // --- setup ---------------------------------------------------------------

  /** Start a 2-player hot-seat game (both seats human) with a fixed seed. */
  async startTwoPlayer(seed: number): Promise<void> {
    await this.page.goto('/');
    await this.page.getByTestId('player-count-2').click();
    // Seat 0 is human by default; make seat 1 human too, so no CPU timer runs
    // and every step of the test is a deliberate click.
    await this.page.getByTestId('seat-0-human').click();
    await this.page.getByTestId('seat-1-human').click();
    await this.page.getByTestId('seed-input').fill(String(seed));
    await this.page.getByTestId('start-game').click();
    await expect(this.page.getByTestId('game-screen')).toBeVisible();
  }

  // --- state probes --------------------------------------------------------

  private screen(): Locator {
    return this.page.getByTestId('game-screen');
  }

  async attr(name: string): Promise<string> {
    return (await this.screen().getAttribute(`data-${name}`)) ?? '';
  }

  status = () => this.attr('status');
  phase = () => this.attr('phase');
  decision = () => this.attr('decision');
  turn = async () => Number((await this.attr('turn')) || 0);
  activePlayer = async () => Number((await this.attr('active-player')) || 0);
  playerToAct = async () => Number((await this.attr('player-to-act')) || 0);

  /** Every unit stack currently rendered on the board. */
  async units(): Promise<BoardUnit[]> {
    return this.page.$$eval('.board .token', (nodes) =>
      nodes.map((n) => {
        const cell = n.closest('button')!;
        const pos = (cell.getAttribute('data-testid') ?? '').replace('cell-', '');
        const [x, y] = pos.split(',').map(Number);
        return {
          pos,
          x,
          y,
          owner: Number(n.getAttribute('data-owner')),
          kind: n.getAttribute('data-kind') as 'gnome' | 'snail',
          count: Number(n.getAttribute('data-count')),
        };
      }),
    );
  }

  async unitsOf(player: number): Promise<BoardUnit[]> {
    return (await this.units()).filter((u) => u.owner === player);
  }

  cell(pos: string): Locator {
    return this.page.getByTestId(`cell-${pos}`);
  }

  /** Board cells currently highlighted as legal moves for the selection. */
  async moveTargets(): Promise<string[]> {
    return this.page.$$eval('.board button[data-highlight="move"]', (nodes) =>
      nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace('cell-', '')),
    );
  }

  async selectedCell(): Promise<string | null> {
    const sel = await this.page.$('.board button[data-selected="true"]');
    return sel ? ((await sel.getAttribute('data-testid')) ?? '').replace('cell-', '') : null;
  }

  async gardenAt(pos: string): Promise<string | null> {
    const cls = (await this.cell(pos).getAttribute('class')) ?? '';
    return cls.match(/\bg-([a-z]+)\b/)?.[1] ?? null;
  }

  /** Wishes shown for a seat in the player panel. */
  async wishes(player: number): Promise<number> {
    const text = await this.page.locator('.pp-row, .player-panel').nth(player).innerText();
    return Number(text.match(/(\d+)\s*✨/)?.[1] ?? NaN);
  }

  // --- flow ----------------------------------------------------------------

  /** Dismiss the pass-the-device interstitial if it is showing. */
  async passDeviceIfNeeded(): Promise<void> {
    const overlay = this.page.getByTestId('pass-overlay');
    if (await overlay.isVisible().catch(() => false)) {
      await this.page.getByTestId('pass-confirm').click();
      await expect(overlay).toBeHidden();
    }
  }

  /** Skip a fight animation if one is playing. */
  async skipPlaybackIfNeeded(): Promise<void> {
    const skip = this.page.getByTestId('skip-playback');
    if (await skip.isVisible().catch(() => false)) await skip.click();
  }

  /** Settle the UI: dismiss overlays until the acting human can interact. */
  async ready(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await this.skipPlaybackIfNeeded();
      await this.passDeviceIfNeeded();
      if ((await this.attr('interactive')) === 'true') return;
      if ((await this.status()) === 'finished') return;
      await this.page.waitForTimeout(100);
    }
    throw new Error(`UI never became interactive (decision=${await this.decision()})`);
  }

  /** Complete the opening roll-off (both seats roll; ties reroll). */
  async completeRollOff(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await this.ready();
      if ((await this.status()) !== 'rolloff') return;
      await this.page.getByTestId('roll-off').click();
    }
    throw new Error('roll-off never resolved');
  }

  /**
   * Resolve harvest-phase decisions until the Action Phase is reached.
   * `homeTake` picks the Home Garden reward ('wish' or 'gnome').
   */
  async resolveHarvest(homeTake: 'wish' | 'gnome' = 'wish'): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await this.ready();
      if ((await this.status()) === 'finished') return;
      if ((await this.phase()) === 'action' && (await this.decision()) === '') return;
      const kind = await this.decision();
      switch (kind) {
        case 'homeHarvest': {
          const wanted = this.page.getByTestId(`home-harvest-${homeTake}`);
          // A Home Garden at the gnome limit only offers the wish.
          if (await wanted.isVisible().catch(() => false)) await wanted.click();
          else await this.page.getByTestId('home-harvest-wish').click();
          break;
        }
        case 'chooseHarvest':
          await this.page.locator('[data-testid^="choose-harvest-"]').first().click();
          break;
        case 'mushroomClones':
          await this.page.locator('[data-testid^="mushroom-clones-"]').last().click();
          break;
        case 'slide':
        case 'tunnel':
        case 'snailMove':
          await this.resolveBoardPick();
          break;
        case 'cardResponse':
          await this.page.getByTestId('respond-pass').click();
          break;
        case 'fightRespond':
          await this.page.getByTestId('fight-respond-pass').click();
          break;
        case '':
          await this.page.waitForTimeout(100);
          break;
        default:
          throw new Error(`resolveHarvest: unexpected decision "${kind}"`);
      }
    }
    throw new Error('harvest never finished');
  }

  /** Answer a slide/tunnel/snailMove by clicking the first highlighted space. */
  private async resolveBoardPick(): Promise<void> {
    const opts = this.page.locator('.board button[data-highlight="decision"]');
    if ((await opts.count()) > 0) await opts.first().click();
    else await this.page.getByTestId('decline-effect').click();
  }

  /** Select a unit by clicking its space (cycles stacks). */
  async select(pos: string): Promise<void> {
    await this.cell(pos).click();
    await expect(this.page.locator(`.board button[data-testid="cell-${pos}"][data-selected="true"]`)).toBeVisible();
  }

  /** Move a selected unit from `from` to the adjacent `to`. */
  async move(from: string, to: string): Promise<void> {
    await this.select(from);
    expect(await this.moveTargets()).toContain(to);
    await this.cell(to).click();
    await this.ready();
  }

  async endTurn(): Promise<void> {
    await this.ready();
    await this.page.getByTestId('end-turn').click();
    await this.ready();
  }
}

/** One orthogonal step from `from` toward `to` that stays on the board. */
export function stepToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  // Close the larger gap first; a single step is always orthogonal.
  if (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) && dx !== 0) {
    return `${from.x + dx},${from.y}`;
  }
  if (dy !== 0) return `${from.x},${from.y + dy}`;
  return `${from.x + dx},${from.y}`;
}
