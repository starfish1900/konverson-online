const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- GAME LOGIC (Shared) ---
const DEFAULT_BOARD_SIZE = 13;
const ALLOWED_SIZES = [9, 11, 13, 15]; 
const COLORS = ['A', 'B', 'C', 'D'];
const TEAMS = {
    'A': 'AC', 'C': 'AC', // Player 1
    'B': 'BD', 'D': 'BD'  // Player 2
};
const PAWN_NEW = 'new';
const PAWN_OLD = 'old';

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ZONE_INTERIOR = 0; const ZONE_PREBORDER = 1; const ZONE_BORDER = 2; const ZONE_CORNER = 3;

class Pawn {
    constructor(color, posture = PAWN_NEW) {
        this.color = color;
        this.posture = posture;
        this.id = Math.random().toString(36).substr(2, 9);
        this.prevColor = null; 
    }
}

class GameState {
    constructor(size = DEFAULT_BOARD_SIZE) {
        this.size = size;
        this.grid = Array(size).fill(null).map(() => Array(size).fill(null));
        this.turnIndex = 0; 
        this.placementsLeft = 1;
        this.isFirstMoveOfMatch = true;
        this.firstPawnLoc = null;
        this.winner = null;
        this.winningPath = null;
    }

    getCurrentColor() { return COLORS[this.turnIndex]; }

    getZone(r, c) {
        const last = this.size - 1;
        if ((r===0 && c===0) || (r===0 && c===last) || (r===last && c===0) || (r===last && c===last)) return ZONE_CORNER;
        if (r===0 || r===last || c===0 || c===last) return ZONE_BORDER;
        if (r===1 || r===last-1 || c===1 || c===last-1) return ZONE_PREBORDER;
        return ZONE_INTERIOR;
    }

    hasNeighbor(r, c, zoneType = null) {
        for (let d of DIRS) {
            const nr = r + d[0], nc = c + d[1];
            if (nr >= 0 && nr < this.size && nc >= 0 && nc < this.size) {
                if (this.grid[nr][nc]) {
                    if (zoneType === null) return true;
                    if (this.getZone(nr, nc) === zoneType) return true;
                }
            }
        }
        return false;
    }

    hasDiagonalPreborderNeighbor(r, c) {
        const dr = (r === 0) ? 1 : -1; const dc = (c === 0) ? 1 : -1;
        const nr = r + dr; const nc = c + dc;
        return (this.grid[nr][nc] !== null);
    }

    isValidMove(r, c) {
        if (this.winner) return false;
        if (this.grid[r][c] !== null) return false; 
        if (this.firstPawnLoc) {
            const dist = Math.max(Math.abs(r - this.firstPawnLoc.r), Math.abs(c - this.firstPawnLoc.c));
            if (dist < 3) return false;
        }
        const zone = this.getZone(r, c);
        if (zone === ZONE_INTERIOR) return true;
        if (zone === ZONE_PREBORDER) return this.hasNeighbor(r, c, ZONE_INTERIOR);
        if (zone === ZONE_BORDER) return this.hasNeighbor(r, c, ZONE_PREBORDER);
        if (zone === ZONE_CORNER) return this.hasDiagonalPreborderNeighbor(r, c);
        return false;
    }

    clearConversionFlags() {
        for(let r=0; r<this.size; r++) {
            for(let c=0; c<this.size; c++) {
                if (this.grid[r][c]) delete this.grid[r][c].convertedRecently;
            }
        }
    }

    placePawn(r, c) {
        if (!this.isValidMove(r, c)) return false;
        this.clearConversionFlags();
        const color = this.getCurrentColor();
        this.grid[r][c] = new Pawn(color, PAWN_NEW);
        this.performConversions(r, c, color);
        if (this.checkWin(color)) { this.winner = color; return true; }
        this.placementsLeft--;
        if (this.placementsLeft === 0) {
            this.endTurn();
        } else {
            this.firstPawnLoc = {r, c};
            let possible = false;
            for(let rr=0; rr<this.size; rr++) {
                for(let cc=0; cc<this.size; cc++) {
                    if (this.isValidMove(rr, cc)) { possible = true; break; }
                }
                if(possible) break;
            }
            if (!possible) this.endTurn();
        }
        return true;
    }

    performConversions(r, c, myColor) {
        for (let d of DIRS) {
            const path = [];
            let currR = r + d[0], currC = c + d[1];
            let foundPincer = false;
            let lineEnemyColor = null; // Track the specific color being captured

            while (currR >= 0 && currR < this.size && currC >= 0 && currC < this.size) {
                const p = this.grid[currR][currC];
                if (!p) break;
                
                if (p.color === myColor) {
                    foundPincer = true;
                    break;
                }
                
                if (p.posture === PAWN_NEW) break;
                
                // NEW: Ensure all pawns in the line are of the exact same color
                if (lineEnemyColor === null) {
                    lineEnemyColor = p.color;
                } else if (p.color !== lineEnemyColor) {
                    break; // Line contains mixed colors, invalid capture
                }

                path.push({r: currR, c: currC, pawn: p});
                currR += d[0];
                currC += d[1];
            }

            if (foundPincer && path.length > 0) {
                for (let item of path) {
                    item.pawn.prevColor = item.pawn.color; 
                    item.pawn.color = myColor;
                    item.pawn.convertedRecently = true;
                }
            }
        }
    }

    endTurn() {
        this.isFirstMoveOfMatch = false;
        this.turnIndex = (this.turnIndex + 1) % 4;
        const nextColor = COLORS[this.turnIndex];
        for(let r=0; r<this.size; r++) {
            for(let c=0; c<this.size; c++) {
                const p = this.grid[r][c];
                if (p && p.color === nextColor && p.posture === PAWN_NEW) p.posture = PAWN_OLD;
            }
        }
        this.placementsLeft = 2;
        this.firstPawnLoc = null;
        let possible = false;
        for(let rr=0; rr<this.size; rr++) {
            for(let cc=0; cc<this.size; cc++) {
                if (this.isValidMove(rr, cc)) { possible = true; break; }
            }
            if(possible) break;
        }
        if (!possible) this.winner = 'Draw';
    }

    checkWin(color) {
        let startNodesNS = [];
        for(let c=1; c<this.size-1; c++) {
            if(this.grid[0][c] && this.grid[0][c].color === color) startNodesNS.push({r:0, c:c});
        }
        let path = this.bfsConnection(startNodesNS, color, 'NS');
        if (path) { this.winningPath = path; return true; }
        let startNodesWE = [];
        for(let r=1; r<this.size-1; r++) {
            if(this.grid[r][0] && this.grid[r][0].color === color) startNodesWE.push({r:r, c:0});
        }
        path = this.bfsConnection(startNodesWE, color, 'WE');
        if (path) { this.winningPath = path; return true; }
        return false;
    }

    bfsConnection(startNodes, color, type) {
        let queue = [], visited = new Set(), parentMap = new Map();
        for (let node of startNodes) {
            queue.push(node);
            visited.add(`${node.r},${node.c}`);
            parentMap.set(`${node.r},${node.c}`, null);
        }
        let head = 0;
        while(head < queue.length) {
            const curr = queue[head++];
            if ((type === 'NS' && curr.r === this.size - 1) || (type === 'WE' && curr.c === this.size - 1)) {
                let path = [], currKey = `${curr.r},${curr.c}`;
                while (currKey) {
                    const [r, c] = currKey.split(',').map(Number);
                    path.push({r, c});
                    const parent = parentMap.get(currKey);
                    currKey = parent ? `${parent.r},${parent.c}` : null;
                }
                return path;
            }
            for(let d of DIRS) {
                const nr = curr.r + d[0], nc = curr.c + d[1];
                if (this.getZone(nr, nc) === ZONE_CORNER) continue;
                if (nr >= 0 && nr < this.size && nc >= 0 && nc < this.size) {
                    const key = `${nr},${nc}`;
                    if (!visited.has(key)) {
                        const p = this.grid[nr][nc];
                        if (p && p.color === color) {
                            visited.add(key);
                            parentMap.set(key, {r: curr.r, c: curr.c});
                            queue.push({r:nr, c:nc});
                        }
                    }
                }
            }
        }
        return null;
    }
}

// --- SERVER ROOM & SESSION MANAGEMENT ---

const rooms = {}; 
const roomCleanupTimers = {}; // Map roomId -> timeout

// Auth Middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("invalid token"));
    socket.playerId = token;
    next();
});

// Helper: Broadcast Lobby State
function broadcastLobbyState() {
    const openGames = [];
    const activeGames = [];

    for (const [id, room] of Object.entries(rooms)) {
        const info = {
            id,
            size: room.gameState.size,
            players: room.players,
            playerCount: room.players.length,
            spectatorCount: room.spectators.length,
            winner: room.gameState.winner
        };

        if (room.gameState.winner) activeGames.push(info);
        else if (room.players.length < 2) openGames.push(info);
        else activeGames.push(info);
    }

    io.to('lobby').emit('lobby_update', { openGames, activeGames });
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.playerId} (${socket.id})`);

    socket.join('lobby');
    broadcastLobbyState(); 

    // Create Game
    socket.on('create_game', ({ size }) => {
        const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
        let requestedSize = parseInt(size);
        if (!ALLOWED_SIZES.includes(requestedSize)) requestedSize = DEFAULT_BOARD_SIZE;

        rooms[roomId] = {
            gameState: new GameState(requestedSize),
            players: [socket.playerId],
            spectators: []
        };
        
        socket.leave('lobby'); 
        socket.join(roomId);
        
        socket.emit('game_created', { 
            roomId, 
            team: 'AC', 
            gameState: rooms[roomId].gameState 
        });
        
        broadcastLobbyState(); 
        console.log(`Room ${roomId} created by ${socket.playerId}`);
    });

    // Join Game
    socket.on('join_game', (roomId) => {
        roomId = roomId.toUpperCase();
        const room = rooms[roomId];
        const playerId = socket.playerId;
        
        if (room) {
            // Cancel any pending cleanup for this room since someone joined
            if (roomCleanupTimers[roomId]) {
                clearTimeout(roomCleanupTimers[roomId]);
                delete roomCleanupTimers[roomId];
                console.log(`Cleanup cancelled for ${roomId}`);
            }

            socket.leave('lobby'); 
            socket.join(roomId);
            
            let team = 'spectator';
            const existingPlayerIndex = room.players.indexOf(playerId);
            
            if (existingPlayerIndex !== -1) {
                team = existingPlayerIndex === 0 ? 'AC' : 'BD';
                console.log(`User ${playerId} reconnected to ${roomId}`);
            } 
            else if (room.players.length < 2) {
                room.players.push(playerId);
                team = 'BD';
                console.log(`User ${playerId} joined ${roomId}`);
            } 
            else {
                if (!room.spectators.includes(playerId)) room.spectators.push(playerId);
            }

            socket.emit('game_joined', { 
                roomId, 
                team, 
                gameState: room.gameState 
            });

            if (room.players.length === 2 && !room.gameState.winner) {
                io.to(roomId).emit('message', "Game Active: AC vs BD");
                io.to(roomId).emit('state_update', room.gameState);
            }
            
            broadcastLobbyState(); 
        } else {
            socket.emit('error_message', 'Room not found.');
        }
    });

    socket.on('leave_game', (roomId) => {
        socket.leave(roomId);
        socket.join('lobby');
        // Trigger checkEmptyRoom logic manually if needed, or rely on disconnect logic/timeouts
        // For simplicity, we just broadcast. The disconnect logic below handles "real" drops.
        broadcastLobbyState();
    });

    socket.on('make_move', ({ roomId, r, c }) => {
        const room = rooms[roomId];
        if (!room) return;
        const game = room.gameState;
        if (game.winner) return;

        const currentColor = game.getCurrentColor();
        const currentTeam = TEAMS[currentColor];
        const playerIndex = currentTeam === 'AC' ? 0 : 1;
        
        if (socket.playerId !== room.players[playerIndex]) {
            socket.emit('error_message', "It is not your turn!");
            return;
        }

        if (game.placePawn(r, c)) {
            io.to(roomId).emit('state_update', game);
            if (game.winner) {
                io.to(roomId).emit('game_over', game.winner);
                broadcastLobbyState(); 
            }
        } else {
            socket.emit('error_message', "Invalid Move");
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.playerId}`);
        
        // Remove from spectators immediately to keep counts accurate
        for (const [id, room] of Object.entries(rooms)) {
            const specIdx = room.spectators.indexOf(socket.playerId);
            if (specIdx !== -1) {
                room.spectators.splice(specIdx, 1);
            }
            
            // Check if Room is now "Empty" (no connected sockets)
            const roomSockets = io.sockets.adapter.rooms.get(id);
            if (!roomSockets || roomSockets.size === 0) {
                // If already scheduled, don't double schedule
                if (!roomCleanupTimers[id]) {
                    console.log(`Room ${id} is empty. Scheduling cleanup in 10s...`);
                    roomCleanupTimers[id] = setTimeout(() => {
                        // Double check emptiness
                        const s = io.sockets.adapter.rooms.get(id);
                        if (!s || s.size === 0) {
                            delete rooms[id];
                            delete roomCleanupTimers[id];
                            console.log(`Room ${id} deleted due to inactivity.`);
                            broadcastLobbyState();
                        }
                    }, 10000); // 10 seconds grace period for refresh/reconnect
                }
            }
        }
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
