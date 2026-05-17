export { BettingClient, createBettingClient } from "./src/bettingClient.ts";
export { loadConfig } from "./src/config.ts";
export { EventStore } from "./src/eventStore.ts";
export { SessionManager } from "./src/sessionManager.ts";
export { TelegramBot } from "./src/telegramBot.ts";
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
  const { SessionManager } = await import("./src/sessionManager.ts");
  const { TelegramBot } = await import("./src/telegramBot.ts");

  const config = loadConfig();
  const client = createBettingClient(config);
  const sessions = new SessionManager(client, config.maxParallelMatches);
  const telegramBot = new TelegramBot(config, client, sessions);

  process.on("SIGINT", async () => {
    telegramBot.stop();
    await sessions.stopAll();
    process.exit(0);
  });

  await telegramBot.start();
}
