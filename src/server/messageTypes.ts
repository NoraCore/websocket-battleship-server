export type UUID = string;


/* ----------------------------- Types ----------------------------- */

type Envelope = { type: string; data: string; id: 0 };

type RegReq = { name: string; password: string };
type RegRes = { name: string | null; index: string | null; error: boolean; errorText: string };

type RoomListItem = { roomId: string; roomUsers: { name: string; index: string }[] };

type ClientShip = {
  position: { x: number; y: number };
  direction: boolean; // true = vertical (y increases)
  length: number;
  type: "small" | "medium" | "large" | "huge";
};

type AddShipsReq = { gameId: string; ships: ClientShip[]; indexPlayer: string };
type AttackReq = { gameId: string; x: number; y: number; indexPlayer: string };
type RandomAttackReq = { gameId: string; indexPlayer: string };

export type {
  Envelope,
  RegReq,
  RegRes,
  RoomListItem,
  ClientShip,
  AddShipsReq,
  AttackReq,
  RandomAttackReq,
}