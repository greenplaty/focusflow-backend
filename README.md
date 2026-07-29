# focusflow-backend

Tiny Node.js backend that powers the FocusFlow Chrome extension's AI
coach feature. No framework — plain `http` module.

## Endpoints

- `GET /` — health check, reports whether an AI key is loaded.
- `POST /coach` — body: `{ task, firstStep, category, question }`.
  Returns `{ response }` with a short coaching reply generated via the
  OpenAI API.

## Setup

```
npm install
cp .env.example .env   # then fill in AI_API_KEY
npm start
```

Server runs on port 3000.

## Environment variables

- `AI_API_KEY` — your OpenAI API key. Never commit this.
- `AI_MODEL` — defaults to `gpt-4o-mini`.

## Deploying

For the Chrome extension to work for anyone other than you, this needs
to run somewhere other than your laptop (Render, Railway, Fly.io, etc.).
Once deployed, update the `fetch` URL in the extension's `focus.js` from
`http://localhost:3000/coach` to your deployed URL, and add that URL to
`host_permissions` in `manifest.json`.
