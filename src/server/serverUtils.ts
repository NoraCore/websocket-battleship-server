import { WebSocket } from "ws";
import crypto from "node:crypto";
import type { ServerMessage } from "./types.js";

export const sendJson = (ws: WebSocket, msg: ServerMessage) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    console.error("sendJson failed", e);
  }
};

export const broadcast = (sockets: Set<WebSocket>, msg: ServerMessage) => {
  const raw = JSON.stringify(msg);
  for (const s of sockets) {
    try { s.send(raw); } catch {}
  }
};

export const newId = () => crypto.randomUUID();