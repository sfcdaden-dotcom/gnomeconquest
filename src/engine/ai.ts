/**
 * Heuristic CPU player.
 *
 * `chooseAiAction(state)` returns one legal action for the player who must
 * act right now, using ONLY the public engine API (getLegalActions + read-only
 * state queries). It is deterministic: no randomness, stable tie-breaking by
 * enumeration order — so seeded games driven by the AI replay identically.
 *
 * Heuristics (intentionally simple, tuned for a playable opponent):
 *  - Roll-off: roll.
 *  - Home harvest: take a gnome while the board force is small or wishes are
 *    plentiful; otherwise take the wish.
 *  - Harvest order: economy first, dangerous flytrap harvests last.
 *  - Mushroom: clone the maximum.
 *  - Slides / tunnels / Snailmaggedon moves: score destinations (advance
 *    toward the nearest enemy home / center, avoid active flytraps, only
 *    attack favorably); entry effects are declined unless a destination
 *    scores positive.
 *  - Respond windows:
 *      · fight — shield a gnome with Gnomebody Dies in a flytrap fight (only
 *        our own gnome can die there); in a home-stakes / late-game fight,
 *        swing the dice with 4 Leaf Clover (self) or Snake Eyes (opponent).
 *      · card — Nope-Gnome a card that would kill one of our gnomes
 *        (Rocket Propelled Gnome / Mushroom Cloud on our stack); failing a
 *        Nope, raise a Gnomebody Dies shield instead. Otherwise pass.
 *  - Action phase: plant economy gardens early (mushroom with deep reserves,
 *    dandelion otherwise), a maize or flytrap near home to guard the approach,
 *    and a tunnel once one already exists elsewhere on the board (a lone
 *    tunnel has nowhere to link to); march gnomes toward the nearest enemy
 *    home / the Center Star; attack when favorable; play Whimsy
 *    cards through `planCardPlay` (economy, removal, reinforcement and
 *    finisher moves — each with a deterministic target picker validated
 *    against the card's own `validate`); draw when wish-rich with hand room;
 *    end the turn when nothing scores above passing.
 *  - Discard (over hand limit): pitch the lowest static-value card.
 *  - Snailify: always continue as the Immortal Snail.
 *
 * Roll-influencing / shield cards (Snake Eyes, 4 Leaf Clover, Gnomebody Dies)
 * are never spent proactively in the Action Phase — they are held for the
 * respond windows above, where they actually swing an outcome.
 *
 * Difficulty (`state.players[actor].difficulty`, per seat, default 'normal'):
 *  - 'easy'   — never plays a response-window card (fight or card), and its
 *    fight-commitment ignores the late-game desperation ramp while barely
 *    weighing being outnumbered, so it both stalls forever and walks into
 *    bad fights along the way. A deliberately weaker, exploitable opponent.
 *  - 'normal' — the heuristics described above; this is today's opponent.
 *  - 'hard'   — normal's heuristics, sharpened (see scoreDestination and
 *    planCardPlay for the hard-only branches).
 */

import type { Action, CardId, CardTargets, GameState, PendingDecision, PlantableGardenType, PlayerId, Pos, Unit } from './types';
import { EngineError } from './types';
import { getLegalActionIntents, getPlayerToAct, getTargetOptions } from './engine';
import { getCardDef } from './cards';
import {
  canSpawnGnome,
  centerPos,
  enemyUnitsAt,
  gardenAt,
  gardenIsActive,
  gnomesOnBoard,
  manhattan,
  orthNeighbors,
  playerUnits,
  playerUnitsAt,
  reserveGnomes,
  samePos,
  unitsAt,
  wishCap,
} from './helpers';

/**
 * Pick one legal action for the player who must act.
 *
 * The AI plans against `getLegalActionIntents` (card plays without targets)
 * and supplies targets itself through `planCardPlay` and the respond-window
 * policies, which is cheaper than expanding every target combination. As a
 * structural guarantee that it can never emit a half-built action, whatever it
 * picks goes through `completeTargets` before being returned.
 */
export function chooseAiAction(state: GameState): Action {
  return completeTargets(state, chooseAiActionInner(state));
}

/**
 * Fill in targets for a card play that still needs them, using the engine's
 * own enumeration. A no-op for every action the planners target themselves;
 * it exists so that a future card without a dedicated planner degrades to
 * "play it with the first valid targets" instead of throwing at dispatch.
 */
function completeTargets(state: GameState, action: Action): Action {
  if (action.type !== 'playCard' && action.type !== 'respondPlayCard') return action;
  if (action.targets !== undefined) return action;
  const def = getCardDef(action.cardId);
  if (!def?.needsTargets) return action;
  const options = getTargetOptions(state, action);
  if (options.length === 0) return action; // nothing valid; dispatch will report why
  return { ...action, targets: options[0] };
}

function chooseAiActionInner(state: GameState): Action {
  const actor = getPlayerToAct(state);
  if (actor === null) throw new EngineError('ILLEGAL_ACTION', 'Game is finished; no action to choose');
  const legal = getLegalActionIntents(state, actor);
  if (legal.length === 0) throw new EngineError('INTERNAL', 'No legal actions available for the player to act');

  const d = state.pendingDecision;
  if (d) {
    switch (d.kind) {
      case 'rollOff':
        return legal[0];
      case 'discard':
        return chooseDiscard(state, actor);
      case 'fightRespond':
        return planFightRespond(state, actor, d);
      case 'cardResponse':
        return planCardResponse(state, actor, d);
      case 'snailify':
        return { type: 'snailify', player: actor, accept: true };
      case 'sacrificeGnome':
        // Magic Drain: give up the first (lowest-id) gnome.
        return legal[0];
      case 'homeHarvest': {
        const wantGnome =
          d.options.includes('gnome') &&
          (gnomesOnBoard(state, actor) < 4 || state.players[actor].wishes >= 3);
        return { type: 'homeHarvest', player: actor, take: wantGnome ? 'gnome' : 'wish' };
      }
      case 'chooseHarvest': {
        const order = ['dandelion', 'mushroom', 'maize', 'tunnel', 'slippery', 'home', 'flytrap'];
        const sorted = [...d.options].sort(
          (a, b) => order.indexOf(a.gardenType) - order.indexOf(b.gardenType),
        );
        return { type: 'chooseHarvest', player: actor, sourceKey: sorted[0].key };
      }
      case 'mushroomClones':
        return { type: 'mushroomClones', player: actor, count: d.max };
      case 'slide':
      case 'tunnel':
      case 'snailMove': {
        // Seed with declineEffect (score 0) when available so that a move is
        // taken only when it STRICTLY improves. Ties must favor declining:
        // optional entry effects chain (tunnel → tunnel → …), and two tunnels
        // equidistant from the target would otherwise ping-pong forever.
        let best: Action | null = null;
        let bestScore = -Infinity;
        if (legal.some((a) => a.type === 'declineEffect')) {
          best = { type: 'declineEffect', player: actor };
          bestScore = 0;
        }
        for (const a of legal) {
          if (a.type !== 'slide' && a.type !== 'tunnel' && a.type !== 'snailMove') continue;
          let score = scoreDestination(state, actor, d.from, a.to);
          if (samePos(a.to, d.from)) score = -0.25; // tunnel "stay" mildly discouraged
          if (score > bestScore) {
            bestScore = score;
            best = a;
          }
        }
        return best ?? legal[0];
      }
      default: {
        // Exhaustiveness: a new PendingDecision kind must be handled here.
        const missing: never = d;
        throw new EngineError('INTERNAL', `AI has no policy for decision ${JSON.stringify(missing)}`);
      }
    }
  }

  // Action Phase: pick the highest-scoring legal action. endTurn scores its
  // 0.1 baseline via scoreActionPhase; under Antsy Pants it may be absent
  // entirely, in which case the best remaining (forced) action is taken.
  //
  // `playCard` intents carry no targets; planCardPlay supplies a concrete,
  // `validate`-checked targeted action plus its score, so the action we return
  // is always dispatchable. Because getPlayerToAct only
  // routes here for the active player, `endTurn` or a forced move is always
  // present — `best` never falls back to an untargeted playCard.
  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const a of legal) {
    let candidate: Action = a;
    let score: number;
    if (a.type === 'playCard') {
      const plan = planCardPlay(state, actor, a.cardId);
      if (!plan) continue;
      candidate = plan.action;
      score = plan.score;
    } else {
      score = scoreActionPhase(state, actor, a);
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best ?? legal[0];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Nearest enemy home garden still standing, else the center. */
function primaryTarget(state: GameState, player: PlayerId, from: Pos): Pos {
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const g = gardenAt(state, p.homePos);
    if (!g || g.type !== 'home' || g.owner !== p.id) continue;
    const dist = manhattan(from, p.homePos);
    if (dist < bestDist) {
      bestDist = dist;
      best = p.homePos;
    }
  }
  return best ?? centerPos(state);
}

function isDangerousFlytrap(state: GameState, pos: Pos): boolean {
  const g = gardenAt(state, pos);
  return !!g && g.type === 'flytrap' && gardenIsActive(state, g) && g.stunnedForPlayerTurn === null;
}

/**
 * BFS distance field from `target`, routing around obstacles: spaces holding
 * enemy critters and active flytraps are impassable (except the target itself,
 * so the final assault square still scores). Unreachable squares fall back to
 * manhattan distance + a large penalty so they still order sensibly.
 */
function distanceField(state: GameState, player: PlayerId, target: Pos): number[] {
  const n = state.config.boardSize;
  const idx = (p: Pos) => p.y * n + p.x;
  const dist = new Array<number>(n * n).fill(Infinity);
  const queue: Pos[] = [target];
  dist[idx(target)] = 0;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const d of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
      const next = { x: cur.x + d.x, y: cur.y + d.y };
      if (next.x < 0 || next.y < 0 || next.x >= n || next.y >= n) continue;
      if (dist[idx(next)] !== Infinity) continue;
      if (enemyUnitsAt(state, next, player).length > 0 || isDangerousFlytrap(state, next)) continue;
      dist[idx(next)] = dist[idx(cur)] + 1;
      queue.push(next);
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (dist[y * n + x] === Infinity) dist[y * n + x] = manhattan({ x, y }, target) + 100;
    }
  }
  return dist;
}

/** Score arriving on `to` (used for moves, slides and tunnels). */
function scoreDestination(state: GameState, player: PlayerId, from: Pos, to: Pos): number {
  let score = 0;
  const target = primaryTarget(state, player, from);
  const n = state.config.boardSize;
  const dist = distanceField(state, player, target);
  score += (dist[from.y * n + from.x] - dist[to.y * n + to.x]) * 2; // advance (routes around stacks)

  if (state.config.centerStar && samePos(to, centerPos(state))) score += 4;
  if (isDangerousFlytrap(state, to)) score -= 40;

  const enemies = enemyUnitsAt(state, to, player);
  if (enemies.length > 0) {
    const destGarden = gardenAt(state, to);
    const attackingHome =
      !!destGarden && destGarden.type === 'home' && destGarden.owner !== undefined && destGarden.owner !== player;
    const difficulty = state.players[player].difficulty;
    if (difficulty === 'easy') {
      // Easy: no late-game push, and barely weighs being outnumbered —
      // walks into bad fights a Normal/Hard opponent would decline.
      score += (attackingHome ? 15 : 4) - 3 * enemies.length;
    } else if (difficulty === 'hard') {
      // Hard: an actual win-probability calculation instead of a flat
      // threshold. Stack fights are repeated fair 1v1 rounds until one side
      // is wiped (RULES.md "Fights") — a classic gambler's-ruin, so with 1
      // attacker vs `enemies.length` defenders, P(attacker wins) = 1 / (1 +
      // enemies.length). `effectiveAttackers` folds in a bounded late-game
      // push (replaces Normal's flat desperation ramp with the same shape,
      // applied inside the probability instead of on top of it).
      const desperation = Math.min(6, (state.turn?.number ?? 0) / 25);
      const effectiveAttackers = 1 + desperation * 0.15;
      const winProb = effectiveAttackers / (effectiveAttackers + enemies.length);
      const winPayoff = attackingHome ? 20 : 6;
      const losePenalty = 10;
      score += winProb * winPayoff - (1 - winProb) * losePenalty;
    } else {
      // 1v1 fights are coin flips: only worth it when storming a home or when
      // we are not outnumbered on arrival. Late-game desperation ramps up so
      // turtled stalemates still end (fights bleed reinforcements, and
      // reinforcement exhaustion eliminates): the longer the game runs, the
      // less a defended home scares us. Stateless and deterministic.
      const desperation = Math.min(6, (state.turn?.number ?? 0) / 25);
      score += (attackingHome ? 15 + desperation * 3 : 4) - (8 - desperation) * enemies.length;
    }
  }
  return score;
}

function scoreActionPhase(state: GameState, player: PlayerId, action: Action): number {
  const p = state.players[player];
  switch (action.type) {
    case 'move': {
      const unit = state.units[action.unitId];
      if (!unit) return -Infinity;
      let score = scoreDestination(state, player, unit.pos, action.to);
      // Flee gardens that will bite us at our next harvest.
      const here = gardenAt(state, unit.pos);
      if (here && here.type === 'flytrap' && !isDangerousFlytrap(state, action.to)) score += 10;
      // Never strip the last defender off our own home (unless it is our only
      // gnome — a lone gnome camping forever would stall the early game).
      const g = gardenAt(state, unit.pos);
      if (g && g.type === 'home' && g.owner === player) {
        const defenders = playerUnitsAt(state, unit.pos, player).length;
        if (defenders <= 1 && gnomesOnBoard(state, player) >= 2) score -= 12;
        else if (defenders <= 1 && enemyNear(state, player, unit.pos, 3)) score -= 6;
      }
      return score;
    }
    case 'plant': {
      if (p.wishes < 2) return -Infinity; // keep a wish buffer
      const own = ownedEconomyGardens(state, player);
      const home = p.homePos;
      if (action.gardenType === 'mushroom' && own < 2 && reserveGnomes(state, player) >= 6) return 9;
      if (action.gardenType === 'dandelion' && own < 3) return 8;
      if (
        action.gardenType === 'maize' &&
        manhattan(action.pos, home) <= 2 &&
        !samePos(action.pos, home) &&
        !hasOwnGardenTypeNearHome(state, player, 'maize')
      ) {
        // Taxes any unit exiting it, guard is symmetric — but placed near our
        // own home it slows an enemy assault more than it slows our defense.
        return 7;
      }
      if (
        action.gardenType === 'flytrap' &&
        manhattan(action.pos, home) <= 2 &&
        !samePos(action.pos, home) &&
        !hasOwnGardenTypeNearHome(state, player, 'flytrap')
      ) {
        return 6;
      }
      if (action.gardenType === 'tunnel' && anyTunnelOnBoard(state) && !hasOwnGardenTypeNearHome(state, player, 'tunnel')) {
        // A lone tunnel has nothing to link to; only worth planting once the
        // network already has at least one other node.
        return 5;
      }
      // Slippery: mandatory forced-slide on harvest relocates our own
      // occupant every cycle — a liability for whoever controls it, so the
      // AI never plants one on purpose.
      return -1;
    }
    case 'drawCard':
      // Draw only when wish-rich with hand room: cheap enough not to starve
      // plants/attacks (scores below them and above endTurn's 0.1), and never
      // so full that the draw forces an immediate discard.
      return p.wishes >= 4 && p.hand.length <= state.config.handLimit - 2 ? 0.5 : -1;
    case 'playCard':
      // Card plays are scored via planCardPlay in chooseAiAction (they need a
      // target payload); this path is unreachable for playCard.
      return -1;
    case 'endTurn':
      return 0.1;
    default:
      return -Infinity;
  }
}

function enemyNear(state: GameState, player: PlayerId, pos: Pos, radius: number): boolean {
  for (const u of Object.values(state.units)) {
    if (u.owner !== player && manhattan(u.pos, pos) <= radius) return true;
  }
  return false;
}

function ownedEconomyGardens(state: GameState, player: PlayerId): number {
  // Economy gardens currently occupied (≈ controlled) by this player.
  let count = 0;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'dandelion' && g.type !== 'mushroom') continue;
    const [x, y] = key.split(',').map(Number);
    if (playerUnitsAt(state, { x, y }, player).length > 0) count += 1;
  }
  return count;
}

function hasOwnGardenTypeNearHome(state: GameState, player: PlayerId, gardenType: PlantableGardenType): boolean {
  const home = state.players[player].homePos;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== gardenType) continue;
    const [x, y] = key.split(',').map(Number);
    if (manhattan({ x, y }, home) <= 2) return true;
  }
  return false;
}

function anyTunnelOnBoard(state: GameState): boolean {
  return Object.values(state.gardens).some((g) => g.type === 'tunnel');
}

// ---------------------------------------------------------------------------
// Card play (Action Phase)
// ---------------------------------------------------------------------------

/**
 * Static "keep value" of a card in hand — higher = more worth holding. Used to
 * choose a discard (pitch the lowest) and to pick the best card to recover with
 * Another Gnomes Treasure. Deterministic; no board context.
 */
function cardKeepValue(cardId: CardId): number {
  switch (cardId) {
    case 'rocket-propelled-gnome':
    case 'seeing-double':
      return 9;
    case 'mushroom-cloud':
    case 'wild-growth':
    case 'nope-gnome':
      return 8;
    case 'four-leaf-clover':
    case 'gnome-birthday-party':
    case 'gnomebody-dies':
    case 'lawnmower-of-doom':
      return 6;
    case 'snake-eyes':
    case 'gust-of-wind':
    case 'slippery-trail':
    case 'gnome-place-like-home':
    case 'ritual-magic':
    case 'another-gnomes-treasure':
    case 'instigation':
      return 5;
    case 'hidden-passage':
    case 'great-wall-of-whimsy':
      return 4;
    default:
      // sundown-sabotage, pocket-shovel, plot-twist, gnomio-and-juliet,
      // lost-in-the-maize — situational, cheap to pitch.
      return 3;
  }
}

/** Build a playCard action if the card's own validate accepts these targets. */
function tryPlayCard(
  state: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): Action | null {
  const def = getCardDef(cardId);
  if (!def) return null;
  if (def.validate && def.validate(state, player, targets) !== null) return null;
  return targets === undefined
    ? { type: 'playCard', player, cardId }
    : { type: 'playCard', player, cardId, targets };
}

/** Our Home Garden's space, or null if it has been destroyed. */
function ownHomePos(state: GameState, player: PlayerId): Pos | null {
  const hp = state.players[player].homePos;
  const g = gardenAt(state, hp);
  return g && g.type === 'home' && g.owner === player ? hp : null;
}

/** Own gnomes, lowest-id first (deterministic). */
function ownGnomes(state: GameState, player: PlayerId): Unit[] {
  return playerUnits(state, player).filter((u) => u.kind === 'gnome');
}

/** Enemy gnomes anywhere, lowest-id first. */
function enemyGnomes(state: GameState, player: PlayerId): Unit[] {
  return Object.values(state.units)
    .filter((u) => u.kind === 'gnome' && u.owner !== player)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Decide the best play (with targets) for one card in hand, or null to hold it.
 * Returns a `validate`-checked action and a score on the Action-Phase scale
 * (moves ~single digits, home-storm ~15+, plant 6–9, endTurn 0.1).
 */
function planCardPlay(
  state: GameState,
  player: PlayerId,
  cardId: CardId,
): { action: Action; score: number } | null {
  switch (cardId) {
    case 'gnome-birthday-party': {
      const gain = Math.min(2, wishCap(state, player) - state.players[player].wishes);
      if (gain <= 0) return null; // at cap: the 2 Wishes would be lost
      const a = tryPlayCard(state, player, cardId, undefined);
      return a ? { action: a, score: gain >= 2 ? 5 : 2 } : null;
    }

    case 'rocket-propelled-gnome': {
      let best: Unit | null = null;
      let bestVal = -Infinity;
      for (const u of enemyGnomes(state, player)) {
        const v = rocketTargetValue(state, player, u);
        if (v > bestVal) {
          bestVal = v;
          best = u;
        }
      }
      if (!best || bestVal < 9) return null; // don't waste a kill on a nobody
      const a = tryPlayCard(state, player, cardId, { units: [best.id] });
      return a ? { action: a, score: bestVal } : null;
    }

    case 'gnome-place-like-home': {
      const home = ownHomePos(state, player);
      const center = state.config.centerStar ? centerPos(state) : null;
      let best: Unit | null = null;
      let bestVal = 0;
      for (const u of enemyGnomes(state, player)) {
        let v = 0;
        if (home && samePos(u.pos, home)) v = 12; // evict an invader from our home
        else if (center && samePos(u.pos, center)) v = 5; // bump off the Center Star
        if (v > bestVal && tryPlayCard(state, player, cardId, { units: [u.id] })) {
          bestVal = v;
          best = u;
        }
      }
      if (!best) return null;
      const a = tryPlayCard(state, player, cardId, { units: [best.id] });
      return a ? { action: a, score: bestVal } : null;
    }

    case 'hidden-passage':
      return planFreeMove(state, player, cardId, DIAGONALS);
    case 'slippery-trail':
      return planFreeMove(state, player, cardId, STRAIGHT_TWOS);
    case 'gust-of-wind':
      return planFreeMove(state, player, cardId, ORTHOGONALS);

    case 'wild-growth':
      return planWildGrowth(state, player);

    case 'seeing-double': {
      if (!canSpawnGnome(state, player)) return null;
      const gnomes = ownGnomes(state, player);
      if (gnomes.length === 0) return null;
      // Prefer cloning a gnome on our home (adds a defender/reserve), else the
      // lowest-id gnome. The clone spawns on the same space.
      const home = ownHomePos(state, player);
      const pick = (home && gnomes.find((u) => samePos(u.pos, home))) ?? gnomes[0];
      const a = tryPlayCard(state, player, cardId, { units: [pick.id] });
      return a ? { action: a, score: 9 } : null;
    }

    case 'mushroom-cloud':
      return planMushroomCloud(state, player);
    case 'lawnmower-of-doom':
      return planLawnmower(state, player);
    case 'instigation':
      return planInstigation(state, player);
    case 'ritual-magic':
      return planSteal(state, player);
    case 'another-gnomes-treasure':
      return planTreasure(state, player);

    // Situational cards: need a board-state read to be worth playing at all,
    // so only Hard bothers (Easy/Normal hold them — see cardKeepValue).
    case 'great-wall-of-whimsy':
      return isHard(state, player) ? planGreatWall(state, player) : null;
    case 'sundown-sabotage':
      return isHard(state, player) ? planSundownSabotage(state, player) : null;
    case 'pocket-shovel':
      return isHard(state, player) ? planPocketShovel(state, player) : null;
    case 'plot-twist':
      return isHard(state, player) ? planPlotTwist(state, player) : null;
    case 'gnomio-and-juliet':
      return isHard(state, player) ? planGnomioAndJuliet(state, player) : null;
    case 'lost-in-the-maize':
      return isHard(state, player) ? planLostInTheMaize(state, player) : null;

    default:
      // Roll/shield cards are held for respond windows regardless of difficulty.
      return null;
  }
}

function isHard(state: GameState, player: PlayerId): boolean {
  return state.players[player].difficulty === 'hard';
}

/** Wall the non-Home garden nearest our home that an enemy is currently approaching. */
function planGreatWall(state: GameState, player: PlayerId): { action: Action; score: number } | null {
  const home = ownHomePos(state, player);
  if (!home) return null;
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type === 'home') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    const distHome = manhattan(pos, home);
    if (distHome > 4) continue; // only worth guarding our own approach
    const threatened = Object.values(state.units).some(
      (u) => u.owner !== player && u.kind === 'gnome' && manhattan(u.pos, pos) <= 2,
    );
    if (!threatened) continue;
    if (distHome < bestDist) {
      bestDist = distHome;
      best = pos;
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'great-wall-of-whimsy', { spaces: [best] });
  return a ? { action: a, score: 7 } : null;
}

/** Deny an enemy-occupied economy garden its next harvest. */
function planSundownSabotage(state: GameState, player: PlayerId): { action: Action; score: number } | null {
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'dandelion' && g.type !== 'mushroom') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    if (enemyUnitsAt(state, pos, player).length === 0) continue;
    const a = tryPlayCard(state, player, 'sundown-sabotage', { spaces: [pos] });
    if (a) return { action: a, score: 4 };
  }
  return null;
}

/** Plant free Tunnel(s) adjacent to our own gnomes (immediate access, no wish cost). */
function planPocketShovel(state: GameState, player: PlayerId): { action: Action; score: number } | null {
  const required = Math.min(2, state.supply.tunnel);
  if (required <= 0) return null;
  const n = state.config.boardSize;
  const isEmpty = (pos: Pos) =>
    pos.x >= 0 && pos.y >= 0 && pos.x < n && pos.y < n && !gardenAt(state, pos) && unitsAt(state, pos).length === 0;
  const seen = new Set<string>();
  const spaces: Pos[] = [];
  outer: for (const u of ownGnomes(state, player)) {
    for (const d of ORTHOGONALS) {
      const pos = { x: u.pos.x + d.x, y: u.pos.y + d.y };
      const key = `${pos.x},${pos.y}`;
      if (seen.has(key) || !isEmpty(pos)) continue;
      seen.add(key);
      spaces.push(pos);
      if (spaces.length === required) break outer;
    }
  }
  if (spaces.length < required) return null;
  const a = tryPlayCard(state, player, 'pocket-shovel', { spaces });
  return a ? { action: a, score: 5 } : null;
}

/**
 * Swap one of our gnomes adjacent to an enemy's home into that home when it
 * has exactly one defender — the swap relocates the defender away with no
 * Entry trigger, so it bypasses the fight entirely and captures for free.
 */
function planPlotTwist(state: GameState, player: PlayerId): { action: Action; score: number } | null {
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const homeGarden = gardenAt(state, p.homePos);
    if (!homeGarden || homeGarden.type !== 'home' || homeGarden.owner !== p.id) continue;
    const defenders = playerUnitsAt(state, p.homePos, p.id).filter((u) => u.kind === 'gnome');
    if (defenders.length !== 1) continue; // only a lone defender is worth the swap
    for (const d of ORTHOGONALS) {
      const n = { x: p.homePos.x + d.x, y: p.homePos.y + d.y };
      const ours = playerUnitsAt(state, n, player).filter((u) => u.kind === 'gnome');
      if (ours.length === 0) continue;
      const a = tryPlayCard(state, player, 'plot-twist', { spaces: [n, p.homePos] });
      if (a) return { action: a, score: 10 };
    }
  }
  return null;
}

/** Marry two of the SAME opponent's gnomes — pure upside: no cost to us, and any future kill of one takes both. */
function planGnomioAndJuliet(state: GameState, player: PlayerId): { action: Action; score: number } | null {
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const gnomes = Object.values(state.units).filter((u) => u.owner === p.id && u.kind === 'gnome');
    if (gnomes.length < 2) continue;
    const a = tryPlayCard(state, player, 'gnomio-and-juliet', { units: [gnomes[0].id, gnomes[1].id] });
    if (a) return { action: a, score: 3 };
  }
  return null;
}

/** Trap an enemy gnome that's currently sitting on a Maize Garden. */
function planLostInTheMaize(state: GameState, player: PlayerId): { action: Action; score: number } | null {
  const trapped = Object.values(state.units).some(
    (u) => u.owner !== player && u.kind === 'gnome' && gardenAt(state, u.pos)?.type === 'maize',
  );
  if (!trapped) return null;
  const a = tryPlayCard(state, player, 'lost-in-the-maize', undefined);
  return a ? { action: a, score: 4 } : null;
}

/** How valuable it is to Rocket-destroy this enemy gnome right now. */
function rocketTargetValue(state: GameState, player: PlayerId, u: Unit): number {
  let v = 3;
  const home = ownHomePos(state, player);
  if (home) {
    const d = manhattan(u.pos, home);
    if (d === 0) v += 22; // standing in our home — capture in progress
    else if (d === 1) v += 9; // one step from our home
    else if (d === 2) v += 3;
  }
  if (state.config.centerStar && samePos(u.pos, centerPos(state))) v += 5;
  // Reinforcement pressure: the closer the owner is to running out, the more a
  // kill contributes to eliminating them.
  const owner = state.players[u.owner];
  v += (owner.gnomesLost / state.config.totalReinforcements) * 6;
  return v;
}

const DIAGONALS: Pos[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
];
const ORTHOGONALS: Pos[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];
const STRAIGHT_TWOS: Pos[] = [
  { x: 0, y: -2 },
  { x: 2, y: 0 },
  { x: 0, y: 2 },
  { x: -2, y: 0 },
];

/** Minimum destination score for a free card-move to be worth a card. */
const FINISHER_MIN = 12;

/**
 * Free-move cards (Hidden Passage / Slippery Trail / Gust Of Wind on our own
 * gnome). Only spent as a finisher: the destination must score at least
 * FINISHER_MIN (≈ storming a home or seizing the Center Star), since a normal
 * board move is free. `validate` enforces adjacency / straight-line / exit
 * rules, so we only score candidates it accepts.
 */
function planFreeMove(
  state: GameState,
  player: PlayerId,
  cardId: CardId,
  offsets: Pos[],
): { action: Action; score: number } | null {
  let best: Action | null = null;
  let bestScore = FINISHER_MIN;
  for (const u of ownGnomes(state, player)) {
    for (const off of offsets) {
      const to = { x: u.pos.x + off.x, y: u.pos.y + off.y };
      const a = tryPlayCard(state, player, cardId, { units: [u.id], spaces: [to] });
      if (!a) continue;
      const score = scoreDestination(state, player, u.pos, to);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
  }
  return best ? { action: best, score: bestScore } : null;
}

/** Wild Growth: plant a free economy garden on an empty space near our home. */
function planWildGrowth(
  state: GameState,
  player: PlayerId,
): { action: Action; score: number } | null {
  const deepReserves = reserveGnomes(state, player) >= 6;
  const fewEconomy = ownedEconomyGardens(state, player) < 2;
  const wanted: Array<'mushroom' | 'dandelion'> =
    deepReserves && fewEconomy ? ['mushroom', 'dandelion'] : ['dandelion', 'mushroom'];
  const gardenType = wanted.find((g) => state.supply[g] > 0);
  if (!gardenType) return null;

  const home = ownHomePos(state, player) ?? state.players[player].homePos;
  const n = state.config.boardSize;
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const pos = { x, y };
      if (gardenAt(state, pos) !== null || unitsAt(state, pos).length > 0) continue;
      const dist = manhattan(pos, home);
      if (dist < bestDist) {
        bestDist = dist;
        best = pos;
      }
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'wild-growth', { spaces: [best], gardenType });
  return a ? { action: a, score: 7 } : null;
}

/** Mushroom Cloud: nuke the non-Home garden whose stack costs enemies the most. */
function planMushroomCloud(
  state: GameState,
  player: PlayerId,
): { action: Action; score: number } | null {
  let best: Pos | null = null;
  let bestVal = 6; // threshold: worth it mainly when it kills a gnome
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type === 'home') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    const occupants = unitsAt(state, pos);
    if (occupants.some((u) => u.owner === player)) continue; // never nuke our own
    let v = occupants.filter((u) => u.owner !== player && u.kind === 'gnome').length * 8;
    if (g.type === 'dandelion' || g.type === 'mushroom') v += 3;
    else if (g.type === 'flytrap' && gardenIsActive(state, g)) v += 2;
    if (v > bestVal) {
      bestVal = v;
      best = pos;
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'mushroom-cloud', { spaces: [best] });
  return a ? { action: a, score: bestVal } : null;
}

/** Lawnmower Of Doom: raze a threatening garden orthogonally next to our gnome. */
function planLawnmower(
  state: GameState,
  player: PlayerId,
): { action: Action; score: number } | null {
  let best: Pos | null = null;
  let bestVal = 5; // threshold
  for (const u of ownGnomes(state, player)) {
    for (const adj of orthNeighbors(state, u.pos)) {
      const g = gardenAt(state, adj);
      if (!g || g.type === 'home') continue;
      let v = 0;
      if (g.type === 'flytrap' && gardenIsActive(state, g) && g.stunnedForPlayerTurn === null) {
        v = 5; // an active flytrap that could bite us
      } else if (
        (g.type === 'dandelion' || g.type === 'mushroom') &&
        enemyUnitsAt(state, adj, player).some((x) => x.kind === 'gnome')
      ) {
        v = 6; // an enemy economy garden they are actively harvesting
      }
      if (v > bestVal && tryPlayCard(state, player, 'lawnmower-of-doom', { spaces: [adj] })) {
        bestVal = v;
        best = adj;
      }
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'lawnmower-of-doom', { spaces: [best] });
  return a ? { action: a, score: bestVal } : null;
}

/**
 * Instigation: only used to make two OTHER players' gnomes fight (a free gnome
 * loss for someone else). In a 2-player game there is no enemy-vs-enemy pair,
 * so this holds — pitting our own gnome into a coin-flip is not worth a card.
 */
function planInstigation(
  state: GameState,
  player: PlayerId,
): { action: Action; score: number } | null {
  const foes = enemyGnomes(state, player);
  for (let i = 0; i < foes.length; i++) {
    for (let j = i + 1; j < foes.length; j++) {
      if (foes[i].owner === foes[j].owner) continue;
      const a = tryPlayCard(state, player, 'instigation', { units: [foes[i].id, foes[j].id] });
      if (a) return { action: a, score: 4 };
    }
  }
  return null;
}

/** Ritual Magic (card): steal from the opponent holding the most cards. */
function planSteal(
  state: GameState,
  player: PlayerId,
): { action: Action; score: number } | null {
  if (state.players[player].hand.length >= state.config.handLimit) return null;
  let best: PlayerId | null = null;
  let bestCount = 0;
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    if (p.hand.length > bestCount) {
      bestCount = p.hand.length;
      best = p.id;
    }
  }
  if (best === null) return null;
  const a = tryPlayCard(state, player, 'ritual-magic', { players: [best] });
  return a ? { action: a, score: 3 } : null;
}

/** Another Gnomes Treasure: recover the highest-keep-value card from the discard. */
function planTreasure(
  state: GameState,
  player: PlayerId,
): { action: Action; score: number } | null {
  if (state.discard.length === 0) return null;
  if (state.players[player].hand.length >= state.config.handLimit) return null; // would force a discard
  let best: CardId | null = null;
  let bestVal = -Infinity;
  for (const id of state.discard) {
    const v = cardKeepValue(id);
    if (v > bestVal) {
      bestVal = v;
      best = id;
    }
  }
  if (best === null) return null;
  const a = tryPlayCard(state, player, 'another-gnomes-treasure', { cards: [best] });
  return a ? { action: a, score: 3 } : null;
}

// ---------------------------------------------------------------------------
// Respond windows
// ---------------------------------------------------------------------------

/** Lowest-static-value card in hand — the AI's pick when forced to discard. */
function chooseDiscard(state: GameState, player: PlayerId): Action {
  const hand = [...new Set(state.players[player].hand)];
  let pick = hand[0];
  let pickVal = cardKeepValue(pick);
  for (const id of hand) {
    const v = cardKeepValue(id);
    if (v < pickVal) {
      pickVal = v;
      pick = id;
    }
  }
  return { type: 'discardCard', player, cardId: pick };
}

/**
 * Fight Respond policy. Sudden cards only (no Nope here):
 *  - Gnomebody Dies shields our gnome in a flytrap fight — safe, since only our
 *    own gnome can be destroyed there (a flytrap loss just stuns it).
 *  - In a home-stakes or late-game fight, swing the dice: 4 Leaf Clover on
 *    ourselves, else Snake Eyes on a player opponent.
 * Otherwise pass and keep the cards.
 */
function planFightRespond(
  state: GameState,
  actor: PlayerId,
  d: Extract<PendingDecision, { kind: 'fightRespond' }>,
): Action {
  const pass: Action = { type: 'respondPass', player: actor };
  if (state.players[actor].difficulty === 'easy') return pass; // never plays response cards
  const f = state.fight;
  if (!f) return pass;
  const playable = d.playableCards;

  const ourIdx =
    f.sides[0].kind === 'player' && f.sides[0].player === actor
      ? 0
      : f.sides[1].kind === 'player' && f.sides[1].player === actor
        ? 1
        : -1;
  if (ourIdx < 0) return pass;
  const opp = f.sides[ourIdx === 0 ? 1 : 0];
  const flytrapFight = f.sides[0].kind === 'flytrap' || f.sides[1].kind === 'flytrap';

  if (flytrapFight && state.preventionShields === 0 && playable.includes('gnomebody-dies')) {
    return { type: 'respondPlayCard', player: actor, cardId: 'gnomebody-dies' };
  }

  const g = gardenAt(state, f.pos);
  const important = (g !== null && g.type === 'home') || (state.turn?.number ?? 0) >= 60;
  if (important) {
    // Don't stack a second Clover while one is still pending (unconsumed).
    if ((state.rollModifiers[actor] ?? 0) <= 0 && playable.includes('four-leaf-clover')) {
      return { type: 'respondPlayCard', player: actor, cardId: 'four-leaf-clover' };
    }
    if (opp.kind === 'player' && playable.includes('snake-eyes')) {
      return {
        type: 'respondPlayCard',
        player: actor,
        cardId: 'snake-eyes',
        targets: { players: [opp.player] },
      };
    }
  }
  return pass;
}

/**
 * Card Respond policy: Nope-Gnome a card that would kill one of our gnomes
 * (Rocket Propelled Gnome aimed at us, or Mushroom Cloud on a space we occupy).
 * If we can't Nope but hold Gnomebody Dies, raise a shield instead. Otherwise
 * pass — Nope-Gnome is too valuable to burn on anything less.
 */
function planCardResponse(
  state: GameState,
  actor: PlayerId,
  d: Extract<PendingDecision, { kind: 'cardResponse' }>,
): Action {
  const pass: Action = { type: 'respondPass', player: actor };
  if (state.players[actor].difficulty === 'easy') return pass; // never plays response cards
  const entry = state.cardStack[d.stackIndex];
  if (!entry || entry.cancelled) return pass;
  if (!cardWouldKillOurGnome(state, actor, entry.cardId, entry.targets)) return pass;

  if (d.playableCards.includes('nope-gnome')) {
    return { type: 'respondPlayCard', player: actor, cardId: 'nope-gnome' };
  }
  if (state.preventionShields === 0 && d.playableCards.includes('gnomebody-dies')) {
    return { type: 'respondPlayCard', player: actor, cardId: 'gnomebody-dies' };
  }
  return pass;
}

/** Would this stacked card destroy one of `actor`'s gnomes? */
function cardWouldKillOurGnome(
  state: GameState,
  actor: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): boolean {
  if (cardId === 'rocket-propelled-gnome') {
    const id = targets?.units?.[0];
    const u = id ? state.units[id] : undefined;
    return !!u && u.owner === actor && u.kind === 'gnome';
  }
  if (cardId === 'mushroom-cloud') {
    const pos = targets?.spaces?.[0];
    return !!pos && playerUnitsAt(state, pos, actor).some((u) => u.kind === 'gnome');
  }
  return false;
}

/** True when every unit of `player` has already moved this turn (AI helper). */
export function allUnitsMoved(state: GameState, player: PlayerId): boolean {
  const t = state.turn;
  if (!t) return true;
  return playerUnits(state, player).every((u) => u.movedOnTurn === t.number);
}
