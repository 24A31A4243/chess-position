# Deployment

## Render / Railway / Fly.io style single service

1. Set the start command to `npm start`.
2. Set `OPENAI_API_KEY` as a secret.
3. Set `CLIENT_ORIGIN` to the public URL.
4. Build with `npm run build` before starting, or use a build command `npm install && npm run build`.

The Node server serves `client/dist` after a production build and hosts Socket.IO on the same origin.

## Security checklist before public launch

- Add authentication or signed room ownership if rooms need privacy.
- Add rate limiting to `/api/recognize-position`.
- Restrict upload size and MIME types more aggressively.
- Add persistent/shared room storage if using more than one server instance.
- Add abuse controls and monitoring around AI image recognition.
- Never expose `OPENAI_API_KEY` to browser code.
