import {WebSocketServer, WebSocket} from "ws";
import type {AddShipsReq, AttackReq, Message, RandomAttackReq, RegReq, RegRes, RoomListItem} from "./messageTypes.js";
import {broadcastAll, broadcastToSockets, newId, send} from "../utils/utils.js";
import {findPlayerByLogin, loginPlayer, playersById, registerPlayer, rooms} from "../repositories/storage.js";
import {
  buildGameForRoom, type Coord, coordKey,
  games,
  getGameByRoomId,
  serverIdToSessionIndex,
  type ServerShip
} from "../models/gameModels.js";
import {BOARD_SIZE, expandClientShip, handleAttack, validateShipsPlacement} from "../game/game.js";
import type {RoomRecord} from "../models/models.js";

export class BattleshipServer {
  wss: WebSocketServer;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws, req) => this.onConnection(ws));
    console.log(`WebSocket server started on ws://0.0.0.0:${port}`);
  }

  onConnection(ws: WebSocket) {
    (ws as any).context = { playerId: null }; // attach context
    ws.on("message", (raw) => {
      // Each message is expected to be JSON string of Envelope
      let env: Message | null = null;
      try {
        env = JSON.parse(raw.toString()) as Message;
      } catch (e) {
        console.log("RECV RAW:", raw.toString());
        console.log("RESULT: Invalid JSON envelope");
        send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid envelope JSON" });
        return;
      }
      this.handleMessage(ws, env);
    });

    ws.on("close", () => {
      // cleanup: remove player from rooms if present
      const pid = (ws as any).context.playerId as string | null;
      if (pid) {
        for (const [roomId, room] of rooms) {
          if (room.players.includes(pid)) {
            room.players = room.players.filter(p => p !== pid);
            room.state = "waiting";
            // remove game if any
            games.delete(roomId);
            // broadcast updated rooms
            this.broadcastRoomsList();
          }
        }
      }
    });
  }

  logCommand(env: Message) {
    console.log("COMMAND:", env );
  }

  handleMessage(ws: WebSocket, env: Message) {
    // Validate envelope
    if (!env || typeof env.type !== "string" || env.id !== 0 || typeof env.data !== "string") {
      console.log("RECV RAW:", JSON.stringify(env));
      console.log("RESULT: Invalid envelope");
      send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid envelope (expected type,data,id)" });
      return;
    }


    this.logCommand(env);

    try {
      switch (env.type) {
        /* -------------------- reg (login/register) -------------------- */
        case "reg": {

          // Parse data which is JSON string
          let payload: any;
          try {
            payload = JSON.parse(env.data);
          } catch (e) {
            console.log("RECV RAW:", JSON.stringify(env));
            console.log("RESULT: Invalid JSON in data");
            send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid JSON in data field" });
            return;
          }

          const { name, password } = payload as RegReq;
          if (!name || !password) {
            const res: RegRes = { name: name ?? null, index: null, error: true, errorText: "Missing name or password" };
            send(ws, "reg", res);
            console.log("RESULT: reg failed - missing creds");
            return;
          }

          const existing = findPlayerByLogin(name);
          if (existing) {
            // try login
            try {
              const rec = loginPlayer(name, password);
              (ws as any).context.playerId = rec.id;
              rec.ws = ws;
              const res: RegRes = { name, index: rec.id, error: false, errorText: "" };
              send(ws, "reg", res);
              console.log("RESULT: logged in", rec.id);
              // after login send update_room and update_winners
              this.broadcastRoomsList();
              this.broadcastWinners();
              return;
            } catch (e: any) {
              const res: RegRes = { name, index: null, error: true, errorText: e.message || "Login failed" };
              send(ws, "reg", res);
              console.log("RESULT: login error", e.message);
              return;
            }
          } else {
            // register
            try {
              const rec = registerPlayer(name, password);
              (ws as any).context.playerId = rec.id;
              rec.ws = ws;
              const res: RegRes = { name, index: rec.id, error: false, errorText: "" };
              send(ws, "reg", res);
              console.log("RESULT: registered", rec.id);
              // send update_room and update_winners
              this.broadcastRoomsList();
              this.broadcastWinners();
              return;
            } catch (e: any) {
              const res: RegRes = { name, index: null, error: true, errorText: e.message || "Register failed" };
              send(ws, "reg", res);
              console.log("RESULT: register error", e.message);
              return;
            }
          }
        }

        /* -------------------- create_room -------------------- */
        case "create_room": {
          const pid = (ws as any).context.playerId as string | null;
          if (!pid) throw new Error("Not authenticated");
          const roomId = newId();
          const rec: RoomRecord = { id: roomId, players: [pid], state: "waiting" };
          rooms.set(roomId, rec);
          console.log("RESULT: room created", roomId);
          // Broadcast update_room to all clients
          this.broadcastRoomsList();
          return;
        }

        /* -------------------- add_user_to_room (join) -------------------- */
        case "add_user_to_room": {

          // Parse data which is JSON string
          let payload: any;
          try {
            payload = JSON.parse(env.data);
          } catch (e) {
            console.log("RECV RAW:", JSON.stringify(env));
            console.log("RESULT: Invalid JSON in data");
            send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid JSON in data field" });
            return;
          }

          const pid = (ws as any).context.playerId as string | null;
          if (!pid) throw new Error("Not authenticated");
          const { indexRoom } = payload as { indexRoom: string };
          if (!indexRoom) throw new Error("Missing indexRoom");
          const room = rooms.get(indexRoom);
          if (!room) throw new Error("Room not found");
          if (room.players.length >= 2) throw new Error("Room is full");

          if (room.players.find(value => value === pid)) throw new Error(`Room is already contains this user`);

          room.players.push(pid);
          room.state = "placing";
          console.log("RESULT: joined room", indexRoom);

          // create game object and assign per-game indices 0 and 1
          const game = buildGameForRoom(room);

          // send create_game to both players with per-game idPlayer
          for (const p of game.players) {
            const playerRec = playersById.get(p.serverId);
            const targetWs = (playerRec?.ws ?? null) as WebSocket | null;
            if (targetWs) {
              send(targetWs, "create_game", { idGame: game.id, idPlayer: p.sessionIndex });
            }
          }

          // broadcast update_room after join
          this.broadcastRoomsList();
          return;
        }

        /* -------------------- add_ships -------------------- */
        case "add_ships": {

          // Parse data which is JSON string
          let payload: any;
          try {
            payload = JSON.parse(env.data);
          } catch (e) {
            console.log("RECV RAW:", JSON.stringify(env));
            console.log("RESULT: Invalid JSON in data");
            send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid JSON in data field" });
            return;
          }

          const pid = (ws as any).context.playerId as string | null;
          if (!pid) throw new Error("Not authenticated");
          const body = payload as AddShipsReq;
          if (!body || !body.gameId || !Array.isArray(body.ships)) throw new Error("Missing gameId or ships");

          const game = getGameByRoomId(body.gameId);
          if (!game) throw new Error("Game not found");

          // map indexPlayer (sessionIndex) -> use provided, else derive from server pid
          const sessionIndex = body.indexPlayer ?? serverIdToSessionIndex(game, pid);
          if (sessionIndex !== "0" && sessionIndex !== "1") throw new Error("Invalid indexPlayer");

          // validate ships placement
          validateShipsPlacement(body.ships);

          // convert and store as ServerShip objects
          const serverShips: ServerShip[] = body.ships.map(s => {
            const cells = expandClientShip(s);
            return { id: newId(), type: s.type, cells: [...cells], originalCells: [...cells] };
          });

          game.ships[sessionIndex] = serverShips;
          // populate occupied map for this player
          const occ = game.occupied[sessionIndex];
          for (const sh of serverShips) {
            for (const c of sh.cells) {
              occ.set(coordKey(c), sh);
            }
          }

          console.log("RESULT: ships received for game", body.gameId, "player", sessionIndex);

          // If both players submitted ships -> start the game
          if (game.ships["0"].length > 0 && game.ships["1"].length > 0) {
            // choose random starter
            game.currentPlayerIndex = Math.random() < 0.5 ? "0" : "1";
            // send start_game to each player with their own ships (per spec: player's ships, not enemy's)
            for (const p of game.players) {
              const serverId = p.serverId;
              const playerWs = (playersById.get(serverId)?.ws ?? null) as WebSocket | null;
              if (playerWs) {
                // we must send the player's own ships in client format
                const ownShips = game.ships[p.sessionIndex].map(sh => {
                  // reconstruct client ship form: pick originalCells to derive position/direction/length/type
                  // Simpler: send originalCells as array of positions + type + length and direction unknown to client.
                  // But spec expects original client format; to be safe, we send originalCells as positions array + type + length/direction unspecified.
                  const pos = sh.originalCells[0];
                  const length = sh.originalCells.length;
                  // try to infer direction (horizontal if x varies)
                  const direction = length > 1 && sh.originalCells[0].y === sh.originalCells[1].y;
                  return {
                    position: { x: pos.x, y: pos.y },
                    direction,
                    length,
                    type: sh.type
                  };
                });

                send(playerWs, "start_game", { ships: ownShips, currentPlayerIndex: game.currentPlayerIndex });
              }
            }

            // send turn to both (spec: send turn after start game)
            for (const p of game.players) {
              const serverId = p.serverId;
              const playerWs = (playersById.get(serverId)?.ws ?? null) as WebSocket | null;
              if (playerWs) send(playerWs, "turn", { currentPlayer: game.currentPlayerIndex });
            }

            console.log("RESULT: start_game for game", game.id, "starter", game.currentPlayerIndex);
          }

          return;
        }

        /* -------------------- attack -------------------- */
        case "attack": {

          // Parse data which is JSON string
          let payload: any;
          try {
            payload = JSON.parse(env.data);
          } catch (e) {
            console.log("RECV RAW:", JSON.stringify(env));
            console.log("RESULT: Invalid JSON in data");
            send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid JSON in data field" });
            return;
          }

          const pid = (ws as any).context.playerId as string | null;
          if (!pid) throw new Error("Not authenticated");
          const body = payload as AttackReq;
          if (!body || !body.gameId || typeof body.x !== "number" || typeof body.y !== "number") throw new Error("Missing attack params");

          const game = getGameByRoomId(body.gameId);
          if (!game) throw new Error("Game not found");
          const attackerIndex = body.indexPlayer ?? serverIdToSessionIndex(game, pid);
          if (!attackerIndex) throw new Error("Invalid attacker index");

          // Check turn
          if (game.currentPlayerIndex !== attackerIndex) {
            // not player's turn -> send personal error
            send(ws, "attack", { position: { x: body.x, y: body.y }, currentPlayer: game.currentPlayerIndex, status: "miss" });
            console.log("RESULT: attack ignored - not player's turn");
            return;
          }

          // handle attack
          const results = handleAttack(game, attackerIndex, body.x, body.y);

          // Broadcast each attack message to both players
          const room = rooms.get(body.gameId);
          if (!room) throw new Error("Room not found for broadcast");
          const sockets: WebSocket[] = room.players.map(sid => playersById.get(sid)?.ws).filter(Boolean) as WebSocket[];

          for (const r of results) {
            // send attack for all players
            broadcastToSockets(sockets, "attack", { position: r.position, currentPlayer: r.currentPlayer, status: r.status });
            console.log("RESULT: attack ->", r);
          }

          // If last result was 'killed' and opponent has no occupied cells -> finish
          let opponentIndex = attackerIndex === "0" ? "1" : "0";
          const opponentOcc = game.occupied[opponentIndex];
          if (opponentOcc.size === 0) {
            // attacker wins
            // increment winner stats
            const winnerServerId = game.players.find(p => p.sessionIndex === attackerIndex)!.serverId;
            const winnerRec = playersById.get(winnerServerId);
            if (winnerRec) winnerRec.wins++;

            // send finish to both players
            broadcastToSockets(sockets, "finish", { winPlayer: attackerIndex });
            // update winners globally
            this.broadcastWinners();
            console.log("RESULT: finish, winner", attackerIndex);
            // set room state finished
            const rrec = rooms.get(body.gameId);
            if (rrec) rrec.state = "finished";
            // cleanup game
            games.delete(body.gameId);
            rooms.delete(body.gameId);
            this.broadcastRoomsList();
            return;
          }

          // else send turn update (currentPlayerIndex may have been changed inside handleAttack)
          for (const s of sockets) send(s, "turn", { currentPlayer: game.currentPlayerIndex });
          console.log("RESULT: turn ->", game.currentPlayerIndex);
          return;
        }

        /* -------------------- randomAttack -------------------- */
        case "randomAttack": {

          // Parse data which is JSON string
          let payload: any;
          try {
            payload = JSON.parse(env.data);
          } catch (e) {
            console.log("RECV RAW:", JSON.stringify(env));
            console.log("RESULT: Invalid JSON in data");
            send(ws, "reg", { name: null, index: null, error: true, errorText: "Invalid JSON in data field" });
            return;
          }

          const pid = (ws as any).context.playerId as string | null;
          if (!pid) throw new Error("Not authenticated");
          const body = payload as RandomAttackReq;
          if (!body || !body.gameId) throw new Error("Missing gameId");
          const game = getGameByRoomId(body.gameId);
          if (!game) throw new Error("Game not found");
          const attackerIndex = body.indexPlayer ?? serverIdToSessionIndex(game, pid);
          if (!attackerIndex) throw new Error("Invalid attacker index");

          // pick a random untied coordinate
          const tried = game.tried[attackerIndex];
          let picked: Coord | null = null;
          // simple scan for first free
          for (let x = 0; x < BOARD_SIZE && !picked; x++) {
            for (let y = 0; y < BOARD_SIZE && !picked; y++) {
              const k = `${x},${y}`;
              if (!tried.has(k)) picked = { x, y };
            }
          }
          if (!picked) throw new Error("No available coords to attack");

          // reuse attack handling
          const results = handleAttack(game, attackerIndex, picked.x, picked.y);

          const room = rooms.get(body.gameId);
          if (!room) throw new Error("Room not found for broadcast");
          const sockets: WebSocket[] = room.players.map(sid => playersById.get(sid)?.ws).filter(Boolean) as WebSocket[];

          for (const r of results) {
            broadcastToSockets(sockets, "attack", { position: r.position, currentPlayer: r.currentPlayer, status: r.status });
            console.log("RESULT: randomAttack ->", r);
          }

          // handle finish
          const opponentIndex2 = attackerIndex === "0" ? "1" : "0";
          if (game.occupied[opponentIndex2].size === 0) {
            const winnerServerId = game.players.find(p => p.sessionIndex === attackerIndex)!.serverId;
            const winnerRec = playersById.get(winnerServerId);
            if (winnerRec) winnerRec.wins++;
            broadcastToSockets(sockets, "finish", { winPlayer: attackerIndex });
            this.broadcastWinners();
            games.delete(body.gameId);
            rooms.delete(body.gameId);
            this.broadcastRoomsList();
            console.log("RESULT: finish via randomAttack", attackerIndex);
            return;
          }

          // send turn
          for (const s of sockets) send(s, "turn", { currentPlayer: game.currentPlayerIndex });
          console.log("RESULT: turn ->", game.currentPlayerIndex);
          return;
        }

        default:
          send(ws, "reg", { name: null, index: null, error: true, errorText: "Unknown command" });
          console.log("RESULT: Unknown command", env.type);
          return;
      }
    } catch (err: any) {
      const errorText = err?.message ?? String(err);
      send(ws, "reg", { name: null, index: null, error: true, errorText });
      console.log("ERROR:", errorText);
    }
  }

  broadcastRoomsList() {
    const list: RoomListItem[] = Array.from(rooms.values()).map(r => ({
      roomId: r.id,
      roomUsers: r.players.map(pid => {
        const p = playersById.get(pid)!;
        return { name: p.name, index: pid };
      })
    }));
    broadcastAll("update_room", list, this.wss);
    console.log("RESULT: update_room broadcasted");
  }

  broadcastWinners() {
    const winners = Array.from(playersById.values()).map(p => ({ name: p.name, wins: p.wins }));
    broadcastAll("update_winners", winners, this.wss);
    console.log("RESULT: update_winners broadcasted");
  }

  close() {
    console.log("Closing server...");
    for (const c of this.wss.clients) {
      try { c.close(); } catch {}
    }
    this.wss.close();
  }
}
