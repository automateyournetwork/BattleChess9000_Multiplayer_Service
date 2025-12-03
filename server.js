import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("BattleChess9000 Server Running"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// clients = Map<ws, { id, name, avatar, state: 'lobby'|'playing'|'waiting_private' }>
const clients = new Map();
// rooms = { roomId: { players: [ws, ws], isPrivate: bool } }
const rooms = {};

const globalStats = {}; 

function broadcastLobby() {
  const lobbyList = [];
  for (let [ws, data] of clients) {
    // Only show players actually in the public lobby
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

function startGame(roomId) {
    const room = rooms[roomId];
    if(!room || room.players.length !== 2) return;

    const p1 = room.players[0];
    const p2 = room.players[1];
    
    // Update states
    clients.get(p1).state = 'playing';
    clients.get(p2).state = 'playing';

    // Assign Colors
    const p1Color = Math.random() < 0.5 ? 'w' : 'b';
    const p2Color = p1Color === 'w' ? 'b' : 'w';

    send(p1, { type: 'game_start', roomId, color: p1Color, opponent: clients.get(p2).name });
    send(p2, { type: 'game_start', roomId, color: p2Color, opponent: clients.get(p1).name });

    // Update lobby so these players disappear from the list
    broadcastLobby();
}

wss.on("connection", (ws) => {
  const clientId = uuidv4();
  
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

    // --- 1. LOGIN (PUBLIC LOBBY) ---
    if (msg.type === "login") {
      const safeName = msg.name.substring(0, 15) || "Player";
      if (!globalStats[safeName]) globalStats[safeName] = { wins: 0, losses: 0 };

      clientData.name = safeName;
      clientData.avatar = msg.avatar || "w_k";
      clientData.state = "lobby";
      
      clients.set(ws, clientData);
      send(ws, { type: 'login_success', myId: clientId });
      broadcastLobby();
    }

    // --- 2. CREATE PRIVATE LINK ---
    if (msg.type === "create_private") {
        const roomId = uuidv4();
        const safeName = msg.name || "Host";
        
        clientData.name = safeName;
        clientData.avatar = msg.avatar;
        clientData.state = "waiting_private"; // Don't show in lobby list

        rooms[roomId] = { players: [ws], isPrivate: true };
        
        send(ws, { type: 'private_created', roomId });
    }

    // --- 3. JOIN PRIVATE LINK ---
    if (msg.type === "join_private") {
        const roomId = msg.roomId;
        const room = rooms[roomId];
        
        if (room && room.players.length < 2) {
            const safeName = msg.name || "Guest";
            clientData.name = safeName;
            clientData.avatar = msg.avatar;
            clientData.state = "playing"; // Go straight to playing

            room.players.push(ws);
            startGame(roomId);
        } else {
            send(ws, { type: 'error', message: "Room not found or full" });
        }
    }

    // --- 4. LOBBY CHALLENGE LOGIC ---
    if (msg.type === "challenge_request") {
      const targetId = msg.targetId;
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

    if (msg.type === "challenge_accept") {
      const opponentId = msg.targetId;
      let opponentWs = null;
      for (let [oWs, oData] of clients) {
        if (oData.id === opponentId) { opponentWs = oWs; break; }
      }

      if (opponentWs) {
        const roomId = uuidv4();
        rooms[roomId] = { players: [ws, opponentWs], isPrivate: false };
        startGame(roomId);
      }
    }

    // --- 5. GAME MOVES ---
    if (msg.type === "move") {
      const roomId = msg.roomId;
      if (rooms[roomId]) {
        rooms[roomId].players.forEach(pWs => {
          if (pWs !== ws) send(pWs, { type: 'move', move: msg.move });
        });
      }
    }

    // --- 6. GAME OVER ---
    if (msg.type === "game_over") {
      const winnerName = msg.winnerName;
      const loserName = msg.loserName;
      if (globalStats[winnerName]) globalStats[winnerName].wins++;
      if (globalStats[loserName]) globalStats[loserName].losses++;
    }
  });

  ws.on("close", () => {
    // If user was in a room, clean it up or notify opponent
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.players.includes(ws)) {
            // Notify other player
            room.players.forEach(pWs => {
                if (pWs !== ws) send(pWs, { type: 'opponent_disconnected' });
            });
            delete rooms[roomId];
        }
    }
    clients.delete(ws);
    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`BattleChess Server on ${PORT}`);
});