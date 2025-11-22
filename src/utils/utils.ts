import { randomUUID } from 'node:crypto';
import {type WebSocket, WebSocketServer} from "ws";
import type {Message} from "../server/messageTypes.js";


export const newId = () =>  randomUUID();
export const log = (...args: any[]) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
};

export function send(ws: WebSocket, type: string, payload: any) {
  const env: Message = { type, data: JSON.stringify(payload), id: 0 };
  try {
    ws.send(JSON.stringify(env));
  } catch (e) {
    console.error("send error", e);
  }
}

export function broadcastAll(type: string, payload: any, wss: WebSocketServer) {
  const raw = JSON.stringify({ type, data: JSON.stringify(payload), id: 0 });
  for (const c of wss.clients) {
    try { c.send(raw); } catch {}
  }
}

export function broadcastToSockets(sockets: WebSocket[], type: string, payload: any) {
  const raw = JSON.stringify({ type, data: JSON.stringify(payload), id: 0 });
  for (const s of sockets) {
    try { s.send(raw); } catch {}
  }
}