import { WebSocket } from "ws";
import { players, rooms } from "../models/models.js";
import { sendJson } from "../server/serverUtils.js";
/**
 * Game board is 10x10. Ships are arrays of coordinates {x,y}.
 * For simplicity use 0..9 coordinates.
 */

export class Room {
  id: string;
  roomRecord: any;
  sockets: Map<string, WebSocket>;
  game: {
    players: string[]; // player ids order
    ships: Record<string, Array<{ x:number; y:number }[]>>;
    hits: Record<string, { x:number,y:number }[]>;
    turnIndex: number;
    remaining: Record<string, number>;
  } | null = null;

  constructor(roomRecord: any) {
    this.id = roomRecord.id;
    this.roomRecord = roomRecord;
    this.sockets = new Map();
    this.roomRecord.state = "waiting";
  }

  addPlayer(playerId: string, ws: WebSocket) {
    this.sockets.set(playerId, ws);
    if (!this.roomRecord.players.includes(playerId))
      this.roomRecord.players.push(playerId);
    this.broadcastUpdateRoom();
    if (this.roomRecord.players.length === 2) {
      this.roomRecord.state = "placing";
      this.broadcastRoomEvent("info", {
        msg: "Both players connected. Send ships using action 'send_ships'."
      });
    }
  }

  removePlayer(playerId: string) {
    this.sockets.delete(playerId);
    this.roomRecord.players = this.roomRecord.players.filter((id:string)=>id!==playerId);
    this.broadcastUpdateRoom();
    if (this.roomRecord.players.length === 0) {
      rooms.delete(this.id);
    }
  }

  broadcastUpdateRoom() {
    const payload = {
      roomId: this.id,
      players: this.roomRecord.players.map((id:string)=> {
        const p = players.get(id);
        return { id, login: p?.login ?? "unknown" };
      })
    };
    for (const s of this.sockets.values()) {
      sendJson(s, { category: "global", event: "update_room", payload });
    }
  }

  broadcastRoomEvent(event: string, payload: any) {
    for (const s of this.sockets.values()) {
      sendJson(s, { category: "room", event, payload });
    }
  }

  allShipsReceived(): boolean {
    if (!this.game) return false;
    const pids = this.game.players;
    return pids.every(pid => this.game.ships[pid] && this.game.ships[pid].length>0);
  }

  startGameIfReady() {
    if (!this.game) return;
    if (!this.allShipsReceived()) return;
    // compute remaining cells
    for (const pid of this.game.players) {
      this.game.remaining[pid] = this.game.ships[pid].flat().length;
    }
    this.roomRecord.state = "playing";
    // randomize turn
    this.game.turnIndex = Math.floor(Math.random()*2);
    const starter = this.game.players[this.game.turnIndex];
    this.broadcastRoomEvent("start_game", {
      gameId: this.id,
      players: this.game.players,
      yourShipsCounts: this.game.players.reduce((acc:any,pid:string)=>{
        acc[pid] = this.game.ships[pid].length;
        return acc;
      },{}),
      starter
    });
    this.sendTurn();
  }

  initGame() {
    this.game = {
      players: [...this.roomRecord.players],
      ships: {},
      hits: {},
      turnIndex: 0,
      remaining: {}
    };
  }

  receiveShips(playerId: string, ships: Array<Array<{ x:number,y:number }>>) {
    if (!this.game) this.initGame();
    // Basic validation: ships are arrays of coordinates; you can add more rules (sizes, collisions)
    this.game.ships[playerId] = ships;
    this.game.hits[playerId] = [];
    this.broadcastRoomEvent("personal", { event: "ships_received", payload: { playerId }});
    this.startGameIfReady();
  }

  sendTurn() {
    if (!this.game) return;
    const current = this.game.players[this.game.turnIndex];
    this.broadcastRoomEvent("turn", { playerId: current });
  }

  attack(fromId: string, coord: { x:number,y:number }) {
    if (!this.game) return;
    const current = this.game.players[this.game.turnIndex];
    if (current !== fromId) {
      const ws = this.sockets.get(fromId);
      if (ws) sendJson(ws, { category:"personal", event:"error", payload:{ msg:"Not your turn" }});
      return;
    }
    const opponentIndex = (this.game.turnIndex+1)%2;
    const opponent = this.game.players[opponentIndex];
    const opponentShips = this.game.ships[opponent] || [];
    // find hit
    let hit = false;
    let sunk = false;
    for (const ship of opponentShips) {
      const idx = ship.findIndex(c => c.x === coord.x && c.y === coord.y);
      if (idx !== -1) {
        hit = true;
        // mark removed
        ship.splice(idx,1);
        if (ship.length === 0) sunk = true;
        this.game.remaining[opponent] -= 1;
        break;
      }
    }
    // record hit for logging
    this.game.hits[opponent].push(coord);
    // send attack result
    this.broadcastRoomEvent("attack", {
      by: fromId,
      coord,
      result: hit ? (sunk ? "sunk" : "hit") : "miss"
    });

    // if opponent has 0 remaining -> finish
    if (this.game.remaining[opponent] <= 0) {
      this.roomRecord.state = "finished";
      this.broadcastRoomEvent("finish", { winner: fromId });
      // update scores
      const pRec = players.get(fromId);
      if (pRec) pRec.score = (pRec.score||0) + 1;
      // broadcast winners
      const winners = Array.from(players.values()).map(p=>({ id:p.id, login:p.login, score:p.score||0 }));
      for (const s of this.sockets.values()) {
        sendJson(s, { category:"global", event:"update_winners", payload: winners });
      }
      return;
    }

    // if hit or sunk -> same player shoots again
    if (!hit) {
      this.game.turnIndex = opponentIndex;
    } // else same turnIndex
    this.sendTurn();
  }
}
