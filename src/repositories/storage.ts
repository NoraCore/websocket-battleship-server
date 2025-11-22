import type {PlayerRecord, RoomRecord} from "../models/models.js";
import {newId} from "../utils/utils.js";

export const rooms = new Map<string, RoomRecord>();
export const playersById = new Map<string, PlayerRecord>();
export const playersByLogin = new Map<string, string>(); // login -> id

export function registerPlayer(name: string, password: string) {
  if (playersByLogin.has(name)) throw new Error("Login exists");
  const id = newId();
  const rec: PlayerRecord = { id, name: name, password, ws: null, wins: 0 };
  playersById.set(id, rec);
  playersByLogin.set(name, id);
  return rec;
}

export function findPlayerByLogin(name: string): PlayerRecord | null {
  const id = playersByLogin.get(name);
  if (!id) return null;
  return playersById.get(id) ?? null;
}

export function loginPlayer(name: string, password: string) {
  const rec = findPlayerByLogin(name);
  if (!rec) throw new Error("No such user");
  if (rec.password !== password) throw new Error("Invalid password");
  return rec;
}