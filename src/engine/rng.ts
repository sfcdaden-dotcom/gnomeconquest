/**
 * Seeded, injectable RNG (mulberry32).
 *
 * ALL engine randomness (dice, shuffles, curse injection) flows through the
 * pure step functions below, operating on the `rngState` number stored in
 * GameState. Same seed + same action sequence ⇒ identical rolls, always.
 *
 * Two APIs are provided:
 *  - Pure step functions (`rngNext`, `rollDie`, `rngInt`, `shuffled`) that take
 *    a state number and return `{ value, state }`. The engine uses these.
 *  - A stateful `Rng` wrapper (`createRng`) for convenience in setup / tests.
 */

/** Stateful RNG interface (thin wrapper over the pure step functions). */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Die roll in [1, sides]. */
  die(sides?: number): number;
  /** Current internal state (can be stored and resumed). */
  getState(): number;
}

/** Normalize an arbitrary number into a valid uint32 seed. */
export function normalizeSeed(seed: number): number {
  // Mix the seed a little so 0/1/2… still diverge quickly.
  let h = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** One mulberry32 step: returns a float in [0,1) and the advanced state. */
export function rngNext(state: number): { value: number; state: number } {
  const newState = (state + 0x6d2b79f5) >>> 0;
  let t = newState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: newState };
}

/** Uniform integer in [0, maxExclusive). */
export function rngInt(state: number, maxExclusive: number): { value: number; state: number } {
  const r = rngNext(state);
  return { value: Math.floor(r.value * maxExclusive), state: r.state };
}

/** Die roll in [1, sides] (default d6). */
export function rollDie(state: number, sides: number = 6): { value: number; state: number } {
  const r = rngInt(state, sides);
  return { value: r.value + 1, state: r.state };
}

/** Fisher–Yates shuffle; returns a NEW array (input untouched). */
export function shuffled<T>(state: number, items: readonly T[]): { value: T[]; state: number } {
  const arr = items.slice();
  let s = state;
  for (let i = arr.length - 1; i > 0; i--) {
    const r = rngInt(s, i + 1);
    s = r.state;
    const j = r.value;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return { value: arr, state: s };
}

/** Create a stateful RNG seeded with `seed`. */
export function createRng(seed: number): Rng {
  let state = normalizeSeed(seed);
  return {
    next() {
      const r = rngNext(state);
      state = r.state;
      return r.value;
    },
    int(maxExclusive: number) {
      const r = rngInt(state, maxExclusive);
      state = r.state;
      return r.value;
    },
    die(sides: number = 6) {
      const r = rollDie(state, sides);
      state = r.state;
      return r.value;
    },
    getState() {
      return state;
    },
  };
}
