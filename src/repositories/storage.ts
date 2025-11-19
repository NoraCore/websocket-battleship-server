import type {PlayerRecord, RoomRecord} from "../models/models.js";

export const rooms = new Map<string, RoomRecord>();
export const playersById = new Map<string, PlayerRecord>();
export const playersByLogin = new Map<string, string>(); // login -> id
