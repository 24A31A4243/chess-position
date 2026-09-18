# Chess Position Playground

A full-stack chess website for turning a chess screenshot into an editable position and playing that exact position with a friend in real time.

## Features

- Upload a screenshot of a chess position.
- AI vision recognition converts the screenshot into FEN.
- Manual board editor for correcting any recognition mistakes.
- FEN import/export.
- Legal move validation on the server with `chess.js`.
- Create a room and share the room code.
- Friend joins the room from another browser/device.
- Real-time moves with Socket.IO.
- Resign, reset, copy FEN, and board flip.
- Responsive mobile UI.

## Requirements

- Node.js 20+
- An OpenAI API key for screenshot recognition.

## Run locally

```bash
npm install
cp .env.example .env
# put your API key into .env
npm run dev
```

Open `http://localhost:5173`.

The Vite frontend proxies `/api` and `/socket.io` to the Node server during development.

## Screenshot recognition

The browser sends the image to the server. The server keeps the API key private and sends the image to a vision-capable model. The model is instructed to identify the 8x8 board, map pieces to FEN symbols, determine the side to move when possible, and return JSON.

Because screenshot recognition can occasionally be uncertain, the detected position is always opened in the manual editor before a room is created.

## Production

Build the client:

```bash
npm run build
```

Then start the server:

```bash
npm start
```

Set `CLIENT_ORIGIN` to your deployed frontend origin if frontend and server are on different domains. For a single-server deployment, serve `client/dist` from your preferred static host and point Socket.IO to the server.

## Important deployment note

The room store is intentionally in memory for this starter. For multiple server instances, replace the in-memory room map with Redis or another shared store and use the Socket.IO Redis adapter.
