import { WebSocketServer, WebSocket } from 'ws';
import {newId, sendJson} from "./serverUtils.js";
import {Room} from "../game/game.js";
import {login, register} from "../game/playerLogic.js";
import {findPlayerByLogin, players, type RoomRecord, rooms} from "../models/models.js";

const roomsRuntime = new Map(); // roomId -> Room instance
export class WsServer {
  wss: WebSocketServer;
  port: number;
  host: string;

  constructor(port: number, host: string) {
    this.port = port;
    this.host = host;
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    console.log(`WebSocket server started on ws://${this.host}:${this.port}`);
  }

  onConnection(ws: WebSocket, req: any) {
    console.log("new connection");

    // attach temporary context
    (ws as any).context = { playerId: null };
    ws.on("message", (data) => {
      const raw = data.toString();
      console.log("RECV RAW:", raw);
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        // sendJson(ws, {
        //   type: "error",
        //   data:{ msg:"Invalid JSON" },
        //   id: 0
        // });
        console.log("RESULT: Invalid JSON");
        return;
      }
      this.handleMessage(ws, msg);
    });

    ws.on("close", () => {
      const pid = (ws as any).context.playerId;
      if (pid) {
        for (const r of roomsRuntime.values()) {
          if (r.sockets.has(pid)) r.removePlayer(pid);
        }
      }
    });
  }

  private handleMessage(ws: WebSocket, msg: any) {
    const { type, data, id} = msg;
    console.log("COMMAND:", { type, data, id });
    let payload = JSON.parse(data);
    switch (type) {
      /* -------------------- Player registration/login -------------------- */
      case "reg":
        const { name, password } = payload || {};
        const p = register(name, password);

        if (!name || !password) {
          sendJson(ws, {
            type: "reg",
            data: {
              name: name ?? null,
              index: null,
              error: true,
              errorText: "Missing name or password"
          },
            id: 0
        });

          console.log("RESULT: reg failed - missing creds");
          return;
        }

        const existing = findPlayerByLogin(name);
        let playerRec;
        if (existing) {
          // login path
          try {
            playerRec = login(name, password); // throws on bad password
            (ws as any).context.playerId = playerRec.id;
            playerRec.ws = ws;
            sendJson(ws,
              {
                type: "reg",
                data: { name, index: playerRec.id, error: false, errorText: "" },
                id: 0
              }
            );
            console.log("RESULT: logged in", playerRec.id);
            return;
          } catch (e) {
            sendJson(ws, {
              type: "reg",
              data: { name: name,
                index: null,
                error: true,
                errorText: e.message || "Login failed"},
              id: 0
            }
            );
            console.log("RESULT: login error", e.message);
            return;
          }
        }
        try {
          playerRec = register(name, password); // may throw if duplicate
          (ws as any).context.playerId = playerRec.id;
          playerRec.ws = ws;
          const dt = { type: "reg", data: {
            name: name,
              index: playerRec.id,
              error: false,
              errorText: "" }, id: 0
          };
          sendJson(ws, dt);
          console.log("RESULT: registered", playerRec.id);
          return;
        } catch (e: any) {
          sendJson(ws, {
            type: "reg", data: {
              name: name,
              index: null,
              error: true,
              errorText: e.message || "Register failed" }, id: 0
          });
          console.log("RESULT: register error", e.message);
          return;
        }
      /* -------------------- Create room -------------------- */
      case "create_room": {
        const pid = (ws as any).context.playerId;
        if (!pid) throw new Error("Not authenticated");
        const roomId = newId();
        const rec = { id: roomId, players: [pid], state: "waiting" } as RoomRecord;
        rooms.set(roomId, rec);
        const r = new Room(rec);
        r.addPlayer(pid, ws);
        roomsRuntime.set(roomId, r);

        // Respond to creator with create_game (as spec says "create_game" will be sent for both players after they connect;
        // here for the creating player we send create_game immediately with its idPlayer)
        sendJson(ws,  {
          type: "create_room",
          data: "",
          id: 0
        });
        console.log("RESULT: room created", roomId);
        // Also broadcast updated rooms list to all connected clients (update_room).
        this.broadcastRoomsList();
        return;
      }

      /* -------------------- Add user to room (join) -------------------- */
      case "add_user_to_room": {
        // payload: { indexRoom: roomId }
        const pid = (ws as any).context.playerId;
        if (!pid) throw new Error("Not authenticated");
        const roomId = payload?.indexRoom;
        if (!roomId) throw new Error("Missing indexRoom");
        const rec = rooms.get(roomId);
        if (!rec) throw new Error("Room not found");
        let r = roomsRuntime.get(roomId);
        if (!r) {
          r = new Room(rec);
          roomsRuntime.set(roomId, r);
        }
        r.addPlayer(pid, ws);

        // If room has 2 players now — send create_game to both with per-player idPlayer (use server player ids)
        if (rec.players.length === 2) {
          // send create_game to each player in room
          for (const playerId of rec.players) {
            const playerWs = (players.get(playerId) as any)?.ws ?? r.sockets.get(playerId);
            if (playerWs) {
              sendJson(playerWs,
                {
                  type: "create_game",
                  data: {idGame: roomId, idPlayer: playerId},
                  id: 0
                }
              );
            }
          }
          console.log("RESULT: both players in room -> create_game sent for room", roomId);
        } else {
          console.log("RESULT: joined (waiting for opponent)", roomId);
        }

        // reply to joining client with generic joined ack
        sendJson(ws, {
          type: "create_game",
          data: {idGame: roomId, idPlayer: pid},
          id: 0
        });
        // and broadcast updated rooms list
        this.broadcastRoomsList();
        return;
      }

      /* -------------------- Add ships -------------------- */
      case "add_ships": {
        // payload: { gameId, ships: [ { position:{x,y}, direction: boolean, length, type } ], indexPlayer }
        const pid = (ws as any).context.playerId;
        if (!pid) {
          throw new Error("Not authenticated");
        }
        const { gameId, ships: clientShips, indexPlayer } = payload || {};
        if (!gameId || !clientShips) {
          throw new Error("Missing gameId or ships");
        }
        const r = roomsRuntime.get(gameId);
        if (!r) {
          throw new Error("Room not found");
        }
        // convert ships to internal coords
        const expanded = null // expandClientShips(clientShips);
        // store ships in room (Room.receiveShips expects arrays of coords)
        r.receiveShips(indexPlayer ?? pid, expanded);
        // server will start the game automatically when both players submitted ships (Room.startGameIfReady)
        console.log("RESULT: ships received for game", gameId, "player", indexPlayer ?? pid);
        return;
      }

      /* -------------------- Attack -------------------- */
      case "attack": {
        // payload: { gameId, x, y, indexPlayer }
        const pid = (ws as any).context.playerId;
        if (!pid) throw new Error("Not authenticated");
        const { gameId, x, y, indexPlayer } = payload || {};
        if (!gameId || typeof x !== "number" || typeof y !== "number") {
          throw new Error("Missing attack params");
        }
        const r = roomsRuntime.get(gameId);
        if (!r) {
          throw new Error("Room not found");
        }
        // Defensive: ensure indexPlayer matches player's server id (or allow provided indexPlayer)
        const fromId = indexPlayer ?? pid;
        r.attack(fromId, { x, y });

        // Room.attack broadcasts the attack result (attack event) and turn/finish/update_winners as implemented.
        console.log("RESULT: attack processed", { gameId, x, y, by: fromId });
        return;
      }

      /* -------------------- Random attack -------------------- */
      case "randomAttack": {
        // payload: { gameId, indexPlayer }
        const pid = (ws as any).context.playerId;
        if (!pid) {
          throw new Error("Not authenticated");
        }
        const { gameId, indexPlayer } = payload || {};
        if (!gameId) {
          throw new Error("Missing gameId");
        }
        const r: Room | undefined = roomsRuntime.get(gameId);
        if (!r) {
          throw new Error("Room not found");
        }

        // Build set of previously tried coords (from room state if available)
        const tried = new Set<string>();
        if (r.game && r.game.hits) {
          for (const arr of Object.values(r.game.hits)) {
            for (const c of arr) tried.add(`${c.x},${c.y}`);
          }
        }
        // naive random pick with safety limit
        let attempts = 0;
        let picked = null as null | { x: number; y: number };
        while (attempts < 500 && !picked) {
          const x = Math.floor(Math.random() * 10);
          const y = Math.floor(Math.random() * 10);
          if (!tried.has(`${x},${y}`)) picked = { x, y };
          attempts++;
        }
        if (!picked) throw new Error("Unable to generate random attack");
        const fromId = indexPlayer ?? pid;
        r.attack(fromId, picked);
        console.log("RESULT: random attack processed", { gameId, coord: picked, by: fromId });
        return;
      }

      /* -------------------- Unknown command fallback -------------------- */
      default: {
        console.log("RESULT: Unknown command");
        return;
      }
    }
  }
  /* -------------------- small helper: broadcastRoomsList (attach to server object) -------------------- */
  /* call this whenever rooms list changes to send 'update_room' to all connected ws clients */
  private broadcastRoomsList() {
    const list = Array.from(rooms.values()).map((r) => ({
      roomId: r.id,
      roomUsers: r.players.map((pid: string) => {
        const p = players.get(pid);
        return { name: p?.login ?? "unknown", index: pid };
      }),
    }));
    // broadcast to all connected clients (this.wss is assumed present on server object)
    for (const client of this.wss.clients) {
      try {
        client.send(JSON.stringify({ type: "update_room", data: JSON.stringify(list), id: 0 }));
      } catch {}
    }
  }

  close() {
    console.log("Closing server...");
    for (const client of this.wss.clients) {
      try { client.close(); } catch {}
    }
    this.wss.close();
  }

}