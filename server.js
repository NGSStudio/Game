const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// เก็บข้อมูลห้องและผู้เล่น
const rooms = new Map();
const players = new Map();

// ให้บริการไฟล์ static
app.use(express.static(path.join(__dirname, 'public')));

// เส้นทางหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API สำหรับตรวจสอบสถานะเซิร์ฟเวอร์
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        rooms: rooms.size,
        players: players.size,
        timestamp: new Date().toISOString()
    });
});

// การจัดการ WebSocket
io.on('connection', (socket) => {
    console.log('ผู้ใช้เชื่อมต่อ:', socket.id);
    
    // ส่ง ID ให้ผู้ใช้
    socket.emit('connected', { playerId: socket.id });
    
    // สร้างห้องใหม่
    socket.on('create_room', (data) => {
        const roomCode = generateRoomCode();
        const room = {
            code: roomCode,
            players: [{
                id: socket.id,
                name: data.playerName,
                color: 'white'
            }],
            gameState: 'waiting',
            spectators: [],
            chessGame: createNewGame()
        };
        
        rooms.set(roomCode, room);
        players.set(socket.id, { 
            roomCode, 
            color: 'white', 
            name: data.playerName 
        });
        
        socket.join(roomCode);
        socket.emit('room_created', { 
            roomCode,
            color: 'white'
        });
        
        console.log(`สร้างห้อง ${roomCode} โดย ${data.playerName}`);
    });
    
    // เข้าร่วมห้อง
    socket.on('join_room', (data) => {
        const room = rooms.get(data.roomCode);
        
        if (!room) {
            socket.emit('join_failed', { message: 'ไม่พบห้อง' });
            return;
        }
        
        if (room.players.length >= 2) {
            // เข้าร่วมเป็นผู้ชม
            room.spectators.push({
                id: socket.id,
                name: data.playerName
            });
            
            players.set(socket.id, { 
                roomCode: data.roomCode, 
                color: 'spectator', 
                name: data.playerName 
            });
            
            socket.join(data.roomCode);
            socket.emit('joined_as_spectator', { 
                roomCode: data.roomCode 
            });
            
            // ส่งสถานะเกมปัจจุบันให้ผู้ชม
            socket.emit('game_state_update', {
                board: room.chessGame.board,
                currentPlayer: room.chessGame.currentPlayer,
                moveHistory: room.chessGame.moveHistory
            });
            
            console.log(`${data.playerName} เข้าร่วมห้อง ${data.roomCode} เป็นผู้ชม`);
        } else {
            // เข้าร่วมเป็นผู้เล่น
            room.players.push({
                id: socket.id,
                name: data.playerName,
                color: 'black'
            });
            
            players.set(socket.id, { 
                roomCode: data.roomCode, 
                color: 'black', 
                name: data.playerName 
            });
            
            socket.join(data.roomCode);
            socket.emit('joined_room', { 
                roomCode: data.roomCode, 
                color: 'black' 
            });
            
            // แจ้งเตือนผู้เล่นคนแรก
            const firstPlayer = room.players[0];
            io.to(firstPlayer.id).emit('opponent_joined', { 
                opponentName: data.playerName 
            });
            
            // เริ่มเกม
            room.gameState = 'playing';
            io.to(data.roomCode).emit('game_started');
            
            // ส่งสถานะเกมให้ผู้เล่นทั้งสอง
            io.to(data.roomCode).emit('game_state_update', {
                board: room.chessGame.board,
                currentPlayer: room.chessGame.currentPlayer,
                moveHistory: room.chessGame.moveHistory
            });
            
            console.log(`${data.playerName} เข้าร่วมห้อง ${data.roomCode} เป็นผู้เล่นดำ`);
        }
    });
    
    // ส่งการเคลื่อนไหว
    socket.on('make_move', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomCode);
        if (!room || room.gameState !== 'playing') return;
        
        // ตรวจสอบว่าเป็นตาของผู้เล่นนี้
        if (room.chessGame.currentPlayer !== player.color) {
            socket.emit('invalid_move', { message: 'ยังไม่ใช่ตาของคุณ' });
            return;
        }
        
        // พยายามเดินหมาก
        const moveSuccessful = room.chessGame.makeMove(
            data.move.fromRow,
            data.move.fromCol,
            data.move.toRow,
            data.move.toCol,
            data.move.promotion || 'queen'
        );
        
        if (moveSuccessful) {
            // ส่งการเคลื่อนไหวไปยังทุกคนในห้อง
            io.to(player.roomCode).emit('move_made', {
                move: data.move,
                playerId: socket.id,
                playerName: player.name,
                newBoard: room.chessGame.board,
                currentPlayer: room.chessGame.currentPlayer,
                check: room.chessGame.check,
                checkmate: room.chessGame.checkmate,
                stalemate: room.chessGame.stalemate
            });
            
            // เพิ่มประวัติการเดิน
            room.chessGame.moveHistory.push({
                from: { row: data.move.fromRow, col: data.move.fromCol },
                to: { row: data.move.toRow, col: data.move.toCol },
                piece: data.move.piece,
                promotion: data.move.promotion,
                player: player.name,
                timestamp: new Date()
            });
            
            console.log(`การเคลื่อนไหวในห้อง ${player.roomCode} โดย ${player.name}`);
            
            // ตรวจสอบการจบเกม
            if (room.chessGame.checkmate || room.chessGame.stalemate) {
                room.gameState = 'finished';
                let result = '';
                
                if (room.chessGame.checkmate) {
                    result = `เช็คเมท! ${player.name} ชนะ`;
                } else {
                    result = 'เสมอ!';
                }
                
                io.to(player.roomCode).emit('game_ended', {
                    result: result,
                    winner: room.chessGame.checkmate ? player.color : null
                });
            }
        } else {
            socket.emit('invalid_move', { message: 'การเดินไม่ถูกต้อง' });
        }
    });
    
    // ส่งข้อความแชท
    socket.on('send_message', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        // ส่งข้อความไปยังทุกคนในห้อง
        io.to(player.roomCode).emit('new_message', {
            playerName: data.playerName,
            message: data.message,
            timestamp: new Date()
        });
    });
    
    // เสนอการเสมอ
    socket.on('offer_draw', () => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomCode);
        if (!room) return;
        
        // ส่งข้อเสนอไปยังผู้เล่นอีกฝ่าย
        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent) {
            io.to(opponent.id).emit('draw_offered', {
                playerName: player.name
            });
        }
    });
    
    // ตอบรับการเสมอ
    socket.on('accept_draw', () => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomCode);
        if (!room) return;
        
        // จบเกมแบบเสมอ
        room.gameState = 'finished';
        io.to(player.roomCode).emit('game_ended', {
            result: 'เสมอโดยข้อตกลง',
            winner: null
        });
    });
    
    // ยอมแพ้
    socket.on('resign', () => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomCode);
        if (!room) return;
        
        // หาผู้ชนะ (ฝ่ายตรงข้าม)
        const winner = room.players.find(p => p.id !== socket.id);
        room.gameState = 'finished';
        
        io.to(player.roomCode).emit('game_ended', {
            result: `${player.name} ยอมแพ้`,
            winner: winner ? winner.color : null,
            winnerName: winner ? winner.name : null
        });
    });
    
    // ขอสถานะเกมปัจจุบัน
    socket.on('request_game_state', () => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomCode);
        if (!room) return;
        
        socket.emit('game_state_update', {
            board: room.chessGame.board,
            currentPlayer: room.chessGame.currentPlayer,
            moveHistory: room.chessGame.moveHistory,
            check: room.chessGame.check,
            checkmate: room.chessGame.checkmate,
            stalemate: room.chessGame.stalemate
        });
    });
    
    // เริ่มเกมใหม่
    socket.on('restart_game', () => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomCode);
        if (!room) return;
        
        // รีเซ็ตเกม
        room.chessGame = createNewGame();
        room.gameState = 'playing';
        
        io.to(player.roomCode).emit('game_restarted', {
            board: room.chessGame.board,
            currentPlayer: room.chessGame.currentPlayer
        });
    });
    
    // ตัดการเชื่อมต่อ
    socket.on('disconnect', () => {
        console.log('ผู้ใช้ตัดการเชื่อมต่อ:', socket.id);
        
        const player = players.get(socket.id);
        if (player) {
            const room = rooms.get(player.roomCode);
            if (room) {
                // ลบผู้เล่นออกจากห้อง
                room.players = room.players.filter(p => p.id !== socket.id);
                room.spectators = room.spectators.filter(s => s.id !== socket.id);
                
                // แจ้งเตือนผู้เล่นที่เหลือ
                socket.to(player.roomCode).emit('player_left', { 
                    playerName: player.name 
                });
                
                // ถ้าห้องว่าง ให้ลบห้อง
                if (room.players.length === 0 && room.spectators.length === 0) {
                    rooms.delete(player.roomCode);
                    console.log(`ลบห้อง ${player.roomCode}`);
                } else if (room.players.length === 1 && room.gameState === 'playing') {
                    // ถ้ามีผู้เล่นเหลือคนเดียว ให้จบเกม
                    room.gameState = 'finished';
                    const remainingPlayer = room.players[0];
                    io.to(player.roomCode).emit('game_ended', {
                        result: 'ผู้เล่นอีกฝ่ายออกจากเกม',
                        winner: remainingPlayer.color,
                        winnerName: remainingPlayer.name
                    });
                }
            }
            
            players.delete(socket.id);
        }
    });
});

// สร้างรหัสห้อง
function generateRoomCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// สร้างเกมหมากรุกใหม่
function createNewGame() {
    return {
        board: createInitialBoard(),
        currentPlayer: 'white',
        moveHistory: [],
        castlingRights: {
            white: { kingSide: true, queenSide: true },
            black: { kingSide: true, queenSide: true }
        },
        enPassantTarget: null,
        check: false,
        checkmate: false,
        stalemate: false,
        
        // ฟังก์ชันพื้นฐานของเกมหมากรุก
        makeMove(fromRow, fromCol, toRow, toCol, promotionType = 'queen') {
            // ตรวจสอบการเดินเบื้องต้น
            const piece = this.board[fromRow][fromCol];
            if (!piece || piece.color !== this.currentPlayer) return false;
            
            // จำลองการเดิน (ในเกมจริงต้องมีตรรกะที่ซับซ้อนกว่านี้)
            this.board[toRow][toCol] = this.board[fromRow][fromCol];
            this.board[fromRow][fromCol] = null;
            
            // การเลื่อนเบี้ย
            if (piece.type === 'pawn' && (toRow === 0 || toRow === 7)) {
                this.board[toRow][toCol].type = promotionType;
            }
            
            // สลับผู้เล่น
            this.currentPlayer = this.currentPlayer === 'white' ? 'black' : 'white';
            
            // อัพเดทสถานะเช็ค (ในเกมจริงต้องคำนวณ)
            this.check = false;
            this.checkmate = false;
            this.stalemate = false;
            
            return true;
        }
    };
}

// สร้างกระดานเริ่มต้น
function createInitialBoard() {
    const board = Array(8).fill().map(() => Array(8).fill(null));
    
    // ตั้งค่าหมากเริ่มต้น
    // แถวที่ 1 (ขาว)
    board[0][0] = { type: 'rook', color: 'white', hasMoved: false };
    board[0][1] = { type: 'knight', color: 'white', hasMoved: false };
    board[0][2] = { type: 'bishop', color: 'white', hasMoved: false };
    board[0][3] = { type: 'queen', color: 'white', hasMoved: false };
    board[0][4] = { type: 'king', color: 'white', hasMoved: false };
    board[0][5] = { type: 'bishop', color: 'white', hasMoved: false };
    board[0][6] = { type: 'knight', color: 'white', hasMoved: false };
    board[0][7] = { type: 'rook', color: 'white', hasMoved: false };
    
    // แถวที่ 2 (เบี้ยขาว)
    for (let i = 0; i < 8; i++) {
        board[1][i] = { type: 'pawn', color: 'white', hasMoved: false };
    }
    
    // แถวที่ 7 (เบี้ยดำ)
    for (let i = 0; i < 8; i++) {
        board[6][i] = { type: 'pawn', color: 'black', hasMoved: false };
    }
    
    // แถวที่ 8 (ดำ)
    board[7][0] = { type: 'rook', color: 'black', hasMoved: false };
    board[7][1] = { type: 'knight', color: 'black', hasMoved: false };
    board[7][2] = { type: 'bishop', color: 'black', hasMoved: false };
    board[7][3] = { type: 'queen', color: 'black', hasMoved: false };
    board[7][4] = { type: 'king', color: 'black', hasMoved: false };
    board[7][5] = { type: 'bishop', color: 'black', hasMoved: false };
    board[7][6] = { type: 'knight', color: 'black', hasMoved: false };
    board[7][7] = { type: 'rook', color: 'black', hasMoved: false };
    
    return board;
}

// เริ่มเซิร์ฟเวอร์
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 เซิร์ฟเวอร์กำลังทำงานบนพอร์ต ${PORT}`);
    console.log(`🌐 เปิดเบราว์เซอร์และไปที่: http://localhost:${PORT}`);
    console.log(`📊 ตรวจสอบสถานะเซิร์ฟเวอร์: http://localhost:${PORT}/status`);
});