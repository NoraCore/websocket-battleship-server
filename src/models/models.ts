import {WebSocket} from "ws";

export type PlayerRecord = {
  id: string; // global server id (uuid)
  name: string;
  password: string;
  ws?: WebSocket | null;
  wins: number;
};

export type RoomRecord = {
  id: string;
  players: string[]; // server player ids in room (max 2)
  state: "waiting" | "placing" | "playing" | "finished";
};

