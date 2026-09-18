import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import OpenAI from 'openai';
import { Chess } from 'chess.js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-5.6-luna';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '12mb' }));

const rooms = new Map();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function roomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function cleanFen(fen) {
  const value = String(fen || '').trim();
  const fields = value.split(/\s+/);
  if (fields.length === 1) return `${value} w - - 0 1`;
  while (fields.length < 6) fields.push(fields.length === 1 ? 'w' : fields.length === 2 ? '-' : fields.length === 3 ? '-' : '0');
  return fields.slice(0, 6).join(' ');
}

function validFen(fen) {
  try {
    new Chess(cleanFen(fen));
    return true;
  } catch {
    return false;
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    fen: room.chess.fen(),
    history: room.history,
    players: {
      white: Boolean(room.players.white),
      black: Boolean(room.players.black),
    },
    status: room.status,
    createdAt: room.createdAt,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, visionConfigured: Boolean(openai) });
});

app.post('/api/recognize-position', async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({
        error: 'Screenshot recognition is not configured. Add OPENAI_API_KEY to .env.',
      });
    }

    const image = req.body?.image;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Send an image as a data URL.' });
    }

    const response = await openai.responses.create({
      model: VISION_MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `You are a chess-board position extraction engine. Analyze the uploaded screenshot.

Find the actual 8x8 chessboard, ignoring social-media overlays, captions, buttons, usernames, icons, and surrounding UI.
Determine every occupied square and the piece on it. Use standard FEN piece letters: KQ R B N for white and kq r b n for black.
Determine board orientation from the board coordinates or piece arrangement when possible. If the screenshot does not provide enough evidence for the side to move, use "w" but mark confidence lower.
Return ONLY valid JSON with exactly these keys:
{
  "fen": "full six-field FEN",
  "confidence": 0.0,
  "notes": "short explanation of any uncertain squares or orientation"
}

Rules:
- The FEN must have exactly 8 ranks and six fields.
- Preserve empty squares using digits.
- Use legal-looking castling rights if visible; otherwise use '-'.
- En-passant should be '-' unless it is clearly inferable.
- Halfmove/fullmove can be 0/1 when unknown.
- Never invent pieces hidden outside the board.
- If a square is genuinely unclear, make your best visual guess and explain it in notes.`,
            },
            { type: 'input_image', image_url: image, detail: 'high' },
          ],
        },
      ],
    });

    const raw = response.output_text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Vision model did not return JSON.');
      parsed = JSON.parse(match[0]);
    }

    const fen = cleanFen(parsed.fen);
    if (!validFen(fen)) throw new Error(`Vision model returned an invalid FEN: ${fen}`);

    res.json({ fen, confidence: Number(parsed.confidence) || 0, notes: parsed.notes || '' });
  } catch (error) {
    console.error('recognize-position error:', error);
    res.status(500).json({ error: error?.message || 'Could not recognize the chess position.' });
  }
});

app.post('/api/validate-fen', (req, res) => {
  const fen = cleanFen(req.body?.fen);
  try {
    const chess = new Chess(fen);
    res.json({ ok: true, fen: chess.fen(), turn: chess.turn() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

io.on('connection', (socket) => {
  socket.on('create-room', ({ fen }, callback) => {
    const clean = cleanFen(fen || START_FEN);
    if (!validFen(clean)) return callback?.({ ok: false, error: 'Invalid starting position.' });

    const code = roomCode();
    const chess = new Chess(clean);
    const room = {
      code,
      chess,
      history: [],
      players: { white: socket.id, black: null },
      status: 'waiting',
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;
    socket.data.color = 'w';
    callback?.({ ok: true, code, color: 'w', state: serializeRoom(room) });
    io.to(code).emit('room-state', serializeRoom(room));
  });

  socket.on('join-room', ({ code }, callback) => {
    const normalized = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) return callback?.({ ok: false, error: 'Room not found. Check the code.' });

    let color;
    if (!room.players.white) color = 'w';
    else if (!room.players.black) color = 'b';
    else return callback?.({ ok: false, error: 'That room already has two players.' });

    room.players[color === 'w' ? 'white' : 'black'] = socket.id;
    room.status = 'playing';
    socket.join(normalized);
    socket.data.room = normalized;
    socket.data.color = color;

    callback?.({ ok: true, code: normalized, color, state: serializeRoom(room) });
    io.to(normalized).emit('room-state', serializeRoom(room));
  });

  socket.on('make-move', ({ from, to, promotion }, callback) => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return callback?.({ ok: false, error: 'You are not in a room.' });
    if (!room.players.white || !room.players.black) return callback?.({ ok: false, error: 'Waiting for the second player.' });
    if (socket.data.color !== room.chess.turn()) return callback?.({ ok: false, error: 'It is not your turn.' });

    try {
      const move = room.chess.move({ from, to, promotion: promotion || 'q' });
      room.history.push({
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
      });
      if (room.chess.isGameOver()) room.status = 'finished';
      const state = serializeRoom(room);
      callback?.({ ok: true, move, state });
      io.to(code).emit('move-made', { move, state });
    } catch (error) {
      callback?.({ ok: false, error: 'Illegal move.' });
    }
  });

  socket.on('resign', (callback) => {
    const room = rooms.get(socket.data.room);
    if (!room || !socket.data.color) return callback?.({ ok: false });
    room.status = socket.data.color === 'w' ? 'black-won-by-resignation' : 'white-won-by-resignation';
    io.to(room.code).emit('room-state', serializeRoom(room));
    callback?.({ ok: true });
  });

  socket.on('reset-room', ({ fen }, callback) => {
    const room = rooms.get(socket.data.room);
    if (!room) return callback?.({ ok: false, error: 'Room not found.' });
    if (socket.data.color !== 'w') return callback?.({ ok: false, error: 'Only White can reset the room.' });
    const clean = cleanFen(fen || START_FEN);
    if (!validFen(clean)) return callback?.({ ok: false, error: 'Invalid FEN.' });
    room.chess = new Chess(clean);
    room.history = [];
    room.status = room.players.black ? 'playing' : 'waiting';
    io.to(room.code).emit('room-state', serializeRoom(room));
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    if (room.players.white === socket.id) room.players.white = null;
    if (room.players.black === socket.id) room.players.black = null;
    if (!room.players.white && !room.players.black) {
      rooms.delete(code);
    } else {
      room.status = 'waiting';
      io.to(code).emit('room-state', serializeRoom(room));
    }
  });
});

// Serve the built frontend when it exists.
const clientDist = path.resolve(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (error) => {
    if (error) next();
  });
});

server.listen(PORT, () => {
  console.log(`Chess server listening on http://localhost:${PORT}`);
});
