import { WebSocketServer, WebSocket } from 'ws';
import {newId, sendJson} from "./serverUtils.js";
import {Room} from "../game/game.js";
import {login, register} from "../game/playerLogic.js";
import {findPlayerByLogin} from "../models/models.js";

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
          sendJson(ws, {type: "reg", data: {

            }
            ,id:0}, )
          sendJson(ws, {
            type: "reg", data: { name: name,
              index: null,
              error: true,
              errorText: e.message || "Register failed" }, id: 0
          });
          console.log("RESULT: register error", e.message);
          return;
        }
      case "update_winners":
        break;

      case "create_room":
        break;

      case "add_user_to_room":
        break;

      case "create_game":
        break;

      case "update_room":
        break;

      case "add_ships":
        break;

      case "start_game":
        break;

      case "attack":
        break;

      case "randomAttack":
        break;

      case "turn":
        break;

      default:
          break;

    }
    // switch (type) {
    //   case "reg":
    //     if (action === "register") {
    //       const { login, password } = payload;
    //       const p = register(login, password);
    //       (ws as any).context.playerId = p.id;
    //       p.ws = ws;
    //       sendJson(ws, { category:"personal", event:"reg", payload:{ playerId: p.id }, requestId });
    //       console.log("RESULT: registered", p.id);
    //       return;
    //     }
    //     if (action === "login") {
    //       const { login: lg, password } = payload;
    //       const p = login(lg, password);
    //       (ws as any).context.playerId = p.id;
    //       p.ws = ws;
    //       sendJson(ws, { category:"personal", event:"reg", payload:{ playerId: p.id }, requestId });
    //       console.log("RESULT: logged in", p.id);
    //       return;
    //     }
    //
    //   case "rooms":
    //     if (action === "create") {
    //       const pid = (ws as any).context.playerId;
    //       if (!pid) throw new Error("Not authenticated");
    //       const roomId = newId();
    //       const rec = { id: roomId, players: [pid], state: "waiting" };
    //       rooms.set(roomId, rec as RoomRecord);
    //       const r = new Room(rec);
    //       r.addPlayer(pid, ws);
    //       roomsRuntime.set(roomId, r);
    //       sendJson(ws, { category:"personal", event:"create_game", payload:{ gameId: roomId, playerId: pid }, requestId });
    //       console.log("RESULT: room created", roomId);
    //       return;
    //     }
    //     if (action === "join") {
    //       const pid = (ws as any).context.playerId;
    //       if (!pid) throw new Error("Not authenticated");
    //       const { roomId } = payload;
    //       const rec = rooms.get(roomId);
    //       if (!rec) throw new Error("Room not found");
    //       let r = roomsRuntime.get(roomId);
    //       if (!r) {
    //         r = new Room(rec);
    //         roomsRuntime.set(roomId, r);
    //       }
    //       r.addPlayer(pid, ws);
    //       sendJson(ws, { category:"personal", event:"joined", payload:{ roomId }, requestId });
    //       console.log("RESULT: joined", roomId);
    //       return;
    //     }
    //
    //   case "ships":
    //     // payload: {roomId, ships}
    //     const pid = (ws as any).context.playerId;
    //     if (!pid) {
    //       throw new Error("Not authenticated");
    //     }
    //     const { roomId, ships } = payload;
    //     const r = roomsRuntime.get(roomId);
    //     if (!r) {
    //       throw new Error("Room not found");
    //     }
    //     r.receiveShips(pid, ships);
    //     console.log("RESULT: ships received");
    //     return;
    //
    //
    //   case "game":
    //     const pid1 = (ws as any).context.playerId;
    //     if (!pid1) throw new Error("Not authenticated");
    //     if (action === "attack") {
    //       const { roomId, coord } = payload;
    //       const r = roomsRuntime.get(roomId);
    //       if (!r) throw new Error("Room not found");
    //       r.attack(pid1, coord);
    //       console.log("RESULT: attack processed");
    //       return;
    //     }
    //
    //   default:
    //     sendJson(ws, { category:"personal", event:"error", payload:{ msg:"Unknown command" }, requestId });
    //     console.log("RESULT: Unknown command");
    //     break;
    // }
  }

  close() {
    console.log("Closing server...");
    for (const client of this.wss.clients) {
      try { client.close(); } catch {}
    }
    this.wss.close();
  }

}