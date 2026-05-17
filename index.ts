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

  const config = loadConfig();
  const client = createBettingClient(config);
  const userTg = new UserTelegramClient(config, client);

  process.on("SIGINT", () => {
    userTg.stop();
    process.exit(0);
  });

  await userTg.start();
}
