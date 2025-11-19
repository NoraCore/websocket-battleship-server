import type {ClientShip} from "../server/messageTypes.js";
import {type Coord, coordKey, type Game, games} from "../models/gameModels.js";

export const BOARD_SIZE = 10;

export function expandClientShip(s: ClientShip): Coord[] {
  const coords: Coord[] = [];
  const sx = Math.trunc(s.position.x);
  const sy = Math.trunc(s.position.y);
  const len = Math.trunc(s.length);
  for (let i = 0; i < len; i++) {
    const x = s.direction ? sx: sx + i ;
    const y = s.direction ? sy + i : sy;
    coords.push({ x, y });
  }
  return coords;
}

export function validateShipsPlacement(ships: ClientShip[]) {
  // check bounds, integer coords, no overlap, reasonable total cells
  const occupied = new Set<string>();
  for (const s of ships) {
    if (!s || typeof s.length !== "number" || !s.position) {
      throw new Error("Invalid ship format");
    }
    const coords = expandClientShip(s);
    if (coords.length !== s.length) {
      throw new Error("Invalid length expansion");
    }
    for (const c of coords) {
      if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) {
        throw new Error("Coordinates must be integers");
      }
      if (c.x < 0 || c.x >= BOARD_SIZE || c.y < 0 || c.y >= BOARD_SIZE) {
        throw new Error(`Ship out of bounds: ${c} in ${ships}`);
      }
      const key = coordKey(c);
      if (occupied.has(key)) throw new Error("Ships overlap");
      occupied.add(key);
    }
  }
  return true;
}

/* ----------------------- Attack logic ---------------------------- */

/**
 * checkAttack(game, attackerSessionIndex, x,y)
 * returns array of attack result messages to broadcast to both players.
 * It will mutate game ships/occupied accordingly.
 *
 * Result message shape per spec:
 * {
 *   type: "attack",
 *   data: { position: {x,y}, currentPlayer: <indexPlayer>, status: "miss"|"killed"|"shot" }
 * }
 */
export function handleAttack(game: Game, attackerIndex: string, x: number, y: number) {
  const opponentIndex = attackerIndex === "0" ? "1" : "0";
  const posKey = `${x},${y}`;

  if (game.tried[attackerIndex].has(posKey)) {
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "repeat" }];
  }

  game.tried[attackerIndex].add(posKey);

  const shipMap = game.occupied[opponentIndex];
  const ship = shipMap.get(posKey);

  if (!ship) {
    game.currentPlayerIndex = opponentIndex;
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "miss" }];
  }

  // ---- HIT ----
  const idx = ship.cells.findIndex(c => c.x === x && c.y === y);
  if (idx === -1) {
    game.currentPlayerIndex = opponentIndex;
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "miss" }];
  }

  ship.cells.splice(idx, 1);
  shipMap.delete(posKey);

  if (ship.cells.length > 0) {
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "shot" }];
  }

  // ---- KILLED ----
  // ship is fully destroyed now

  // 1) Collect ALL killed cells of this ship
  const killedCells = ship.originalCells.map(c => ({
    position: c,
    currentPlayer: attackerIndex,
    status: "killed" as const
  }));

  // 2) Generate surrounding misses, but skip the ship's own cells
  const surroundMsgs: { position: Coord; currentPlayer: string; status: "miss" }[] = [];
  const shipCellKeys = new Set(ship.originalCells.map(c => `${c.x},${c.y}`));
  const visited = new Set<string>();

  for (const oc of ship.originalCells) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cx = oc.x + dx;
        const cy = oc.y + dy;

        if (cx < 0 || cy < 0 || cx >= BOARD_SIZE || cy >= BOARD_SIZE) continue;

        const key = `${cx},${cy}`;
        if (visited.has(key)) continue;
        visited.add(key);

        // Skip actual ship cells — fixing BUG #1
        if (shipCellKeys.has(key)) {
          continue;
        }

        // Skip cells that are occupied by alive ships
        if (shipMap.has(key)) {
          continue;
        }

        surroundMsgs.push({
          position: { x: cx, y: cy },
          currentPlayer: attackerIndex,
          status: "miss"
        });

        game.tried[attackerIndex].add(key);
      }
    }
  }

  // ---- WIN CHECK ----
  const opponentRemaining = shipMap.size;

  if (opponentRemaining === 0) {
    return [
      ...killedCells,
      ...surroundMsgs
    ];
  }

  // attacker keeps turn
  return [
    ...killedCells,
    ...surroundMsgs
  ];
}
