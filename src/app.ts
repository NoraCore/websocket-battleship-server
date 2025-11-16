import { WsServer } from "./server/ws.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const server = new WsServer(PORT, HOST);

// on SIGINT/SIGTERM graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down");
  server.close();
  process.exit(0);
});