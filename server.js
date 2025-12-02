import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";

const PORT = process.env.PORT || 8080;

const app = express();
app.use(cors());

// Simple health check for Cloud Run
app.get("/", (req, res) => {
  res.send("BattleChess9000 WebSocket server is running.");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms = { ROOM_ID: { players: [ { ws, name, color } ] } }
const rooms = {};
const clientRoom = new Map(); // ws -> roomId

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(roomId, payload, exceptWs = null) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((p) => {
    if (p.ws !== exceptWs && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(JSON.stringify(payload));
    }
  });
}

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error("Invalid JSON from client:", e);
      return;
    }

    if (msg.type === "join") {
      const roomId = msg.roomId;
      const name = msg.name || "Player";

      if (!roomId) {
        send(ws, { type: "error", message: "No roomId provided" });
        return;
      }

      if (!rooms[roomId]) {
        rooms[roomId] = { players: [] };
      }

      const room = rooms[roomId];

      // Max 2 players per room
      if (room.players.length >= 2) {
        send(ws, { type: "error", message: "Room full" });
        return;
      }

      room.players.push({ ws, name, color: null });
      clientRoom.set(ws, roomId);

      console.log(
        `Client joined room ${roomId}. Now ${room.players.length} player(s).`
      );

      // When we have 2 players, randomize colors and start
      if (room.players.length === 2) {
        const colors = Math.random() < 0.5 ? ["w", "b"] : ["b", "w"];
        room.players[0].color = colors[0];
        room.players[1].color = colors[1];

        room.players.forEach((p) => {
          send(p.ws, {
            type: "start",
            color: p.color
          });
        });

        console.log(`Room ${roomId} started. Colors:`, colors);
      }
    }

    if (msg.type === "move") {
      const roomId = msg.roomId;
      const move = msg.move;
      if (!roomId || !rooms[roomId]) return;

      // Relay move to the other player
      broadcastToRoom(roomId, { type: "move", move }, ws);
    }
  });

  ws.on("close", () => {
    const roomId = clientRoom.get(ws);
    if (!roomId) return;

    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter((p) => p.ws !== ws);
    clientRoom.delete(ws);

    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (no players left).`);
    } else {
      console.log(
        `Client left room ${roomId}. Remaining players: ${room.players.length}`
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`BattleChess9000 WebSocket server listening on port ${PORT}`);
});
