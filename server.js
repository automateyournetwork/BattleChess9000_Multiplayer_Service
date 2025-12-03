import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { v4 as uuidv4 } from 'uuid'; // You might need: npm install uuid

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("BattleChess9000 Lobby Server Running"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- STATE MANAGEMENT ---
// clients = Map<ws, { id, name, avatar, wins, losses, state: 'lobby'|'playing' }>
const clients = new Map();
// rooms = { roomId: { players: [ws, ws], gameData... } }
const rooms = {};

// Simple In-Memory Leaderboard (resets on restart)
const globalStats = {}; // { "Username": { wins: 0, losses: 0 } }

function broadcastLobby() {
  const lobbyList = [];
  for (let [ws, data] of clients) {
    if (data.state === 'lobby') {
      lobbyList.push({
        id: data.id,
        name: data.name,
        avatar: data.avatar,
        stats: globalStats[data.name] || { wins: 0, losses: 0 }
      });
    }
  }

  const payload = JSON.stringify({ type: 'lobby_update', players: lobbyList });
  for (let [ws, data] of clients) {
    if (data.state === 'lobby' && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

wss.on("connection", (ws) => {
  const clientId = uuidv4();
  
  // Initialize temporary client data
  clients.set(ws, { 
    id: clientId, 
    name: "Guest", 
    avatar: "w_p", 
    state: 'connecting' 
  });

  ws.on("message", (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }

    const clientData = clients.get(ws);

    // --- 1. LOGIN / ENTER LOBBY ---
    if (msg.type === "login") {
      const safeName = msg.name.substring(0, 15) || "Player";
      
      // Init stats if new user
      if (!globalStats[safeName]) globalStats[safeName] = { wins: 0, losses: 0 };

      clientData.name = safeName;
      clientData.avatar = msg.avatar || "w_k";
      clientData.state = "lobby";
      
      clients.set(ws, clientData);
      
      send(ws, { type: 'login_success', myId: clientId });
      broadcastLobby();
    }

    // --- 2. SEND CHALLENGE ---
    if (msg.type === "challenge_request") {
      const targetId = msg.targetId;
      
      // Find target socket
      for (let [targetWs, targetData] of clients) {
        if (targetData.id === targetId && targetData.state === 'lobby') {
          send(targetWs, { 
            type: 'challenge_received', 
            fromId: clientData.id, 
            fromName: clientData.name 
          });
          return;
        }
      }
    }

    // --- 3. ACCEPT CHALLENGE ---
    if (msg.type === "challenge_accept") {
      const opponentId = msg.targetId;
      let opponentWs = null;

      // Find opponent
      for (let [oWs, oData] of clients) {
        if (oData.id === opponentId) { opponentWs = oWs; break; }
      }

      if (opponentWs) {
        const roomId = uuidv4();
        rooms[roomId] = { players: [ws, opponentWs] };

        // Update states
        clientData.state = 'playing';
        clients.get(opponentWs).state = 'playing';

        // Assign Colors
        const p1Color = Math.random() < 0.5 ? 'w' : 'b';
        const p2Color = p1Color === 'w' ? 'b' : 'w';

        send(ws, { type: 'game_start', roomId, color: p1Color, opponent: clients.get(opponentWs).name });
        send(opponentWs, { type: 'game_start', roomId, color: p2Color, opponent: clientData.name });
        
        broadcastLobby(); // Remove them from the list for others
      }
    }

    // --- 4. GAME MOVES ---
    if (msg.type === "move") {
      const roomId = msg.roomId;
      if (rooms[roomId]) {
        rooms[roomId].players.forEach(pWs => {
          if (pWs !== ws) send(pWs, { type: 'move', move: msg.move });
        });
      }
    }

    // --- 5. GAME OVER (Update Leaderboard) ---
    if (msg.type === "game_over") {
      const winnerName = msg.winnerName; // sent by client logic
      const loserName = msg.loserName;
      
      if (globalStats[winnerName]) globalStats[winnerName].wins++;
      if (globalStats[loserName]) globalStats[loserName].losses++;
      
      // Don't broadcast lobby yet, wait for them to click "Back to Lobby"
    }

    // --- 6. RETURN TO LOBBY ---
    if (msg.type === "return_lobby") {
      clientData.state = "lobby";
      broadcastLobby();
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`BattleChess Lobby Server on ${PORT}`);
});