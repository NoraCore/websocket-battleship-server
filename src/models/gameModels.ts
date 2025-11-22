import type {ClientShip} from "../server/messageTypes.js";
import type {RoomRecord} from "./models.js";


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

export function getGameByRoomId(roomId: string): Game | undefined {
  return games.get(roomId);
}

export function buildGameForRoom(room: RoomRecord): Game {
  const id = room.id;
  const game: Game = {
    id,
    players: [],
    ships: { "0": [], "1": [] },
    occupied: { "0": new Map(), "1": new Map() },
    tried: { "0": new Set(), "1": new Set() },
    currentPlayerIndex: "0"
  };
  // assign session indices in order players array
  for (let i = 0; i < room.players.length; i++) {
    const serverId = room.players[i];
    const sessionIndex = String(i);
    game.players.push({ serverId, sessionIndex });
  }
  games.set(id, game);
  return game;
}

/* helper: map server player id -> sessionIndex in a game */
export function serverIdToSessionIndex(game: Game, serverId: string): string | undefined {
  const p = game.players.find(x => x.serverId === serverId);
  return p?.sessionIndex;
}