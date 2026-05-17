export { BettingClient, createBettingClient } from "./src/bettingClient.ts";
export { loadConfig } from "./src/config.ts";
export { EventStore } from "./src/eventStore.ts";
export { SessionManager } from "./src/sessionManager.ts";
export { TelegramBot } from "./src/telegramBot.ts";
export { UserTelegramClient } from "./src/userTelegramClient.ts";
export { BetLedger } from "./src/betLedger.ts";
export { calculateCashout } from "./src/cashoutEngine.ts";
export { parseSignal, findMatchingEvent } from "./src/signalParser.ts";
export type {
  ActiveBet,
  BetSide,
  EventQuery,
  EventSummary,
  MarketOdds,
  OddsRunner,
  PlaceBetInput,
  PlaceBetResult,
} from "./src/types.ts";

if (import.meta.main) {
  const { createBettingClient } = await import("./src/bettingClient.ts");
  const { loadConfig } = await import("./src/config.ts");
  const { UserTelegramClient } = await import("./src/userTelegramClient.ts");
  const { setAuthToken } = await import("./src/authStore.ts");

  const config = loadConfig();

  // Seed the in-memory token from .env so the bot works out of the box.
  // A Telegram `login` command will overwrite this at runtime.
  if (config.authToken) {
    setAuthToken(config.authToken);
    console.log("[AUTH] Token seeded from BETBOT_AUTH_TOKEN env var.");
  } else {
    console.warn("[AUTH] No BETBOT_AUTH_TOKEN in env — type 'login' in the update group to authenticate.");
  }

  const client = createBettingClient(config);
  const userTg = new UserTelegramClient(config, client);

  process.on("SIGINT", () => {
    userTg.stop();
    process.exit(0);
  });

  await userTg.start();
}
