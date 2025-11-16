import { newId } from "../server/serverUtils.js";

export type PlayerRecord = {
  id: string;
  login: string;
  password: string;
  ws?: any;
  score?: number;
};

export type RoomRecord = {
  id: string;
  players: string[]; // player ids
  state: "waiting" | "placing" | "playing" | "finished";
  game?: any; // use Room class to populate runtime game
};

export const players = new Map<string, PlayerRecord>();
export const playersByLogin = new Map<string, string>();
export const rooms = new Map<string, RoomRecord>();

export const createPlayer = (login: string, password: string) => {
  const id = newId();
  const p: PlayerRecord = { id, login, password, score: 0 };
  players.set(id, p);
  playersByLogin.set(login, id);
  return p;
};

export const findPlayerByLogin = (login: string) => {
  const id = playersByLogin.get(login);
  if (!id) return null;
  return players.get(id) || null;
};