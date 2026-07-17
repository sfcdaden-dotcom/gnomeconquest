/**
 * Per-card tests: every Whimsy card's validate / resolve / fizzle behavior,
 * plus curse-draw and reshuffle mechanics, asserted against CARDS.md.
 *
 * Scenarios are hand-crafted via the testkit (GameState is plain data by
 * contract). Unless noted, `me` is the active player at their Action Phase
 * with one home-harvest gnome on their Home Garden; positions are chosen away
 * from both homes ((0,3)/(6,3) on the default 7×7) and the center star (3,3).
 */

import { describe, expect, it } from 'vitest';
import type { GameState, PlayerId, Pos } from './index';
import { applyAction, getLegalActions, posKey } from './index';
import {
  activePlayer,
  drive,
  mutate,
  toActionPhase,
  totalGnomes,
  withGarden,
  withGnome,
  withHand,
} from './testkit';

/** Standard 2-player scenario: me at Action Phase, foe waiting. */
function scenario(seed = 5): { s: GameState; me: PlayerId; foe: PlayerId } {
  const s = toActionPhase(seed);
  const me = activePlayer(s);
  return { s, me, foe: (me + 1) % 2 };
}

function play(s: GameState, player: PlayerId, cardId: string, targets?: object): GameState {
  return applyAction(s, { type: 'playCard', player, cardId, targets } as never);
}

// ---------------------------------------------------------------------------
// Sudden Magic
// ---------------------------------------------------------------------------

describe('Hidden Passage', () => {
  it('moves an own gnome 1 space diagonally as a FREE move', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withHand(g.state, me, 'hidden-passage');
    s = play(s, me, 'hidden-passage', { units: [g.unitId], spaces: [{ x: 3, y: 3 }] });
    expect(s.units[g.unitId].pos).toEqual({ x: 3, y: 3 });
    // Free move: the gnome's own movement action is still available.
    expect(s.units[g.unitId].movedOnTurn).toBeNull();
    expect(getLegalActions(s).some((a) => a.type === 'move' && a.unitId === g.unitId)).toBe(true);
  });

  it('rejects orthogonal destinations and enemy gnomes', () => {
    const { s, me, foe } = scenario();
    const mine = withGnome(s, me, { x: 2, y: 2 });
    const theirs = withGnome(mine.state, foe, { x: 4, y: 4 });
    const st = withHand(theirs.state, me, 'hidden-passage');
    expect(() =>
      play(st, me, 'hidden-passage', { units: [mine.unitId], spaces: [{ x: 2, y: 1 }] }),
    ).toThrow(/diagonal/i);
    expect(() =>
      play(st, me, 'hidden-passage', { units: [theirs.unitId], spaces: [{ x: 5, y: 5 }] }),
    ).toThrow(/one you control/i);
  });
});

describe('Snake Eyes / 4 Leaf Clover', () => {
  it('stack pending roll modifiers on the right players', () => {
    let { s, me, foe } = scenario();
    s = withHand(s, me, 'snake-eyes', 'snake-eyes', 'four-leaf-clover');
    s = play(s, me, 'snake-eyes', { players: [foe] });
    s = play(s, me, 'snake-eyes', { players: [foe] });
    s = play(s, me, 'four-leaf-clover');
    expect(s.rollModifiers[foe]).toBe(-4); // stacking per CARDS.md
    expect(s.rollModifiers[me]).toBe(3);
  });

  it('applies to the maize harvest roll (the OWNER rolls it) and is consumed', () => {
    let { s, me } = scenario(5);
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'maize');
    s = mutate(s, (d) => {
      d.rollModifiers[me] = 3;
    });
    const myTurnNo = s.turn?.number ?? 0;
    s = applyAction(s, { type: 'endTurn', player: me });
    // Foe's whole turn plays out; stop at my chooseHarvest (home + maize).
    s = drive(
      s,
      (x) => x.turn?.activePlayer === me && x.pendingDecision?.kind === 'chooseHarvest',
      300,
    );
    expect(s.turn?.number).toBeGreaterThan(myTurnNo);
    s = applyAction(s, { type: 'chooseHarvest', player: me, sourceKey: '2,2' });
    expect(s.events.some((e) => e.type === 'rollModified' && e.player === me && e.modifier === 3)).toBe(true);
    expect(s.events.some((e) => e.type === 'maizeHarvested' && e.player === me)).toBe(true);
    expect(s.rollModifiers[me]).toBe(0); // consumed
  });
});

describe('Slippery Trail', () => {
  it('moves 2 spaces in a straight orthogonal line', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withHand(g.state, me, 'slippery-trail');
    s = play(s, me, 'slippery-trail', { units: [g.unitId], spaces: [{ x: 4, y: 2 }] });
    expect(s.units[g.unitId].pos).toEqual({ x: 4, y: 2 });
  });

  it('cannot pass through an enemy on the intermediate space', () => {
    const { s, me, foe } = scenario();
    const mine = withGnome(s, me, { x: 2, y: 2 });
    const blocker = withGnome(mine.state, foe, { x: 3, y: 2 });
    const st = withHand(blocker.state, me, 'slippery-trail');
    expect(() =>
      play(st, me, 'slippery-trail', { units: [mine.unitId], spaces: [{ x: 4, y: 2 }] }),
    ).toThrow(/intermediate/i);
  });

  it('charges maize exit for the origin space', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'maize');
    s = withHand(s, me, 'slippery-trail');
    const before = s.players[me].wishes;
    expect(before).toBeGreaterThan(0);
    s = play(s, me, 'slippery-trail', { units: [g.unitId], spaces: [{ x: 4, y: 2 }] });
    expect(s.players[me].wishes).toBe(before - 1);
    expect(s.events.some((e) => e.type === 'maizeExitPaid' && e.player === me)).toBe(true);
  });
});

describe('Gust Of Wind', () => {
  it('may move an ENEMY gnome; its owner pays any maize exit cost', () => {
    let { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 4, y: 4 });
    s = withGarden(theirs.state, { x: 4, y: 4 }, 'maize');
    s = mutate(withHand(s, me, 'gust-of-wind'), (d) => {
      d.players[foe].wishes = 2;
    });
    s = play(s, me, 'gust-of-wind', { units: [theirs.unitId], spaces: [{ x: 4, y: 5 }] });
    expect(s.units[theirs.unitId].pos).toEqual({ x: 4, y: 5 });
    expect(s.players[foe].wishes).toBe(1); // the OWNER paid
  });

  it("is unplayable onto a locked exit the owner can't afford", () => {
    const { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 4, y: 4 });
    let st = withGarden(theirs.state, { x: 4, y: 4 }, 'maize');
    st = mutate(withHand(st, me, 'gust-of-wind'), (d) => {
      d.players[foe].wishes = 0;
    });
    expect(() =>
      play(st, me, 'gust-of-wind', { units: [theirs.unitId], spaces: [{ x: 4, y: 5 }] }),
    ).toThrow(/cannot pay/i);
  });
});

describe('Gnomebody Dies', () => {
  it('prevents the next gnome destruction this turn', () => {
    let { s, me, foe } = scenario();
    const victim = withGnome(s, foe, { x: 4, y: 4 });
    s = withHand(victim.state, me, 'gnomebody-dies', 'rocket-propelled-gnome');
    s = play(s, me, 'gnomebody-dies');
    expect(s.preventionShields).toBe(1);
    s = play(s, me, 'rocket-propelled-gnome', { units: [victim.unitId] });
    expect(s.units[victim.unitId]).toBeDefined(); // saved
    expect(s.preventionShields).toBe(0);
    expect(s.events.some((e) => e.type === 'destructionPrevented')).toBe(true);
  });
});

describe('Nope-Gnome', () => {
  it('cannot be played outside a card response window', () => {
    let { s, me } = scenario();
    s = withHand(s, me, 'nope-gnome');
    expect(() => play(s, me, 'nope-gnome')).toThrow(/in response/i);
    expect(getLegalActions(s).some((a) => a.type === 'playCard' && a.cardId === 'nope-gnome')).toBe(false);
  });
});

describe('Gnome Place Like Home', () => {
  it('teleports the target gnome to its OWNER’s Home Garden', () => {
    let { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 2, y: 2 });
    s = withHand(theirs.state, me, 'gnome-place-like-home');
    const home = s.players[foe].homePos;
    s = play(s, me, 'gnome-place-like-home', { units: [theirs.unitId] });
    expect(s.units[theirs.unitId].pos).toEqual(home);
  });

  it('rejects gnomes whose owner has no Home Garden', () => {
    const { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 2, y: 2 });
    const st = mutate(withHand(theirs.state, me, 'gnome-place-like-home'), (d) => {
      delete d.gardens[posKey(d.players[foe].homePos)];
    });
    expect(() => play(st, me, 'gnome-place-like-home', { units: [theirs.unitId] })).toThrow(
      /no longer has a Home Garden/i,
    );
  });
});

describe('Rocket Propelled Gnome', () => {
  it('destroys the target gnome and counts the loss', () => {
    let { s, me, foe } = scenario();
    const victim = withGnome(s, foe, { x: 4, y: 4 });
    s = withHand(victim.state, me, 'rocket-propelled-gnome');
    s = play(s, me, 'rocket-propelled-gnome', { units: [victim.unitId] });
    expect(s.units[victim.unitId]).toBeUndefined();
    expect(s.players[foe].gnomesLost).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ritual Magic
// ---------------------------------------------------------------------------

describe('Wild Growth', () => {
  it('plants free on an empty space (no gnome, no wish cost)', () => {
    let { s, me } = scenario();
    s = withHand(s, me, 'wild-growth');
    const wishes = s.players[me].wishes;
    s = play(s, me, 'wild-growth', { spaces: [{ x: 2, y: 4 }], gardenType: 'slippery' });
    expect(s.gardens['2,4']?.type).toBe('slippery');
    expect(s.gardens['2,4']?.plantedOnTurn).toBe(s.turn?.number);
    expect(s.supply.slippery).toBe(7);
    expect(s.players[me].wishes).toBe(wishes);
  });

  it('rejects occupied spaces', () => {
    const { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 2, y: 4 });
    const st = withHand(theirs.state, me, 'wild-growth');
    expect(() => play(st, me, 'wild-growth', { spaces: [{ x: 2, y: 4 }], gardenType: 'slippery' })).toThrow(
      /empty/i,
    );
  });
});

describe('Instigation', () => {
  it('makes two gnomes fight in place until one is destroyed', () => {
    let { s, me, foe } = scenario();
    const mine = withGnome(s, me, { x: 2, y: 2 });
    const theirs = withGnome(mine.state, foe, { x: 4, y: 4 });
    s = withHand(theirs.state, me, 'instigation');
    const before = totalGnomes(s);
    s = play(s, me, 'instigation', { units: [mine.unitId, theirs.unitId] });
    expect(s.fight).toBeNull();
    expect(totalGnomes(s)).toBe(before - 1);
    // The survivor did not move.
    const survivor = s.units[mine.unitId] ?? s.units[theirs.unitId];
    expect([JSON.stringify({ x: 2, y: 2 }), JSON.stringify({ x: 4, y: 4 })]).toContain(
      JSON.stringify(survivor.pos),
    );
    expect(s.events.some((e) => e.type === 'fightStarted' && e.cause === 'card')).toBe(true);
  });

  it('rejects two gnomes of the same owner', () => {
    const { s, me, foe } = scenario();
    const a = withGnome(s, me, { x: 2, y: 2 });
    const b = withGnome(a.state, me, { x: 4, y: 4 });
    // A foe gnome exists (so the card has *some* legal play), but the chosen
    // pair is same-owner — the target validation must reject it.
    const c = withGnome(b.state, foe, { x: 4, y: 2 });
    const st = withHand(c.state, me, 'instigation');
    expect(() => play(st, me, 'instigation', { units: [a.unitId, b.unitId] })).toThrow(
      /different owners/i,
    );
  });
});

describe('Lawnmower Of Doom', () => {
  it('destroys a non-Home garden orthogonally adjacent to an own gnome', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 3 }, 'dandelion');
    s = withHand(s, me, 'lawnmower-of-doom');
    const supply = s.supply.dandelion;
    s = play(s, me, 'lawnmower-of-doom', { spaces: [{ x: 2, y: 3 }] });
    expect(s.gardens['2,3']).toBeUndefined();
    expect(s.supply.dandelion).toBe(supply + 1); // tile returns to supply
  });

  it('cannot destroy Home Gardens', () => {
    const { s, me, foe } = scenario();
    const foeHome = s.players[foe].homePos;
    const g = withGnome(s, me, { x: foeHome.x, y: foeHome.y - 1 });
    let st = withGarden(g.state, { x: 2, y: 3 }, 'dandelion'); // satisfies hasAnyPlay
    const h = withGnome(st, me, { x: 2, y: 2 });
    st = withHand(h.state, me, 'lawnmower-of-doom');
    expect(() => play(st, me, 'lawnmower-of-doom', { spaces: [foeHome] })).toThrow(/Home Gardens/i);
  });
});

describe('Plot Twist', () => {
  it('swaps gardens and critters of two adjacent spaces together', () => {
    let { s, me, foe } = scenario();
    const mine = withGnome(s, me, { x: 2, y: 2 });
    const theirs = withGnome(mine.state, foe, { x: 2, y: 3 });
    s = withGarden(theirs.state, { x: 2, y: 2 }, 'dandelion');
    s = withHand(s, me, 'plot-twist');
    s = play(s, me, 'plot-twist', { spaces: [{ x: 2, y: 2 }, { x: 2, y: 3 }] });
    expect(s.gardens['2,3']?.type).toBe('dandelion');
    expect(s.gardens['2,2']).toBeUndefined();
    expect(s.units[mine.unitId].pos).toEqual({ x: 2, y: 3 });
    expect(s.units[theirs.unitId].pos).toEqual({ x: 2, y: 2 });
    expect(s.fight).toBeNull(); // pass-through creates no co-location
  });

  it('moves a swapped Home Garden’s anchor (homePos follows)', () => {
    let { s, me, foe } = scenario();
    const foeHome = { ...s.players[foe].homePos };
    const empty: Pos = { x: foeHome.x, y: foeHome.y - 1 };
    s = withHand(s, me, 'plot-twist');
    s = play(s, me, 'plot-twist', { spaces: [foeHome, empty] });
    expect(s.players[foe].homePos).toEqual(empty);
    expect(s.gardens[posKey(empty)]?.type).toBe('home');
    expect(s.gardens[posKey(foeHome)]).toBeUndefined();
  });
});

describe('Great Wall Of Whimsy', () => {
  it('cannot wall a Home Garden', () => {
    let { s, me, foe } = scenario();
    s = withGarden(s, { x: 2, y: 3 }, 'dandelion'); // satisfies hasAnyPlay
    s = withHand(s, me, 'great-wall-of-whimsy');
    expect(() => play(s, me, 'great-wall-of-whimsy', { spaces: [s.players[foe].homePos] })).toThrow(
      /cannot be walled/i,
    );
  });
});

describe('Sundown Sabotage', () => {
  it('makes the target garden skip exactly its next harvest', () => {
    let { s, me } = scenario(5);
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'dandelion');
    s = withHand(s, me, 'sundown-sabotage');
    s = play(s, me, 'sundown-sabotage', { spaces: [{ x: 2, y: 2 }] });
    expect(s.gardens['2,2']?.skipNextHarvest).toBe(true);

    // My next Harvest Phase: choosing the dandelion consumes the skip.
    s = applyAction(s, { type: 'endTurn', player: me });
    s = drive(
      s,
      (x) => x.turn?.activePlayer === me && x.pendingDecision?.kind === 'chooseHarvest',
      300,
    );
    s = applyAction(s, { type: 'chooseHarvest', player: me, sourceKey: '2,2' });
    expect(
      s.events.some((e) => e.type === 'harvestSkipped' && e.reason.includes('Sabotage')),
    ).toBe(true);
    expect(s.gardens['2,2']?.skipNextHarvest).toBeUndefined(); // one-shot
  });
});

describe('Ritual Magic (steal)', () => {
  it('steals a random card from the target’s hand', () => {
    let { s, me, foe } = scenario();
    // Ritual-only cards so the foe gets no response window.
    s = withHand(s, foe, 'wild-growth', 'instigation');
    s = withHand(s, me, 'ritual-magic');
    s = play(s, me, 'ritual-magic', { players: [foe] });
    expect(s.players[foe].hand).toHaveLength(1);
    expect(s.players[me].hand).toHaveLength(1);
    expect(['wild-growth', 'instigation']).toContain(s.players[me].hand[0]);
    expect(s.events.some((e) => e.type === 'cardStolen' && e.to === me && e.from === foe)).toBe(true);
  });

  it('rejects targets with no cards (and self)', () => {
    let { s, me, foe } = scenario();
    s = mutate(withHand(s, me, 'ritual-magic', 'ritual-magic'), (d) => {
      d.players[foe].hand = [];
    });
    expect(() => play(s, me, 'ritual-magic', { players: [foe] })).toThrow(/no legal targets|no cards/i);
  });
});

describe('Seeing Double', () => {
  it('clones the target gnome for its OWNER', () => {
    let { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 4, y: 4 });
    s = withHand(theirs.state, me, 'seeing-double');
    const before = s.players[foe].gnomesSpawned;
    s = play(s, me, 'seeing-double', { units: [theirs.unitId] });
    const clones = Object.values(s.units).filter(
      (u) => u.owner === foe && u.pos.x === 4 && u.pos.y === 4,
    );
    expect(clones).toHaveLength(2);
    expect(s.players[foe].gnomesSpawned).toBe(before + 1);
  });

  it('fizzles when the owner is at a gnome limit', () => {
    let { s, me, foe } = scenario();
    const theirs = withGnome(s, foe, { x: 4, y: 4 });
    s = mutate(withHand(theirs.state, me, 'seeing-double'), (d) => {
      d.players[foe].gnomesSpawned = d.config.totalReinforcements; // reserve = 0
    });
    s = play(s, me, 'seeing-double', { units: [theirs.unitId] });
    expect(s.events.some((e) => e.type === 'cardFizzled' && e.cardId === 'seeing-double')).toBe(true);
    expect(Object.values(s.units).filter((u) => u.owner === foe)).toHaveLength(1);
  });
});

describe('Gnomio & Juliet', () => {
  it('destroying one married gnome destroys the partner', () => {
    let { s, me, foe } = scenario();
    const a = withGnome(s, me, { x: 2, y: 2 });
    const b = withGnome(a.state, foe, { x: 4, y: 4 });
    s = withHand(b.state, me, 'gnomio-and-juliet', 'rocket-propelled-gnome');
    s = play(s, me, 'gnomio-and-juliet', { units: [a.unitId, b.unitId] });
    expect(s.marriages).toHaveLength(1);
    s = play(s, me, 'rocket-propelled-gnome', { units: [b.unitId] });
    expect(s.units[a.unitId]).toBeUndefined();
    expect(s.units[b.unitId]).toBeUndefined();
    expect(s.marriages).toHaveLength(0);
    expect(s.events.some((e) => e.type === 'unitDestroyed' && e.cause === 'marriage')).toBe(true);
  });

  it('Gnomebody Dies can shield the directly targeted spouse (marriage intact)', () => {
    let { s, me, foe } = scenario();
    const a = withGnome(s, me, { x: 2, y: 2 });
    const b = withGnome(a.state, foe, { x: 4, y: 4 });
    s = withHand(b.state, me, 'gnomio-and-juliet', 'gnomebody-dies', 'rocket-propelled-gnome');
    s = play(s, me, 'gnomio-and-juliet', { units: [a.unitId, b.unitId] });
    s = play(s, me, 'gnomebody-dies');
    s = play(s, me, 'rocket-propelled-gnome', { units: [b.unitId] });
    expect(s.units[a.unitId]).toBeDefined();
    expect(s.units[b.unitId]).toBeDefined();
    expect(s.marriages).toHaveLength(1);
  });
});

describe('Another Gnomes Treasure', () => {
  it('takes a chosen card from the discard into hand', () => {
    let { s, me } = scenario();
    s = mutate(withHand(s, me, 'another-gnomes-treasure'), (d) => {
      d.discard.push('snake-eyes');
    });
    s = play(s, me, 'another-gnomes-treasure', { cards: ['snake-eyes'] });
    expect(s.players[me].hand).toContain('snake-eyes');
    // The treasure card itself went to the discard; snake-eyes left it.
    expect(s.discard.filter((c) => c === 'snake-eyes')).toHaveLength(0);
    expect(s.discard).toContain('another-gnomes-treasure');
  });
});

describe('Mushroom Cloud', () => {
  it('destroys the garden and every gnome on its space', () => {
    let { s, me, foe } = scenario();
    const a = withGnome(s, foe, { x: 4, y: 4 });
    const b = withGnome(a.state, foe, { x: 4, y: 4 });
    s = withGarden(b.state, { x: 4, y: 4 }, 'mushroom');
    s = withHand(s, me, 'mushroom-cloud');
    const supply = s.supply.mushroom;
    s = play(s, me, 'mushroom-cloud', { spaces: [{ x: 4, y: 4 }] });
    expect(s.gardens['4,4']).toBeUndefined();
    expect(s.units[a.unitId]).toBeUndefined();
    expect(s.units[b.unitId]).toBeUndefined();
    expect(s.players[foe].gnomesLost).toBe(2);
    expect(s.supply.mushroom).toBe(supply + 1);
  });
});

describe('Pocket Shovel', () => {
  it('plants two tunnels on two empty spaces', () => {
    let { s, me } = scenario();
    s = withHand(s, me, 'pocket-shovel');
    s = play(s, me, 'pocket-shovel', { spaces: [{ x: 2, y: 4 }, { x: 4, y: 2 }] });
    expect(s.gardens['2,4']?.type).toBe('tunnel');
    expect(s.gardens['4,2']?.type).toBe('tunnel');
    expect(s.supply.tunnel).toBe(6);
  });

  it('with 1 tunnel left, requires (and plants) exactly one', () => {
    let { s, me } = scenario();
    s = mutate(withHand(s, me, 'pocket-shovel'), (d) => {
      d.supply.tunnel = 1;
    });
    expect(() => play(s, me, 'pocket-shovel', { spaces: [{ x: 2, y: 4 }, { x: 4, y: 2 }] })).toThrow(
      /exactly 1/i,
    );
    s = play(s, me, 'pocket-shovel', { spaces: [{ x: 2, y: 4 }] });
    expect(s.gardens['2,4']?.type).toBe('tunnel');
    expect(s.supply.tunnel).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Curse mechanics (draw & reshuffle)
// ---------------------------------------------------------------------------

describe('curse cards', () => {
  it('a drawn curse is revealed, becomes permanently active, and never enters a hand', () => {
    let { s, me } = scenario();
    s = mutate(s, (d) => {
      d.deck = ['curse-mulch-fever'];
    });
    const handBefore = s.players[me].hand.length;
    s = applyAction(s, { type: 'drawCard', player: me });
    expect(s.activeCurses).toContain('curse-mulch-fever');
    expect(s.players[me].hand).toHaveLength(handBefore);
    expect(s.events.some((e) => e.type === 'curseRevealed')).toBe(true);
    expect(s.deck).toHaveLength(0);
    expect(s.discard).not.toContain('curse-mulch-fever');
  });

  it('reshuffling the discard adds one random curse from the pool', () => {
    let { s, me } = scenario();
    s = mutate(s, (d) => {
      d.deck = [];
      d.discard = ['snake-eyes'];
    });
    expect(s.cursePool).toHaveLength(5);
    s = applyAction(s, { type: 'drawCard', player: me });
    const reshuffle = s.events.find((e) => e.type === 'deckReshuffled');
    expect(reshuffle && reshuffle.type === 'deckReshuffled' && reshuffle.curseAdded).toBeTruthy();
    expect(s.cursePool).toHaveLength(4);
  });
});
