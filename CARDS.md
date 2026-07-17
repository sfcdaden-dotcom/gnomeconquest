# Whimsy Wars — Card Spec (v1)

Official card list from the designer's "Whimsy Card List" document, with digital-
implementation rulings marked **[IMPL]**. This file is the source of truth for
`src/engine/cards.ts`.

## Deck composition

- **[DESIGNER CONFIRMED]** **2 copies of each Whimsy card** → 46-card deck
  (20 Sudden + 26 Ritual).
- **[DESIGNER CONFIRMED]** 5 Curse Cards (Antsy Pants was missing from the document —
  see Curse list). The "add one random curse per reshuffle" rule stops when all 5
  are in.
- Shared deck + shared discard pile per RULES.md.

## Timing framework

- **Sudden Magic**: playable any time a play-window is open — during any player's
  turn, and during fight Respond steps, and in response to another card being played.
- **Ritual Magic**: only during your own turn (any phase, when you hold priority and
  no fight is unresolved — except cards that explicitly affect fights).
- **[IMPL]** When any Whimsy card is played, before it resolves, every other player
  (in turn order) gets a response window to play Sudden Magic (this is how Nope-Gnome
  works). Cards resolve LIFO (last played resolves first).

## Sudden Magic (10 cards)

1. **Hidden Passage** — Move a gnome you control 1 space diagonally.
   [IMPL]: free move (doesn't consume the gnome's movement action); arriving counts
   as Entry (triggers fights/entry effects); maize exit cost still applies.
2. **Snake Eyes** — Target player subtracts 2 from their next dice roll.
   [IMPL]: applies to that player's next d6 of any kind; modifiers stack; result
   floors at 0 for comparison purposes.
3. **Slippery Trail** — Move a gnome you control 2 spaces in a straight line.
   [IMPL]: orthogonal straight line; free move; both spaces traversed — the
   intermediate space is exited/entered (maize costs, fights on the final space only;
   if the intermediate space contains an enemy or blocks entry, the move can't pass
   through it).
4. **4 Leaf Clover** — Add 3 to your next dice roll. [IMPL]: same stacking rules as
   Snake Eyes.
5. **Gust Of Wind** — Move any gnome 1 space (orthogonal). [IMPL]: free move, Entry
   triggers apply; you may move enemy gnomes.
6. **Gnomebody Dies** — If a gnome would be destroyed this turn, it isn't.
   [IMPL]: prevention shield — the next gnome destruction this turn (any owner) is
   prevented. One prevention per card.
7. **Nope-Gnome** — Cancel the effects of a Whimsy card as it is played.
   [IMPL]: playable only in the response window to another card; the cancelled card
   still goes to discard.
8. **Gnome Birthday Party** — Gain 2 Wishes (wish cap applies; excess lost).
9. **Gnome Place Like Home** — Target gnome goes back to their Home Garden.
   [IMPL]: teleport to owner's Home Garden space; illegal target if owner has no
   Home Garden. Arrival is NOT an Entry trigger onto enemies (it's their own home) —
   but any enemies standing there will cause a fight as normal co-location.
10. **Rocket Propelled Gnome** — Target gnome is destroyed.

## Ritual Magic (13 cards)

1. **Wild Growth** — Plant any garden on any empty space. [IMPL]: free (no wish
   cost), no gnome required; normal supply limits; "empty" = no garden, no critters.
2. **Instigation** — 2 target gnomes fight. [IMPL]: any two gnomes with different
   owners, anywhere on the board; they fight per the 3 R's without moving; the first-
   chosen target is the "attacker" for tie-break curse purposes.
3. **Lawnmower Of Doom** — Destroy a garden adjacent (orthogonal) to a gnome you
   control. **[DESIGNER CONFIRMED]**: Home Gardens can NOT be destroyed by this card.
4. **Plot Twist** — Swap the contents of two adjacent spaces (gardens AND critters
   swap together). [IMPL]: no Entry triggers; fights trigger if the swap creates
   co-located enemies.
5. **Great Wall Of Whimsy** — Until your next turn, units cannot enter target
   non-Home Garden.
6. **Sundown Sabotage** — Target garden skips its next harvest.
7. **Ritual Magic** (card name) — Steal a random Whimsy card from target player's
   hand (hand limit applies).
8. **Seeing Double** — Clone target gnome. [IMPL]: any gnome; the clone belongs to
   the target's owner, spawns on the same space, subject to that owner's board/reserve
   limits (fizzles if at limit); clone may move normally this turn if it's its owner's
   turn.
9. **Gnomio & Juliet** — Marry 2 gnomes; when a married gnome dies, its partner is
   destroyed as well. [IMPL]: any 2 gnomes, any owners; partner destruction is not a
   fight loss (no chain of fight effects) but IS a destruction (Gnomebody Dies can
   prevent it; marriage chains can cascade).
10. **Another Gnomes Treasure** — Choose a Whimsy card from the discard pile, put it
    into your hand (hand limit applies).
11. **Mushroom Cloud** — Target non-Home garden and all gnomes on its space are
    destroyed.
12. **Pocket Shovel** — Plant two Tunnel Gardens on any two empty spaces (free;
    supply limits apply; if only 1 tunnel left in supply, plant 1).
13. **Lost In The Maize** — Gnomes can't leave Maize Gardens until your next turn
    (even by paying, sliding, tunneling, or card effects).

## Curse Cards (5)

1. **Compost Combustion** — Gardens now cost 2 Wishes to plant.
2. **Snailmaggedon** — Snails can now move during every Harvest Phase.
   [IMPL]: during ANY player's Harvest Phase, each snail owner may move their snail
   1 space (in turn order), in addition to normal snail turns.
3. **Magic Drain** — If you start your turn at 0 Wishes, sacrifice a gnome.
   [IMPL]: checked at turn start before Harvest; owner chooses which gnome; if no
   gnomes on board, nothing happens (reserves untouched).
4. **Mulch Fever** — If a fight would end in a tie, the attacking gnome wins.
   [IMPL]: "attacker" = the critter whose movement/effect initiated the fight
   (flytrap is the attacker on its harvest-attack; the entering unit is the attacker
   on entry). Replaces the reroll-ties rule.
5. **Antsy Pants** — Every gnome must move each turn, if able. **[DESIGNER PROVIDED
   — was missing from the card document]**
   [IMPL]: during each player's Action Phase, that player cannot pass their turn
   while any of their gnomes still has an unused movement action AND at least one
   legal move (a gnome with no legal destination — e.g. trapped in a maize garden it
   can't pay to exit, or walled in — is exempt). Free moves from cards/gardens don't
   satisfy the requirement; the gnome's own movement action must be spent.

## Card drawing (reminder from RULES.md)

Curse cards are drawn face-up, resolve immediately, permanent, then removed from
the deck (not discarded into the reshuffle pool).
