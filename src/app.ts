// src/server.ts
import { WebSocketServer, type WebSocket } from "ws";
import crypto from "crypto";
import dotenv from "dotenv";
import type {
  AddShipsReq,
  AttackReq,
  ClientShip,
  Message,
  RandomAttackReq,
  RegReq,
  RegRes, RoomListItem
} from "./server/messageTypes.js";
import type {PlayerRecord, RoomRecord} from "./models/models.js";
import {playersById, playersByLogin, rooms} from "./repositories/storage.js";
dotenv.config();


const PORT = Number(process.env.PORT || 8080);

/* --------------------------- Game model --------------------------- */

/**
 * Per-game player session id mapping:
 * When a game starts we assign per-game indices "0" and "1" (strings) to players.
 * indexPlayer used in protocol is that per-game index.
 */

type Coord = { x: number; y: number };
function coordKey(c: Coord) { return `${c.x},${c.y}`; }

type ServerShip = {
  id: string;
  type: ClientShip["type"];
  cells: Coord[]; // remaining cells (we will remove coords when hit)
  originalCells: Coord[]; // full set for reporting start_game
};

type Game = {
  id: string; // same as room id for simplicity
  players: { serverId: string; sessionIndex: string }[]; // sessionIndex "0"|"1"
  ships: Record<string, ServerShip[]>; // sessionIndex -> ships
  occupied: Record<string, Map<string, ServerShip>>; // sessionIndex -> map coordKey->ship (occupied by that player's ships)
  tried: Record<string, Set<string>>; // sessionIndex -> coords that were targeted (string keys)
  currentPlayerIndex: string; // "0" or "1" (sessionIndex who should shoot)
};

/* runtime */
const games = new Map<string, Game>(); // roomId -> game

/* -------------------------- Utilities ----------------------------- */

function newId() { return crypto.randomUUID(); }

function send(ws: WebSocket, type: string, payload: any) {
  const env: Message = { type, data: JSON.stringify(payload), id: 0 };
  try { ws.send(JSON.stringify(env)); } catch (e) { console.error("send error", e); }
}

function broadcastAll(type: string, payload: any, wss: WebSocketServer) {
  const raw = JSON.stringify({ type, data: JSON.stringify(payload), id: 0 });
  for (const c of wss.clients) {
    try { c.send(raw); } catch {}
  }
}

function broadcastToSockets(sockets: WebSocket[], type: string, payload: any) {
  const raw = JSON.stringify({ type, data: JSON.stringify(payload), id: 0 });
  for (const s of sockets) {
    try { s.send(raw); } catch {}
  }
}

/* ---------------------- Player handling --------------------------- */

function registerPlayer(name: string, password: string) {
  if (playersByLogin.has(name)) throw new Error("Login exists");
  const id = newId();
  const rec: PlayerRecord = { id, name: name, password, ws: null, wins: 0 };
  playersById.set(id, rec);
  playersByLogin.set(name, id);
  return rec;
}

function findPlayerByLogin(name: string): PlayerRecord | null {
  const id = playersByLogin.get(name);
  if (!id) return null;
  return playersById.get(id) ?? null;
}

function loginPlayer(name: string, password: string) {
  const rec = findPlayerByLogin(name);
  if (!rec) throw new Error("No such user");
  if (rec.password !== password) throw new Error("Invalid password");
  return rec;
}

/* ---------------------- Ship utilities ---------------------------- */

const BOARD_SIZE = 10; // 0..9

function expandClientShip(s: ClientShip): Coord[] {
  const coords: Coord[] = [];
  const sx = Math.trunc(s.position.x);
  const sy = Math.trunc(s.position.y);
  const len = Math.trunc(s.length);
  for (let i = 0; i < len; i++) {
    const x = s.direction ? sx: sx + i ;
    const y = s.direction ? sy + i : sy;
    coords.push({ x, y });
  }
  return coords;
}

function validateShipsPlacement(ships: ClientShip[]) {
  // check bounds, integer coords, no overlap, reasonable total cells
  const occupied = new Set<string>();
  for (const s of ships) {
    if (!s || typeof s.length !== "number" || !s.position) throw new Error("Invalid ship format");
    const coords = expandClientShip(s);
    if (coords.length !== s.length) throw new Error("Invalid length expansion");
    for (const c of coords) {
      if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) throw new Error("Coordinates must be integers");
      if (c.x < 0 || c.x >= BOARD_SIZE || c.y < 0 || c.y >= BOARD_SIZE) throw new Error(`Ship out of bounds: ${c} in ${ships}`);
      const key = coordKey(c);
      if (occupied.has(key)) throw new Error("Ships overlap");
      occupied.add(key);
    }
  }
  return true;
}

/* ---------------------- Room/Game lifecycle ----------------------- */

function buildGameForRoom(room: RoomRecord): Game {
  const id = room.id;
  const game: Game = {
    id,
    players: [],
    ships: { "0": [], "1": [] },
    occupied: { "0": new Map(), "1": new Map() },
    tried: { "0": new Set(), "1": new Set() },
    currentPlayerIndex: "0"
  };
  // assign session indices in order players array
  for (let i = 0; i < room.players.length; i++) {
    const serverId = room.players[i];
    const sessionIndex = String(i);
    game.players.push({ serverId, sessionIndex });
  }
  games.set(id, game);
  return game;
}

function getGameByRoomId(roomId: string): Game | undefined {
  return games.get(roomId);
}

/* helper: map server player id -> sessionIndex in a game */
function serverIdToSessionIndex(game: Game, serverId: string): string | undefined {
  const p = game.players.find(x => x.serverId === serverId);
  return p?.sessionIndex;
}

/* ----------------------- Attack logic ---------------------------- */

/**
 * checkAttack(game, attackerSessionIndex, x,y)
 * returns array of attack result messages to broadcast to both players.
 * It will mutate game ships/occupied accordingly.
 *
 * Result message shape per spec:
 * {
 *   type: "attack",
 *   data: { position: {x,y}, currentPlayer: <indexPlayer>, status: "miss"|"killed"|"shot" }
 * }
 */
function handleAttack(game: Game, attackerIndex: string, x: number, y: number) {
  const opponentIndex = attackerIndex === "0" ? "1" : "0";
  const posKey = `${x},${y}`;

  if (game.tried[attackerIndex].has(posKey)) {
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "repeat" }];
  }

  game.tried[attackerIndex].add(posKey);

  const shipMap = game.occupied[opponentIndex];
  const ship = shipMap.get(posKey);

  if (!ship) {
    game.currentPlayerIndex = opponentIndex;
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "miss" }];
  }

  // ---- HIT ----
  const idx = ship.cells.findIndex(c => c.x === x && c.y === y);
  if (idx === -1) {
    game.currentPlayerIndex = opponentIndex;
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "miss" }];
  }

  ship.cells.splice(idx, 1);
  shipMap.delete(posKey);

  if (ship.cells.length > 0) {
    return [{ position: { x, y }, currentPlayer: attackerIndex, status: "shot" }];
  }

  // ---- KILLED ----
  // ship is fully destroyed now

  // 1) Collect ALL killed cells of this ship
  const killedCells = ship.originalCells.map(c => ({
    position: c,
    currentPlayer: attackerIndex,
    status: "killed" as const
  }));

  // 2) Generate surrounding misses, but skip the ship's own cells
  const surroundMsgs: { position: Coord; currentPlayer: string; status: "miss" }[] = [];
  const shipCellKeys = new Set(ship.originalCells.map(c => `${c.x},${c.y}`));
  const visited = new Set<string>();

  for (const oc of ship.originalCells) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cx = oc.x + dx;
        const cy = oc.y + dy;

        if (cx < 0 || cy < 0 || cx >= BOARD_SIZE || cy >= BOARD_SIZE) continue;

        const key = `${cx},${cy}`;
        if (visited.has(key)) continue;
        visited.add(key);

        // Skip actual ship cells — fixing BUG #1
        if (shipCellKeys.has(key)) {
          continue;
        }

        // Skip cells that are occupied by alive ships
        if (shipMap.has(key)) {
          continue;
        }

        surroundMsgs.push({
          position: { x: cx, y: cy },
          currentPlayer: attackerIndex,
          status: "miss"
        });

        game.tried[attackerIndex].add(key);
      }
    }
  }

  // ---- WIN CHECK ----
  const opponentRemaining = shipMap.size;

  if (opponentRemaining === 0) {
    return [
      ...killedCells,   // FIX #2
      ...surroundMsgs
    ];
  }

  // attacker keeps turn
  return [
    ...killedCells,     // FIX #2
    ...surroundMsgs
  ];
}


/* ---------------------- Server (transport) ------------------------ */

class BattleshipServer {
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

/* ----------------------------- Boot ------------------------------ */

const server = new BattleshipServer(PORT);

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down");
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close();
  process.exit(0);
});
