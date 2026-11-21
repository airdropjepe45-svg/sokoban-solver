[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/airdropjepe45-svg/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/airdropjepe45-svg/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban solver

A push-optimal Sokoban solver for the make.fun bounty
`sokoban-solver-01-run-20261121`. It reads each level from
`MAKEFUN_INPUT_DIR/<id>/level.txt` (XSB) and writes the player's moves to
`MAKEFUN_OUTPUT_DIR/<id>/solution.txt`.

## How it works

Every level this generator draws is a one-square-wide hallway with one to
four rooms off it, each room holding three or four boxes and as many goals.
A box pushed out of a room can never come back, so a level's push optimum is
the sum of its rooms' optima — and a search over the whole level would meet
the product of the rooms' positions. The solver therefore:

1. Finds the hallway (the player's row) and each room's door, the single open
   square of the row beside the hallway, then flood-fills each room from its
   door without crossing the hallway. A box may start on a door square; the
   room's floor includes it, and the hallway square outside the door is where
   the player enters from.
2. Solves each room push-optimally with A* over pushes: a state is the boxes
   plus the player's reachable region (named by its lowest square), one step
   is one push, and the player walks to the pushing square for free. The
   heuristic is the cheapest assignment of boxes to goals by walking distance
   (brute-forced over the at most 24 permutations), which never overestimates
   the pushes left. Dead positions are pruned with live squares (a box that
   cannot be pulled back onto any goal is dead) and frozen 2×2 blocks.
3. Accepts a room only when every box is on a goal and the player can still
   reach the door, so the player is never shut in after finishing a room.
4. Stitches the rooms together with walks through the hallway and replays the
   whole move string on the level before answering, so an answer is only ever
   written when it has been verified to solve the level.

If a room's optimal search exhausts its fixed expansion budget, the solver
falls back to greedy best-first search and then to breadth-first search over
pushes for that room, so a solved-but-not-optimal room still scores instead
of an empty answer. If a level ever fails to split into rooms, the same push
search runs over the whole level instead. Budgets are counts of node
expansions, never wall-clock time, and there is no randomness, so two runs on
one set write byte-identical answers. Node 22, standard library only, no
network.

## Results

On the kit's practice set, scored with the kit's own scorer, every instance
is solved in exactly its push-optimal count, for a perfect score of
1,000,000 — in about 0.3 s for the whole set (the limit is 60 s):

| instance | boxes | rooms | pushes | P\* | points |
|----------|------:|------:|-------:|----:|-------:|
| i001 | 3 | 1 | 13 | 13 | 1000 |
| i002 | 4 | 1 | 16 | 16 | 1000 |
| i003 | 8 | 2 | 29 | 29 | 1000 |
| i004 | 12 | 3 | 47 | 47 | 1000 |
| i005 | 16 | 4 | 60 | 60 | 1000 |

The same entry was also run on three freshly drawn sets from the same
generator (different seeds, unseen levels) and scored 1,000,000 on each,
every instance at its P\* — so the result is the decomposition and the
search, not luck on one set. Two runs on the practice set produce
byte-identical outputs.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Score the answers with the kit's scorer:

```sh
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=practice/reference MAKEFUN_SCORES_DIR=scores node program/scorer/score.ts
```

## License

MIT — see [LICENSE](LICENSE).

---

Built for the make.fun bounty — [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121?ref=89fdt4kt).
