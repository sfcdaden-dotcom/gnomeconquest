/**
 * Whimsy Wars engine — shared types.
 *
 * The engine is a pure, deterministic state machine:
 *   createGame(options, seed) -> GameState
 *   getLegalActions(state)    -> Action[]
 *   applyAction(state, act)   -> GameState   (never mutates its input)
 *
 * The state is always either awaiting a normal Action-Phase action from the
 * active player, or awaiting a specific typed decision (`state.pendingDecision`)
 * from a specific player. Everything in GameState is plain JSON-serializable
 * data (no functions, no class instances), so it can be snapshotted, diffed,
 * persisted and replayed.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Seat index, 0-based. Seats are arranged clockwise around the board. */
export type PlayerId = number;
export type UnitId = string;
export type CardId = string;
/** `"x,y"` string key into `GameState.gardens`. */
export type PosKey = string;

export interface Pos {
  x: number;
  y: number;
}

export type GardenType =
  | 'home'
  | 'dandelion'
  | 'mushroom'
  | 'flytrap'
  | 'maize'
  | 'slippery'
  | 'tunnel';

export type PlantableGardenType = Exclude<GardenType, 'home'>;

export type UnitKind = 'gnome' | 'snail';
export type PlayerController = 'human' | 'cpu';

/**
 * 'playing'  — normal participant.
 * 'snail'    — eliminated, continuing as an Immortal Snail (cannot win).
 * 'out'      — eliminated and no longer on the board at all.
 */
export type PlayerStatus = 'playing' | 'snail' | 'out';

export type GardenPreset = 'none' | 'few' | 'many';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PlayerSetup {
  name?: string;
  controller: PlayerController;
}

/** Fully-resolved game configuration (stored on the state). */
export interface GameConfig {
  /** Odd number >= 5 (>= 7 when gardenPreset is 'few' or 'many'). Default 7. */
  boardSize: number;
  /** Default 3. */
  startingWishes: number;
  /** Default 5. +1 while the player occupies the Center Star space. */
  wishLimit: number;
  /** Max gnomes on the board per player. Default 8. */
  gnomeBoardLimit: number;
  /** Total gnomes a player may ever spawn. Default 16. */
  totalReinforcements: number;
  /** Default 7. */
  handLimit: number;
  /** Center Star marker on the center space. Default true. */
  centerStar: boolean;
  /** Additional-garden layout preset. Default 'none'. */
  gardenPreset: GardenPreset;
  /** 2 or 4 seats, clockwise. */
  players: Array<{ name: string; controller: PlayerController }>;
}

/** Input to createGame: players required, everything else defaulted. */
export type CreateGameOptions = Partial<Omit<GameConfig, 'players'>> & {
  players: PlayerSetup[];
};

// ---------------------------------------------------------------------------
// Board entities
// ---------------------------------------------------------------------------

export interface Garden {
  type: GardenType;
  /** Owner seat — Home Gardens only. */
  owner?: PlayerId;
  /**
   * Global turn number the garden was planted on (0 = pre-game setup).
   * A garden is Active once `plantedOnTurn < turn.number`.
   */
  plantedOnTurn: number;
  /** Flytrap only: stunned until the end of this player's turn. */
  stunnedForPlayerTurn: PlayerId | null;
  /** Maize only: exit cost doubled until the end of this player's turn. */
  doubledForPlayerTurn: PlayerId | null;
  /** Sundown Sabotage: this garden skips its next harvest. */
  skipNextHarvest?: boolean;
}

export interface Unit {
  id: UnitId;
  owner: PlayerId;
  kind: UnitKind;
  pos: Pos;
  /** Global turn number this unit last used its own 1-space move. */
  movedOnTurn: number | null;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  controller: PlayerController;
  status: PlayerStatus;
  wishes: number;
  hand: CardId[];
  /** Total gnomes ever spawned (max = totalReinforcements). */
  gnomesSpawned: number;
  /** Total gnomes destroyed. gnomesLost === totalReinforcements ⇒ eliminated. */
  gnomesLost: number;
  /**
   * Where this player's Home Garden was placed at setup. Kept even if the
   * garden is later destroyed (the Snail is placed here on conversion).
   */
  homePos: Pos;
}

// ---------------------------------------------------------------------------
// Turn / phase machinery
// ---------------------------------------------------------------------------

export type TurnPhase = 'harvest' | 'action';

export interface TurnState {
  /** Global player-turn counter, starts at 1. */
  number: number;
  activePlayer: PlayerId;
  phase: TurnPhase;
  /** Set when the active Snail lost a fight this turn (skips garden destruction). */
  snailLostFight: boolean;
}

export interface RolloffState {
  /** Players still competing in the current roll-off round. */
  participants: PlayerId[];
  /** Players who have not yet rolled this round. */
  pending: PlayerId[];
  /** Rolls of the current round, by seat (null = not rolled this round). */
  rolls: Array<number | null>;
}

// ---------------------------------------------------------------------------
// Harvest machinery
// ---------------------------------------------------------------------------

export type HarvestSourceKind = 'home' | 'garden' | 'flytrap';

export interface HarvestSource {
  /** Unique key used in ChooseHarvestAction. 'home' or the garden's PosKey. */
  key: string;
  kind: HarvestSourceKind;
  pos: Pos;
  gardenType: GardenType;
}

export interface HarvestMove {
  unitId: UnitId;
  effect: 'slippery' | 'tunnel';
  /** Position of the garden that triggered the move (unit must still be there). */
  pos: Pos;
}

export interface HarvestState {
  /** Unresolved harvest sources, resolved one at a time in owner-chosen order. */
  remaining: HarvestSource[];
  /** Pending per-gnome slide/tunnel resolutions of the current source. */
  moveQueue: HarvestMove[];
  /**
   * Snailmaggedon curse: snail owners who may still move their snail 1 space
   * during this Harvest Phase (in turn order).
   */
  snailMoves: PlayerId[];
}

// ---------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------

export type FightSide =
  | { kind: 'player'; player: PlayerId }
  | { kind: 'flytrap' };

export type FightCause = 'entry' | 'harvest' | 'placement' | 'card';

/**
 * sides[0] is the defender (responds first in the Respond window),
 * sides[1] is the attacker / initiator (relevant for the Mulch Fever curse).
 */
export interface FightState {
  id: number;
  pos: Pos;
  sides: [FightSide, FightSide];
  /** Flytrap fights are 1v1 against this specific unit. */
  targetUnit: UnitId | null;
  /**
   * Instigation: the fight is pinned to two specific gnomes ([defender,
   * attacker], matching `sides`) who fight without moving, wherever they are.
   */
  pinned: [UnitId, UnitId] | null;
  cause: FightCause;
  round: number;
  /** Which side's respond window is currently open (index into sides). */
  respondIdx: 0 | 1;
  /** Consecutive passes; 2 ⇒ Respond is over, Roll happens. */
  passes: number;
}

export interface QueuedFight {
  pos: Pos;
  sides: [FightSide, FightSide];
  targetUnit: UnitId | null;
  pinned: [UnitId, UnitId] | null;
  cause: FightCause;
}

// ---------------------------------------------------------------------------
// Eliminations
// ---------------------------------------------------------------------------

export type EliminationReason = 'home-captured' | 'reinforcements';

export interface PendingElimination {
  player: PlayerId;
  reason: EliminationReason;
}

// ---------------------------------------------------------------------------
// Card stack & timed effects
// ---------------------------------------------------------------------------

/** A Whimsy card that has been played and awaits resolution (LIFO stack). */
export interface CardStackEntry {
  player: PlayerId;
  cardId: CardId;
  targets?: CardTargets;
  /** Nope-Gnome sets this on its victim; a cancelled card resolves to nothing. */
  cancelled: boolean;
  /** Nope-Gnome only: index into the stack of the entry it cancels. */
  nopeTarget?: number;
}

export type TimedEffectKind = 'greatWall' | 'lostInMaize';

/** "Until your next turn" effects; expire at the start of the caster's turn. */
export interface TimedEffect {
  kind: TimedEffectKind;
  caster: PlayerId;
  /** greatWall: the walled garden's space. */
  pos?: Pos;
}

// ---------------------------------------------------------------------------
// Decisions (interrupt model)
// ---------------------------------------------------------------------------

export type HomeHarvestChoice = 'wish' | 'gnome';

export type PendingDecision =
  | { kind: 'rollOff'; player: PlayerId }
  | { kind: 'chooseHarvest'; player: PlayerId; options: HarvestSource[] }
  | { kind: 'homeHarvest'; player: PlayerId; options: HomeHarvestChoice[] }
  | { kind: 'mushroomClones'; player: PlayerId; pos: Pos; max: number }
  | {
      kind: 'slide';
      player: PlayerId;
      unitId: UnitId;
      from: Pos;
      options: Pos[];
      /** true ⇒ entry effect (may be declined); false ⇒ mandatory harvest slide. */
      optional: boolean;
      context: 'entry' | 'harvest';
    }
  | {
      kind: 'tunnel';
      player: PlayerId;
      unitId: UnitId;
      from: Pos;
      options: Pos[];
      optional: boolean;
      context: 'entry' | 'harvest';
    }
  | {
      kind: 'fightRespond';
      player: PlayerId;
      fightId: number;
      /** Sudden-magic cards this player could legally play right now. */
      playableCards: CardId[];
    }
  | {
      /** Response window: `player` may play Sudden Magic (e.g. Nope-Gnome)
       *  in response to the card at `stackIndex` before it resolves. */
      kind: 'cardResponse';
      player: PlayerId;
      respondingToCard: CardId;
      respondingToPlayer: PlayerId;
      stackIndex: number;
      playableCards: CardId[];
    }
  | { kind: 'discard'; player: PlayerId; mustDiscard: number }
  | { kind: 'snailify'; player: PlayerId }
  | {
      /** Magic Drain curse: choose one of your gnomes to sacrifice. */
      kind: 'sacrificeGnome';
      player: PlayerId;
      options: UnitId[];
    }
  | {
      /** Snailmaggedon curse: optionally move your snail 1 space during the
       *  current Harvest Phase (declineEffect passes). */
      kind: 'snailMove';
      player: PlayerId;
      unitId: UnitId;
      from: Pos;
      options: Pos[];
    };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CardTargets {
  units?: UnitId[];
  spaces?: Pos[];
  players?: PlayerId[];
  /** Cards chosen from a zone (Another Gnomes Treasure: from the discard). */
  cards?: CardId[];
  /** Garden type choice (Wild Growth). */
  gardenType?: PlantableGardenType;
}

export type Action =
  // --- decision answers -----------------------------------------------------
  | { type: 'rollOff'; player: PlayerId }
  | { type: 'chooseHarvest'; player: PlayerId; sourceKey: string }
  | { type: 'homeHarvest'; player: PlayerId; take: HomeHarvestChoice }
  | { type: 'mushroomClones'; player: PlayerId; count: number }
  | { type: 'slide'; player: PlayerId; to: Pos }
  | { type: 'tunnel'; player: PlayerId; to: Pos }
  | { type: 'declineEffect'; player: PlayerId }
  | { type: 'respondPass'; player: PlayerId }
  | { type: 'respondPlayCard'; player: PlayerId; cardId: CardId; targets?: CardTargets }
  | { type: 'discardCard'; player: PlayerId; cardId: CardId }
  | { type: 'snailify'; player: PlayerId; accept: boolean }
  | { type: 'sacrificeGnome'; player: PlayerId; unitId: UnitId }
  | { type: 'snailMove'; player: PlayerId; to: Pos }
  // --- action-phase actions ---------------------------------------------------
  | { type: 'move'; player: PlayerId; unitId: UnitId; to: Pos }
  | { type: 'plant'; player: PlayerId; pos: Pos; gardenType: PlantableGardenType }
  | { type: 'drawCard'; player: PlayerId }
  | { type: 'playCard'; player: PlayerId; cardId: CardId; targets?: CardTargets }
  | { type: 'endTurn'; player: PlayerId };

export type ActionType = Action['type'];

// ---------------------------------------------------------------------------
// Events (append-only log; useful for UI animation & tests)
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'rollOffRolled'; player: PlayerId; roll: number }
  | { type: 'rollOffTie'; players: PlayerId[] }
  | { type: 'turnOrderDetermined'; first: PlayerId }
  | { type: 'turnStarted'; player: PlayerId; turnNumber: number }
  | { type: 'harvestPhaseStarted'; player: PlayerId; sources: string[] }
  | { type: 'actionPhaseStarted'; player: PlayerId }
  | { type: 'harvestSkipped'; sourceKey: string; reason: string }
  | { type: 'homeHarvested'; player: PlayerId; took: 'wish' | 'gnome' | 'nothing' }
  | { type: 'dandelionHarvested'; player: PlayerId; pos: Pos; gnomes: number }
  | { type: 'mushroomHarvested'; player: PlayerId; pos: Pos; cloned: number }
  | { type: 'maizeHarvested'; player: PlayerId; pos: Pos; roll: number; doubled: boolean }
  | { type: 'wishesGained'; player: PlayerId; requested: number; gained: number; lost: number }
  | { type: 'wishesSpent'; player: PlayerId; amount: number; reason: string }
  | { type: 'gnomeSpawned'; player: PlayerId; unitId: UnitId; pos: Pos }
  | { type: 'unitMoved'; player: PlayerId; unitId: UnitId; from: Pos; to: Pos }
  | { type: 'unitSlid'; player: PlayerId; unitId: UnitId; from: Pos; to: Pos; context: 'entry' | 'harvest' }
  | { type: 'unitTunneled'; player: PlayerId; unitId: UnitId; from: Pos; to: Pos; context: 'entry' | 'harvest' }
  | { type: 'entryEffectDeclined'; player: PlayerId; unitId: UnitId; pos: Pos }
  | { type: 'gardenPlanted'; player: PlayerId; pos: Pos; gardenType: PlantableGardenType }
  | { type: 'gardenDestroyed'; pos: Pos; gardenType: GardenType; cause: 'snail' | 'card' | 'elimination' }
  | { type: 'maizeExitPaid'; player: PlayerId; pos: Pos; cost: number }
  | { type: 'cardDrawn'; player: PlayerId; cardId: CardId }
  | { type: 'cardDiscarded'; player: PlayerId; cardId: CardId }
  | { type: 'cardPlayed'; player: PlayerId; cardId: CardId }
  | { type: 'cardResolved'; player: PlayerId; cardId: CardId }
  | { type: 'cardCancelled'; player: PlayerId; cardId: CardId }
  | { type: 'cardFizzled'; player: PlayerId; cardId: CardId; reason: string }
  | { type: 'cardStolen'; from: PlayerId; to: PlayerId; cardId: CardId }
  | { type: 'curseRevealed'; player: PlayerId; cardId: CardId }
  | { type: 'deckReshuffled'; curseAdded: CardId | null }
  | { type: 'rollModified'; player: PlayerId; raw: number; modifier: number; result: number }
  | { type: 'destructionPrevented'; player: PlayerId; unitId: UnitId }
  | { type: 'gnomesMarried'; unitA: UnitId; unitB: UnitId }
  | { type: 'unitTeleported'; player: PlayerId; unitId: UnitId; from: Pos; to: Pos; cardId: CardId }
  | { type: 'spacesSwapped'; a: Pos; b: Pos }
  | { type: 'timedEffectStarted'; kind: TimedEffectKind; player: PlayerId; pos: Pos | null }
  | { type: 'timedEffectExpired'; kind: TimedEffectKind; player: PlayerId }
  | { type: 'fightStarted'; fightId: number; pos: Pos; sides: [FightSide, FightSide]; cause: FightCause }
  | { type: 'fightRoundStarted'; fightId: number; round: number }
  | { type: 'fightRolled'; fightId: number; round: number; rolls: [number, number]; tie: boolean }
  | { type: 'unitDestroyed'; player: PlayerId; unitId: UnitId; pos: Pos; cause: string }
  | { type: 'flytrapStunned'; pos: Pos; untilEndOfTurnOf: PlayerId }
  | { type: 'snailSurvivedLoss'; player: PlayerId; pos: Pos }
  | { type: 'fightEnded'; fightId: number; pos: Pos }
  | { type: 'playerEliminated'; player: PlayerId; reason: EliminationReason }
  | { type: 'playerSnailified'; player: PlayerId; pos: Pos }
  | { type: 'snailifyDeclined'; player: PlayerId }
  | { type: 'turnEnded'; player: PlayerId }
  | { type: 'gameFinished'; winner: PlayerId | null };

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export type GameStatus = 'rolloff' | 'playing' | 'finished';

export interface GameState {
  schemaVersion: 1;
  config: GameConfig;
  /** Seed the game was created with (informational). */
  seed: number;
  /** Current mulberry32 RNG state. ALL randomness flows through this. */
  rngState: number;
  status: GameStatus;
  rolloff: RolloffState | null;
  players: PlayerState[];
  /** Gardens by "x,y" PosKey. */
  gardens: Record<PosKey, Garden>;
  /** Units by UnitId. */
  units: Record<UnitId, Unit>;
  /** Remaining shared-supply tiles per plantable garden type. */
  supply: Record<PlantableGardenType, number>;
  /** Draw pile (top = last element). Card ids reference cards.ts definitions. */
  deck: CardId[];
  discard: CardId[];
  /** Curse card ids not yet shuffled into the deck. */
  cursePool: CardId[];
  /** Curses revealed so far; permanently in effect. */
  activeCurses: CardId[];
  turn: TurnState | null;
  harvest: HarvestState | null;
  fight: FightState | null;
  fightQueue: QueuedFight[];
  /** Whimsy cards played but not yet resolved (LIFO). */
  cardStack: CardStackEntry[];
  /** Players still owed a response window to the top of the card stack. */
  responseQueue: PlayerId[];
  /** Pending "next dice roll" modifiers per seat (Snake Eyes / 4 Leaf Clover). */
  rollModifiers: number[];
  /** Gnomebody Dies shields: next gnome destructions this turn are prevented. */
  preventionShields: number;
  /** Gnomio & Juliet marriages: destroying one destroys the partner. */
  marriages: Array<[UnitId, UnitId]>;
  /** Great Wall Of Whimsy / Lost In The Maize ("until your next turn"). */
  timedEffects: TimedEffect[];
  eliminationQueue: PendingElimination[];
  /** Force the active player's turn to end as soon as interrupts settle. */
  turnMustEnd: boolean;
  pendingDecision: PendingDecision | null;
  winner: PlayerId | null;
  nextUnitId: number;
  nextFightId: number;
  /**
   * Rolling window of the most recent events (engine trims to the last 1000
   * after each action so long games stay cheap to clone). Use `eventCount`
   * to diff "events added by an action" across states.
   */
  events: GameEvent[];
  /** Total events ever emitted (monotonic; never trimmed). */
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EngineErrorCode =
  | 'ILLEGAL_ACTION' // the action is not legal in the current state
  | 'BAD_ARGUMENT' // malformed payload (unknown ids, out-of-range values)
  | 'BAD_CONFIG' // invalid createGame options
  | 'INTERNAL'; // engine invariant violated (bug)

/** All engine rejections are thrown as EngineError with a clear message. */
export class EngineError extends Error {
  code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
