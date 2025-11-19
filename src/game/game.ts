import type {ClientShip} from "../server/messageTypes.js";
import {type Coord, coordKey, type Game, games} from "../models/gameModels.js";

export const BOARD_SIZE = 10; // 0..9

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
