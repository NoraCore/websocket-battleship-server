import type {ClientShip} from "../server/messageTypes.js";


export type Coord = { x: number; y: number };
export function coordKey(c: Coord) { return `${c.x},${c.y}`; }

export type ServerShip = {
  id: string;
  type: ClientShip["type"];
  cells: Coord[]; // remaining cells (we will remove coords when hit)
  originalCells: Coord[]; // full set for reporting start_game
};

export type Game = {
  id: string; // same as room id for simplicity
  players: { serverId: string; sessionIndex: string }[]; // sessionIndex "0"|"1"
  ships: Record<string, ServerShip[]>; // sessionIndex -> ships
  occupied: Record<string, Map<string, ServerShip>>; // sessionIndex -> map coordKey->ship (occupied by that player's ships)
  tried: Record<string, Set<string>>; // sessionIndex -> coords that were targeted (string keys)
  currentPlayerIndex: string; // "0" or "1" (sessionIndex who should shoot)
};


export const games = new Map<string, Game>(); // roomId -> game