const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// Beispiel-Route
app.get('/', (req, res) => {
  res.send('Werwölfe Backend läuft!');
});

// --- In-Memory-Datenmodelle ---
let players = [];
let gameStatus = {
  started: false,
  phase: 'lobby', // 'lobby', 'night', 'day', 'ended'
  round: 0,
  roles: [], // z.B. ['Werwolf', 'Seherin', ...]
};
let eventLog = [];

function logEvent(event) {
  eventLog.push({ time: new Date().toISOString(), ...event });
  if (eventLog.length > 100) eventLog.shift();
  io.emit('eventLog', eventLog);
}

function assignRoles() {
  // Rollen mischen und zufällig zuweisen
  const shuffledRoles = [...gameStatus.roles].sort(() => Math.random() - 0.5);
  players.forEach((p, i) => {
    p.role = shuffledRoles[i] || 'Dorfbewohner';
    p.alive = true;
    // Rollenspezifische Attribute zurücksetzen
    p.isLover = false;
    p.healPotion = true;
    p.poisonPotion = true;
    p.special = {};
  });
}

function checkWinCondition() {
  const alive = players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role.toLowerCase().includes('werwolf'));
  const villagers = alive.filter(p => !p.role.toLowerCase().includes('werwolf'));
  if (wolves.length === 0) return 'Dorfbewohner';
  if (wolves.length >= villagers.length) return 'Werwölfe';
  return null;
}

function nextPhase() {
  if (!gameStatus.started) return;
  if (gameStatus.phase === 'night') {
    gameStatus.phase = 'day';
    logEvent({ type: 'phase', message: 'Tagphase beginnt.' });
  } else {
    gameStatus.phase = 'night';
    gameStatus.round++;
    logEvent({ type: 'phase', message: 'Nachtphase beginnt.' });
  }
  io.emit('phaseChange', gameStatus.phase);
}

// Hilfsfunktion: Lobby-Status an alle senden
function broadcastLobby() {
  io.emit('lobbyUpdate', { players, gameStatus });
}

// --- Socket.IO-Events ---
io.on('connection', (socket) => {
  console.log('Neuer Client verbunden:', socket.id);

  // Spieler registrieren
  socket.on('registerPlayer', (name, callback) => {
    if (gameStatus.started) {
      callback({ success: false, message: 'Spiel läuft bereits.' });
      return;
    }
    if (players.find(p => p.name === name)) {
      callback({ success: false, message: 'Name bereits vergeben.' });
      return;
    }
    const player = {
      id: socket.id,
      name,
      role: null,
      alive: true,
      // weitere rollenspezifische Attribute folgen später
    };
    players.push(player);
    callback({ success: true, player });
    broadcastLobby();
  });

  // Lobby-Status abfragen
  socket.on('getLobby', (callback) => {
    callback({ players, gameStatus });
  });

  // Spiel starten (nur wenn genug Spieler)
  socket.on('startGame', (roles, callback) => {
    if (gameStatus.started) {
      callback({ success: false, message: 'Spiel läuft bereits.' });
      return;
    }
    if (players.length < 5) {
      callback({ success: false, message: 'Mindestens 5 Spieler benötigt.' });
      return;
    }
    gameStatus.roles = roles;
    gameStatus.started = true;
    gameStatus.phase = 'night';
    gameStatus.round = 1;
    assignRoles();
    logEvent({ type: 'start', message: 'Spiel gestartet.' });
    broadcastLobby();
    callback({ success: true });
  });

  socket.on('nextPhase', () => {
    nextPhase();
    broadcastLobby();
    // Nach Phasenwechsel Siegbedingung prüfen
    const winner = checkWinCondition();
    if (winner) {
      gameStatus.phase = 'ended';
      logEvent({ type: 'end', message: `Das Spiel ist beendet. Gewinner: ${winner}` });
      io.emit('gameEnded', winner);
    }
  });

  // Werwolf-Opferwahl (vereinfachte Logik)
  socket.on('werewolfVote', (targetName) => {
    if (gameStatus.phase !== 'night') return;
    const target = players.find(p => p.name === targetName && p.alive);
    if (target) {
      target.alive = false;
      logEvent({ type: 'kill', message: `Werwölfe haben ${targetName} getötet.` });
      broadcastLobby();
    }
  });

  // Seherin prüft Rolle
  socket.on('seerCheck', (targetName, callback) => {
    const target = players.find(p => p.name === targetName);
    if (target) {
      callback({ role: target.role });
      logEvent({ type: 'seer', message: `Seherin hat ${targetName} geprüft.` });
    }
  });

  // Hexe heilt oder vergiftet
  socket.on('witchAction', ({ action, targetName }, callback) => {
    const witch = players.find(p => p.role === 'Hexe' && p.alive);
    if (!witch) return;
    if (action === 'heal' && witch.healPotion) {
      const target = players.find(p => p.name === targetName);
      if (target && !target.alive) {
        target.alive = true;
        witch.healPotion = false;
        logEvent({ type: 'witch', message: `Hexe hat ${targetName} geheilt.` });
        callback({ success: true });
        broadcastLobby();
        return;
      }
    }
    if (action === 'poison' && witch.poisonPotion) {
      const target = players.find(p => p.name === targetName && p.alive);
      if (target) {
        target.alive = false;
        witch.poisonPotion = false;
        logEvent({ type: 'witch', message: `Hexe hat ${targetName} vergiftet.` });
        callback({ success: true });
        broadcastLobby();
        return;
      }
    }
    callback({ success: false });
  });

  // Abstimmung am Tag (vereinfachte Logik)
  socket.on('vote', (targetName) => {
    if (gameStatus.phase !== 'day') return;
    const target = players.find(p => p.name === targetName && p.alive);
    if (target) {
      target.alive = false;
      logEvent({ type: 'vote', message: `${targetName} wurde gehängt.` });
      broadcastLobby();
    }
  });

  // Ereignis-Log anfordern
  socket.on('getEventLog', (callback) => {
    callback(eventLog);
  });

  // --- MODERATOR EVENTS ---
  // Spieler töten
  socket.on('moderatorKill', (playerName) => {
    const target = players.find(p => p.name === playerName && p.alive);
    if (target) {
      target.alive = false;
      logEvent({ type: 'moderator', message: `Moderator hat ${playerName} getötet.` });
      io.emit('lobbyUpdate', { players, gameStatus });
    }
  });

  // Trank einsetzen

  // Hier ggf. weitere Events einfügen

}); // Ende io.on('connection', ...)

// Server starten
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
