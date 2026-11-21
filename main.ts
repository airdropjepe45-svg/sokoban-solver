// Sokoban solver: hallway + rooms decomposition, push-optimal A* per room.
//
// Every level this generator draws is a 1-wide hallway with 1-4 rooms off it,
// each room holding 3-4 boxes and as many goals, so a level's push optimum is
// the sum of its rooms' optima. This program finds the rooms, solves each one
// push-optimally with A* over pushes (an admissible minimum-assignment
// heuristic, live-square and frozen 2x2 deadlock pruning), and stitches the
// room solutions together with walks through the hallway.
//
// Deterministic by construction: every budget is a fixed count of node
// expansions, never wall-clock time. No randomness, no Date, no clock, no
// environment reads beyond the input/output directories, so two runs on one
// set write byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (node expansions) per search. Never time-based.
const ASTAR_CAP = 150_000;
const GREEDY_CAP = 150_000;
const BFS_CAP = 250_000;
const GLOBAL_CAP = 300_000;

type Dir = { dx: number; dy: number; walk: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

/** Parse XSB text. Short rows pad with walls, as the checker does. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares the player reaches from `from` around walls and `occupied`
 * boxes, marked in `seen` with `stamp` (a scratch array the caller owns).
 * Returns the lowest square of the region, which names the region.
 */
function regionLow(
  w: number, wall: Uint8Array, occupied: Uint8Array, from: number,
  seen: Int32Array, stamp: number, stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k].dy * w + DIRS[k].dx;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || seen[q] === stamp) continue;
      seen[q] = stamp;
      stack[n++] = q;
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower LURD, or null. */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k].dy * w + DIRS[k].dx;
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k].walk;
      if (q === to) {
        let s = '';
        for (let c = to; c !== from; c = prev[c]) s = how[c] + s;
        return s;
      }
      queue.push(q);
    }
  }
  return null;
}

/**
 * Live squares: a square from which a box alone can be pulled back onto some
 * goal. A box off a live square can never reach a goal, so it is dead.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k].dy * w + DIRS[k].dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and
 * boxes holding a box off its goal. Every box in such a block can never be
 * pushed at all: two of its push directions end inside the block, and the
 * other two need the player to stand inside the block.
 */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** All-pairs walking distances over the floor, BFS from each floor square. */
function distTable(w: number, wall: Uint8Array, floor: number[]): Int32Array {
  const size = wall.length;
  const D = new Int32Array(size * size).fill(-1);
  const dist = new Int32Array(size);
  for (const s of floor) {
    dist.fill(-1);
    const queue = [s];
    dist[s] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k].dy * w + DIRS[k].dx;
        if (q < 0 || q >= size || wall[q] || dist[q] >= 0) continue;
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
    for (const t of floor) D[s * size + t] = dist[t];
  }
  return D;
}

/**
 * Admissible push heuristic: the cheapest assignment of boxes to goals by
 * walking distance (brute-force permutations, at most 4-5 boxes), or, for
 * larger sets, the sum of each box's nearest-goal distance. One push moves
 * one box one square, so no solution needs fewer pushes than this.
 */
function makeHeuristic(D: Int32Array, size: number, goals: number[]): (boxes: number[]) => number {
  const n = goals.length;
  if (n <= 5) {
    const perms: number[][] = [];
    const gen = (arr: number[], k: number): void => {
      if (k === 1) {
        perms.push(arr.slice());
        return;
      }
      for (let i = 0; i < k; i++) {
        gen(arr, k - 1);
        const j = k % 2 === 1 ? 0 : i;
        const t = arr[j];
        arr[j] = arr[k - 1];
        arr[k - 1] = t;
      }
    };
    gen(goals.map((_, i) => i), n);
    return (boxes: number[]): number => {
      let best = Infinity;
      for (const perm of perms) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = D[boxes[i] * size + goals[perm[i]]];
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    };
  }
  return (boxes: number[]): number => {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const g of goals) {
        const d = D[b * size + g];
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  };
}

type SearchResult = { pushes: number; moves: string; endPlayer: number } | null;

/**
 * Push search over a board whose floor is exactly the non-wall squares.
 * A state is the boxes (sorted) plus the player's reachable region (named by
 * its lowest square); one step is one push, the player walking to the pushing
 * square for free. `boxOk` marks the squares a box may ever occupy (a room's
 * squares, so a box can never leave its room); `exit` is a square the player
 * must still reach once the boxes are home (-1: no such demand).
 * mode: 'astar' (optimal), 'greedy' (best-first on the heuristic), 'bfs'
 * (breadth-first over pushes). `cap` bounds node expansions, never time.
 */
function solvePush(
  w: number, wall: Uint8Array, goals: number[], boxes0: number[], player0: number,
  boxOk: Uint8Array, exit: number, mode: 'astar' | 'greedy' | 'bfs', cap: number,
): SearchResult {
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  for (const b of boxes0) if (!live[b]) return null;
  const floor: number[] = [];
  for (let i = 0; i < size; i++) if (!wall[i]) floor.push(i);
  const D = distTable(w, wall, floor);
  const h = makeHeuristic(D, size, goals);
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  const occupied = new Uint8Array(size);
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const keyOf = (bs: number[], low: number): string => String.fromCharCode(low, ...bs);

  // The states: boxes, the player's square after the push that made the
  // state, parent, the push itself (box cell, direction), pushes so far,
  // and the region's lowest square.
  const sBoxes: number[][] = [boxes0.slice()];
  const sPlayer: number[] = [player0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const sLow: number[] = [];
  for (const b of boxes0) occupied[b] = 1;
  sLow.push(regionLow(w, wall, occupied, player0, seenB, ++stamp, stack));
  for (const b of boxes0) occupied[b] = 0;

  const closed = new Map<string, number>();
  closed.set(keyOf(boxes0, sLow[0]), 0);

  // Binary heap of [priority0, priority1, insertion order, state id].
  const heap: number[][] = [];
  const heapLess = (a: number[], b: number[]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: number[]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  const prio = (g: number, hv: number): [number, number] =>
    mode === 'astar' ? [g + hv, hv] : mode === 'greedy' ? [hv, -g] : [g, 0];
  let seq = 0;
  const h0 = h(boxes0);
  if (h0 === Infinity) return null;
  {
    const [p0, p1] = prio(0, h0);
    heapPush([p0, p1, seq++, 0]);
  }

  const reconstruct = (s: number): SearchResult => {
    const path: number[] = [];
    for (let t = s; t > 0; t = sParent[t]) path.push(t);
    path.reverse();
    let moves = '';
    let player = player0;
    let boxes = boxes0.slice();
    for (const t of path) {
      const from = sFrom[t];
      const dir = sDir[t];
      const d = DIRS[dir].dy * w + DIRS[dir].dx;
      for (const b of boxes) occupied[b] = 1;
      const walk = walkTo(w, wall, occupied, player, from - d);
      for (const b of boxes) occupied[b] = 0;
      if (walk === null) return null;
      moves += walk + DIRS[dir].push;
      player = from;
      const idx = boxes.indexOf(from);
      boxes[idx] = from + d;
      boxes.sort((a, b) => a - b);
    }
    return { pushes: path.length, moves, endPlayer: player };
  };

  let expanded = 0;
  while (heap.length > 0) {
    const top = heapPop();
    const s = top[3];
    const bs = sBoxes[s];
    if (closed.get(keyOf(bs, sLow[s])) !== sG[s]) continue; // superseded
    if (solved(bs)) {
      let ok = true;
      if (exit >= 0) {
        for (const b of bs) occupied[b] = 1;
        const st = ++stamp;
        regionLow(w, wall, occupied, sPlayer[s], seenB, st, stack);
        ok = seenB[exit] === st;
        for (const b of bs) occupied[b] = 0;
      }
      if (ok) return reconstruct(s);
      // Boxes home but the player is shut in: keep searching past it.
    }
    if (expanded >= cap) return null;
    expanded++;
    const g = sG[s];
    for (const b of bs) occupied[b] = 1;
    const st = ++stamp;
    regionLow(w, wall, occupied, sPlayer[s], seenA, st, stack);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k].dy * w + DIRS[k].dx;
        const t = b + d;
        if (wall[t] || occupied[t] || !boxOk[t] || !live[t]) continue;
        if (seenA[b - d] !== st) continue; // player cannot reach the push square
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let nkey = '';
        let nlow = -1;
        let nb: number[] = [];
        if (!frozen) {
          nb = bs.slice();
          nb[bi] = t;
          nb.sort((a, b2) => a - b2);
          const st2 = ++stamp;
          nlow = regionLow(w, wall, occupied, b, seenB, st2, stack);
          nkey = keyOf(nb, nlow);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const ng = g + 1;
        const prev = closed.get(nkey);
        if (prev !== undefined && prev <= ng) continue;
        const hv = h(nb);
        if (hv === Infinity) continue;
        closed.set(nkey, ng);
        const id = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sDir.push(k);
        sG.push(ng);
        sLow.push(nlow);
        const [p0, p1] = prio(ng, hv);
        heapPush([p0, p1, seq++, id]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  return null;
}

type Room = { cells: number[]; door: number; entry: number; boxes: number[]; goals: number[] };

/**
 * The level's rooms: the hallway is the player's row; each room opens onto
 * it through one door, the single open square of the row beside the hallway
 * in that room's columns. A room is the floor reachable from its door without
 * crossing the hallway. Null when the split does not account for every box
 * and goal exactly once.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const hallRow = Math.floor(player / w);
  const doors: number[] = [];
  for (const r of [hallRow - 1, hallRow + 1]) {
    if (r < 0 || r >= h) continue;
    for (let x = 0; x < w; x++) {
      const i = r * w + x;
      if (!wall[i]) doors.push(i);
    }
  }
  const rooms: Room[] = [];
  const seenBox = new Uint8Array(wall.length);
  const seenGoal = new Uint8Array(wall.length);
  for (const door of doors) {
    const entry = door + (Math.floor(door / w) < hallRow ? w : -w);
    const cells = [door];
    const seen = new Uint8Array(wall.length);
    seen[door] = 1;
    for (let i = 0; i < cells.length; i++) {
      const p = cells[i];
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k].dy * w + DIRS[k].dx;
        if (q < 0 || q >= wall.length || wall[q] || seen[q]) continue;
        if (Math.floor(q / w) === hallRow) continue;
        seen[q] = 1;
        cells.push(q);
      }
    }
    cells.sort((a, b) => a - b);
    const inRoom = new Uint8Array(wall.length);
    for (const c of cells) inRoom[c] = 1;
    const rBoxes = boxes.filter((b) => inRoom[b]);
    const rGoals = goals.filter((g) => inRoom[g]);
    if (rBoxes.length === 0 || rBoxes.length !== rGoals.length) return null;
    for (const b of rBoxes) seenBox[b] = 1;
    for (const g of rGoals) seenGoal[g] = 1;
    rooms.push({ cells, door, entry, boxes: rBoxes, goals: rGoals });
  }
  if (rooms.length === 0) return null;
  if (!boxes.every((b) => seenBox[b]) || !goals.every((g) => seenGoal[g])) return null;
  return rooms;
}

/** Solve one room push-optimally, falling back to greedier searches. */
function solveRoom(level: Level, room: Room): SearchResult {
  const size = level.wall.length;
  const wall = new Uint8Array(size).fill(1);
  for (const c of room.cells) wall[c] = 0;
  wall[room.entry] = 0;
  const boxOk = new Uint8Array(size);
  for (const c of room.cells) boxOk[c] = 1;
  return (
    solvePush(level.w, wall, room.goals, room.boxes, room.entry, boxOk, room.entry, 'astar', ASTAR_CAP) ??
    solvePush(level.w, wall, room.goals, room.boxes, room.entry, boxOk, room.entry, 'greedy', GREEDY_CAP) ??
    solvePush(level.w, wall, room.goals, room.boxes, room.entry, boxOk, room.entry, 'bfs', BFS_CAP)
  );
}

/** Replay `moves` on the level: true only when every box ends on a goal. */
function verify(level: Level, moves: string): boolean {
  const boxAt = new Uint8Array(level.wall.length);
  for (const b of level.boxes) boxAt[b] = 1;
  let player = level.player;
  for (const ch of moves) {
    const dir = DIRS.find((d) => d.walk === ch.toLowerCase());
    if (dir === undefined) return false;
    const d = dir.dy * level.w + dir.dx;
    const next = player + d;
    if (next < 0 || next >= level.wall.length || level.wall[next]) return false;
    if (boxAt[next]) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= level.wall.length || level.wall[beyond] || boxAt[beyond]) return false;
      boxAt[next] = 0;
      boxAt[beyond] = 1;
    }
    player = next;
  }
  return level.goals.every((g) => boxAt[g]);
}

/** Solve a level room by room, stitching walks and room solutions together. */
function solveByRooms(level: Level, rooms: Room[]): string | null {
  const boxAt = new Uint8Array(level.wall.length);
  for (const b of level.boxes) boxAt[b] = 1;
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const walk = walkTo(level.w, level.wall, boxAt, player, room.entry);
    if (walk === null) return null;
    moves += walk;
    player = room.entry;
    const res = solveRoom(level, room);
    if (res === null) return null;
    moves += res.moves;
    player = res.endPlayer;
    for (const b of room.boxes) boxAt[b] = 0;
    for (const g of room.goals) boxAt[g] = 1;
  }
  if (!verify(level, moves)) return null;
  return moves;
}

/** Whole-level push search, used only when the level is no set of rooms. */
function solveGlobal(level: Level): string | null {
  const size = level.wall.length;
  const boxOk = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (!level.wall[i]) boxOk[i] = 1;
  const res =
    solvePush(level.w, level.wall, level.goals, level.boxes, level.player, boxOk, -1, 'astar', GLOBAL_CAP) ??
    solvePush(level.w, level.wall, level.goals, level.boxes, level.player, boxOk, -1, 'greedy', GLOBAL_CAP) ??
    solvePush(level.w, level.wall, level.goals, level.boxes, level.player, boxOk, -1, 'bfs', GLOBAL_CAP);
  if (res === null || !verify(level, res.moves)) return null;
  return res.moves;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    const byRooms = solveByRooms(level, rooms);
    if (byRooms !== null) return byRooms;
  }
  return solveGlobal(level) ?? '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
