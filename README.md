# bot-bet

Typed client functions for fetching events, reading websocket odds, placing bets, and listing active bets.

## Setup

```bash
bun install
cp .env.example .env
```

Fill `BETBOT_AUTH_TOKEN` in `.env`. The bot defaults to `BETBOT_DRY_RUN=true`, so `placeBet` will build and return the request payload without sending a real bet. Set `BETBOT_DRY_RUN=false` only when you are ready to place live bets.

## High-level functions

```ts
import { createBettingClient } from "./index.ts";

const client = createBettingClient();

const events = await client.getEvents();
const event = events[0];

const odds = await client.getCurrentMarketOdds(event);

const result = await client.placeBet({
  event,
  outcomeId: "38528100",
  outcomeDesc: "Punjab Kings",
  side: "BACK",
  amount: 500,
  odds,
});

const activeBets = await client.getActiveBets();
```

## Websocket subscription messages

The captured curl only includes the websocket URL, not the subscription frames. Once you capture the messages sent after the websocket opens, put them in `BETBOT_ODDS_SUBSCRIBE_MESSAGES` as a JSON array.

Templates are supported:

```env
BETBOT_ODDS_SUBSCRIBE_MESSAGES=["[\"CONNECT\\ntoken:Bearer null\\naccept-version:1.1,1.0\\nheart-beat:5000,10000\\n\\n\\u0000\"]","[\"SUBSCRIBE\\nid:sub-0\\ndestination:/topic/rx_bm_update/{eventId}\\n\\n\\u0000\"]"]
```

## Telegram Bot

Set these in `.env`:

```env
TELEGRAM_BOT_TOKEN=replace-with-telegram-bot-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789
MAX_PARALLEL_MATCHES=
```

Leave `MAX_PARALLEL_MATCHES` empty for unlimited active match sessions. If `TELEGRAM_ALLOWED_CHAT_IDS` is empty, every chat can use the bot, so fill it before using live betting.

Run:

```bash
bun index.ts
```

Telegram commands:

```text
/events
/refresh
/sessions
/bet pbks BACK 500
/stop pbks
/stopall
```

Flow:

1. Send `/events`.
2. Click a match button.
3. Reply with an alias, for example `pbks`.
4. Place bets with `/bet pbks BACK 500` or `/bet pbks LAY 500`.

The bot auto-selects the runner whose requested side odds are below `100`, fills outcome/market/odds details from the latest websocket odds, and keeps every selected match session running in parallel.

## Commands

```bash
bun run start
bun run typecheck
```
