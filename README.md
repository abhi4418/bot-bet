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

## Commands

```bash
bun run start
bun run typecheck
```

Running `bun index.ts` fetches events, writes:

- `data/events.json`
- `data/events.txt`

If `data/selected-event.json` exists, the CLI reuses that match directly. Otherwise it asks for the `eventId` and `seriesId` of the match you want and saves the matched event to:

- `data/selected-event.json`

For a saved running match, the bet prompt only asks for:

- one command in `{SIDE} {AMOUNT}` format, for example `BACK 500`

It then auto-selects the runner whose odds for that side are below `100` and sends the bet using the latest live odds.
