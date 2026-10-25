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

const CLIENT_ORIGINS = (
  process.env.CLIENT_ORIGIN ||
  'http://localhost:5173,http://localhost:5174'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function allowOrigin(origin, callback) {
  if (!origin) {
    return callback(null, true);
  }

  if (
    CLIENT_ORIGINS.includes(origin) ||
    /^http:\/\/localhost:\d+$/.test(origin)
  ) {
    return callback(null, true);
  }

  return callback(new Error('Origin not allowed by CORS'));
}

const VISION_MODEL =
  process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors({ origin: allowOrigin, credentials: true }));

app.use(express.json({ limit: '12mb' }));

const rooms = new Map();

/*
 * Gemini through Google's OpenAI-compatible API.
 */
const openai = process.env.GEMINI_API_KEY
  ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
    })
  : null;

const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/* -------------------------------------------------------
   Helper functions
------------------------------------------------------- */

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

  if (fields.length === 1) {
    return `${value} w - - 0 1`;
  }

  while (fields.length < 6) {
    if (fields.length === 1) {
      fields.push('w');
    } else if (fields.length === 2) {
      fields.push('-');
    } else if (fields.length === 3) {
      fields.push('-');
    } else {
      fields.push('0');
    }
  }

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

/* -------------------------------------------------------
   Health check
------------------------------------------------------- */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    visionConfigured: Boolean(openai),
    visionModel: VISION_MODEL,
  });
});

/* -------------------------------------------------------
   Recognize chess position from screenshot
------------------------------------------------------- */

app.post('/api/recognize-position', async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({
        error:
          'Screenshot recognition is not configured. Add GEMINI_API_KEY to .env.',
      });
    }

    const image = req.body?.image;

    if (
      typeof image !== 'string' ||
      !image.startsWith('data:image/')
    ) {
      return res.status(400).json({
        error: 'Send an image as a data URL.',
      });
    }

    const prompt = `
You are a chess-board position extraction engine.

Analyze the uploaded screenshot.

Find the actual 8x8 chessboard, ignoring:
- social-media overlays
- captions
- buttons
- usernames
- icons
- surrounding UI
- browser controls

Determine every occupied square and the piece on it.

Use standard FEN piece letters:

White:
K = King
Q = Queen
R = Rook
B = Bishop
N = Knight
P = Pawn

Black:
k = King
q = Queen
r = Rook
b = Bishop
n = Knight
p = Pawn

Determine board orientation from board coordinates or piece arrangement when possible.

If the screenshot does not provide enough evidence for the side to move,
use "w" but mark confidence lower.

Return ONLY valid JSON with exactly these keys:

{
  "fen": "full six-field FEN",
  "confidence": 0.0,
  "notes": "short explanation of any uncertain squares or orientation"
}

Rules:

1. The FEN must have exactly 8 ranks and six fields.
2. Preserve empty squares using digits.
3. Use legal-looking castling rights if visible; otherwise use "-".
4. En-passant should be "-" unless it is clearly inferable.
5. Halfmove/fullmove can be 0/1 when unknown.
6. Never invent pieces hidden outside the board.
7. If a square is genuinely unclear, make your best visual guess and explain it in notes.
8. Do not return Markdown.
9. Do not return code fences.
10. Return JSON only.
`;

    /*
     * Gemini OpenAI-compatible API.
     * We use Chat Completions instead of Responses API.
     */
    const response = await openai.chat.completions.create({
      model: VISION_MODEL,

      messages: [
        {
          role: 'user',

          content: [
            {
              type: 'text',
              text: prompt,
            },

            {
              type: 'image_url',
              image_url: {
                url: image,
              },
            },
          ],
        },
      ],
    });

    const raw =
      response.choices?.[0]?.message?.content?.trim();

    if (!raw) {
      throw new Error(
        'Vision model returned an empty response.'
      );
    }

    console.log('Vision model response:', raw);

    let parsed;

    try {
      /*
       * First try to parse the response directly.
       */
      parsed = JSON.parse(raw);
    } catch {
      /*
       * Sometimes models still return ```json ... ```
       * even when instructed not to.
       */
      try {
        const cleaned = raw
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();

        parsed = JSON.parse(cleaned);
      } catch {
        /*
         * Last fallback: extract the JSON object.
         */
        const match = raw.match(/\{[\s\S]*\}/);

        if (!match) {
          throw new Error(
            'Vision model did not return valid JSON.'
          );
        }

        parsed = JSON.parse(match[0]);
      }
    }

    if (!parsed?.fen) {
      throw new Error(
        'Vision model response did not contain a FEN.'
      );
    }

    const fen = cleanFen(parsed.fen);

    if (!validFen(fen)) {
      throw new Error(
        `Vision model returned an invalid FEN: ${fen}`
      );
    }

    res.json({
      fen,
      confidence: Number(parsed.confidence) || 0,
      notes: parsed.notes || '',
    });
  } catch (error) {
    console.error(
      'recognize-position error:',
      error
    );

    res.status(500).json({
      error:
        error?.message ||
        'Could not recognize the chess position.',
    });
  }
});

/* -------------------------------------------------------
   Validate FEN
------------------------------------------------------- */

app.post('/api/validate-fen', (req, res) => {
  const fen = cleanFen(req.body?.fen);

  try {
    const chess = new Chess(fen);

    res.json({
      ok: true,
      fen: chess.fen(),
      turn: chess.turn(),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

/* -------------------------------------------------------
   Socket.IO
------------------------------------------------------- */

io.on('connection', (socket) => {
  /* ---------------------------------------------------
     Create room
  --------------------------------------------------- */

  socket.on('create-room', ({ fen }, callback) => {
    const clean = cleanFen(fen || START_FEN);

    if (!validFen(clean)) {
      return callback?.({
        ok: false,
        error: 'Invalid starting position.',
      });
    }

    const code = roomCode();

    const chess = new Chess(clean);

    const room = {
      code,
      chess,
      history: [],

      players: {
        white: socket.id,
        black: null,
      },

      status: 'waiting',
      createdAt: Date.now(),
    };

    rooms.set(code, room);

    socket.join(code);

    socket.data.room = code;
    socket.data.color = 'w';

    callback?.({
      ok: true,
      code,
      color: 'w',
      state: serializeRoom(room),
    });

    io.to(code).emit(
      'room-state',
      serializeRoom(room)
    );
  });

  /* ---------------------------------------------------
     Join room
  --------------------------------------------------- */

  socket.on('join-room', ({ code }, callback) => {
    const normalized = String(code || '')
      .trim()
      .toUpperCase();

    const room = rooms.get(normalized);

    if (!room) {
      return callback?.({
        ok: false,
        error: 'Room not found. Check the code.',
      });
    }

    let color;

    if (!room.players.white) {
      color = 'w';
    } else if (!room.players.black) {
      color = 'b';
    } else {
      return callback?.({
        ok: false,
        error: 'That room already has two players.',
      });
    }

    room.players[
      color === 'w' ? 'white' : 'black'
    ] = socket.id;

    room.status = 'playing';

    socket.join(normalized);

    socket.data.room = normalized;
    socket.data.color = color;

    callback?.({
      ok: true,
      code: normalized,
      color,
      state: serializeRoom(room),
    });

    io.to(normalized).emit(
      'room-state',
      serializeRoom(room)
    );
  });

  /* ---------------------------------------------------
     Make move
  --------------------------------------------------- */

  socket.on(
    'make-move',
    ({ from, to, promotion }, callback) => {
      const code = socket.data.room;

      const room = rooms.get(code);

      if (!room) {
        return callback?.({
          ok: false,
          error: 'You are not in a room.',
        });
      }

      if (
        !room.players.white ||
        !room.players.black
      ) {
        return callback?.({
          ok: false,
          error: 'Waiting for the second player.',
        });
      }

      if (
        socket.data.color !==
        room.chess.turn()
      ) {
        return callback?.({
          ok: false,
          error: 'It is not your turn.',
        });
      }

      try {
        const move = room.chess.move({
          from,
          to,
          promotion: promotion || 'q',
        });

        room.history.push({
          san: move.san,
          from: move.from,
          to: move.to,
          promotion: move.promotion || null,
        });

        if (room.chess.isGameOver()) {
          room.status = 'finished';
        }

        const state = serializeRoom(room);

        callback?.({
          ok: true,
          move,
          state,
        });

        io.to(code).emit(
          'move-made',
          {
            move,
            state,
          }
        );
      } catch (error) {
        callback?.({
          ok: false,
          error: 'Illegal move.',
        });
      }
    }
  );

  /* ---------------------------------------------------
     Resign
  --------------------------------------------------- */

  socket.on('resign', (callback) => {
    const room = rooms.get(
      socket.data.room
    );

    if (
      !room ||
      !socket.data.color
    ) {
      return callback?.({
        ok: false,
      });
    }

    room.status =
      socket.data.color === 'w'
        ? 'black-won-by-resignation'
        : 'white-won-by-resignation';

    io.to(room.code).emit(
      'room-state',
      serializeRoom(room)
    );

    callback?.({
      ok: true,
    });
  });

  /* ---------------------------------------------------
     Reset room
  --------------------------------------------------- */

  socket.on(
    'reset-room',
    ({ fen }, callback) => {
      const room = rooms.get(
        socket.data.room
      );

      if (!room) {
        return callback?.({
          ok: false,
          error: 'Room not found.',
        });
      }

      if (socket.data.color !== 'w') {
        return callback?.({
          ok: false,
          error:
            'Only White can reset the room.',
        });
      }

      const clean = cleanFen(
        fen || START_FEN
      );

      if (!validFen(clean)) {
        return callback?.({
          ok: false,
          error: 'Invalid FEN.',
        });
      }

      room.chess = new Chess(clean);

      room.history = [];

      room.status = room.players.black
        ? 'playing'
        : 'waiting';

      io.to(room.code).emit(
        'room-state',
        serializeRoom(room)
      );

      callback?.({
        ok: true,
      });
    }
  );

  /* ---------------------------------------------------
     Disconnect
  --------------------------------------------------- */

  socket.on('disconnect', () => {
    const code = socket.data.room;

    const room = rooms.get(code);

    if (!room) {
      return;
    }

    if (
      room.players.white === socket.id
    ) {
      room.players.white = null;
    }

    if (
      room.players.black === socket.id
    ) {
      room.players.black = null;
    }

    if (
      !room.players.white &&
      !room.players.black
    ) {
      rooms.delete(code);
    } else {
      room.status = 'waiting';

      io.to(code).emit(
        'room-state',
        serializeRoom(room)
      );
    }
  });
});

/* -------------------------------------------------------
   Serve built frontend
------------------------------------------------------- */

const clientDist = path.resolve(
  __dirname,
  '../client/dist'
);

app.use(
  express.static(clientDist)
);

app.use((req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/socket.io')
  ) {
    return next();
  }

  res.sendFile(
    path.join(
      clientDist,
      'index.html'
    ),
    (error) => {
      if (error) {
        next();
      }
    }
  );
});

/* -------------------------------------------------------
   Start server
------------------------------------------------------- */

server.listen(PORT, () => {
  console.log(
    `Chess server listening on http://localhost:${PORT}`
  );

  console.log(
    `Gemini vision model: ${VISION_MODEL}`
  );

  console.log(
    `Gemini configured: ${Boolean(openai)}`
  );
});