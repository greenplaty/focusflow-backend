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
- `EXTENSION_SHARED_KEY` — a random secret string. The extension sends
  this in an `X-Extension-Key` header on every `/coach` request; requests
  without a matching key are rejected with 401. Generate one with
  `python3 -c "import secrets; print(secrets.token_hex(24))"` (or any
  password generator) — it doesn't need to be memorable, just random.
  This same value must be set in the extension's code, so the two stay
  in sync.

## Security

- `/coach` requires the `X-Extension-Key` header to match
  `EXTENSION_SHARED_KEY`, so random bots/scrapers can't rack up OpenAI
  usage on your key.
- Requests are rate-limited to 20 per 10 minutes per IP.
- Since this is a plain client-side check (the key lives in the
  extension's JS, which anyone can technically read), it's not
  bulletproof against a determined attacker — but it stops casual abuse,
  which is the realistic threat for a small project like this. Pair it
  with an OpenAI spending limit (Settings → Billing → Limits) for real
  peace of mind.

## Deploying

For the Chrome extension to work for anyone other than you, this needs
to run somewhere other than your laptop (Render, Railway, Fly.io, etc.).
Once deployed:
1. Set `AI_API_KEY`, `AI_MODEL`, and `EXTENSION_SHARED_KEY` as
   environment variables on the host (never commit them).
2. Update the `fetch` URL in the extension's `focus.js` from
   `http://localhost:3000/coach` to your deployed URL.
3. Add the same `EXTENSION_SHARED_KEY` value into the extension's code
   so its requests are authorized.
4. Add the deployed URL to `host_permissions` in `manifest.json`.
