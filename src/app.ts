import dotenv from "dotenv";
import {BattleshipServer} from "./server/ws.js";

dotenv.config();


const PORT = Number(process.env.PORT || 8080);

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
