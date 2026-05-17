export type BotConfig = {
  catalogBaseUrl: string;
  apiBaseUrl: string;
  placeMatchOddsPath: string;
  placeBookmakerPath: string;
  oddsFeedUrl: string;
  authToken: string;
  referer: string;
  origin: string;
  userAgent: string;
  acceptLanguage: string;
  defaultSportId: string;
  defaultCompetitionId: string;
  defaultProviderId: string;
  defaultMarketName: string;
  defaultMarketType: string;
  defaultStake: number;
  defaultMinStake: number;
  defaultMaxStake: number;
  defaultOddLimit: string;
  defaultBetDelay: number;
  dryRun: boolean;
  oddsTimeoutMs: number;
  oddsSubscribeMessages: unknown[];
  logWebsocketFrames: boolean;
  oddsAdjustment: number;
  telegramBotToken: string;
  telegramAllowedChatIds: number[];
  maxParallelMatches?: number;
  telegramApiId: number;
  telegramApiHash: string;
  telegramSessionString: string;
  telegramSignalChannel: string;
  telegramUpdateGroup: string;
};

const env = typeof Bun !== "undefined" ? Bun.env : process.env;

export function loadConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const config: BotConfig = {
    catalogBaseUrl: env.BETBOT_CATALOG_BASE_URL ?? "https://catalog.uvwin2024.co",
    apiBaseUrl: env.BETBOT_API_BASE_URL ?? "https://api.uvwin2024.co",
    placeMatchOddsPath: env.BETBOT_PLACE_MATCH_ODDS_PATH ?? "/api/v1/bs/place-matchodds-bet",
    placeBookmakerPath: env.BETBOT_PLACE_BOOKMAKER_PATH ?? "/api/v1/bs/place-bookmaker-bet",
    oddsFeedUrl: env.BETBOT_ODDS_FEED_URL ?? "wss://feed.uvwin2024.co/odds-feed/145/lhz3sj51/websocket",
    authToken: env.BETBOT_AUTH_TOKEN ?? "",
    referer: env.BETBOT_REFERER ?? "https://www.crypto247.club/",
    origin: env.BETBOT_ORIGIN ?? "https://www.crypto247.club",
    userAgent:
      env.BETBOT_USER_AGENT ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    acceptLanguage: env.BETBOT_ACCEPT_LANGUAGE ?? "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7",
    defaultSportId: env.BETBOT_SPORT_ID ?? "4",
    defaultCompetitionId: env.BETBOT_COMPETITION_ID ?? "*",
    defaultProviderId: env.BETBOT_PROVIDER_ID ?? "BetFair",
    defaultMarketName: env.BETBOT_MARKET_NAME ?? "Match Odds",
    defaultMarketType: env.BETBOT_MARKET_TYPE ?? "MO",
    defaultStake: readNumber("BETBOT_DEFAULT_STAKE", 500),
    defaultMinStake: readNumber("BETBOT_MIN_STAKE", 100),
    defaultMaxStake: readNumber("BETBOT_MAX_STAKE", 10_000),
    defaultOddLimit: env.BETBOT_ODD_LIMIT ?? "4",
    defaultBetDelay: readNumber("BETBOT_BET_DELAY", 5),
    dryRun: env.BETBOT_DRY_RUN !== "false",
    oddsTimeoutMs: readNumber("BETBOT_ODDS_TIMEOUT_MS", 10_000),
    oddsSubscribeMessages: readJsonArray("BETBOT_ODDS_SUBSCRIBE_MESSAGES", []),
    logWebsocketFrames: env.BETBOT_LOG_WS === "true",
    oddsAdjustment: readNumber("BETBOT_ODDS_ADJUSTMENT", 0.05),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramAllowedChatIds: readNumberArray("TELEGRAM_ALLOWED_CHAT_IDS"),
    maxParallelMatches: readOptionalNumber("MAX_PARALLEL_MATCHES"),
    telegramApiId: readNumber("TELEGRAM_API_ID", 0),
    telegramApiHash: env.TELEGRAM_API_HASH ?? "",
    telegramSessionString: env.TELEGRAM_SESSION_STRING ?? "",
    telegramSignalChannel: env.TELEGRAM_SIGNAL_CHANNEL ?? "",
    telegramUpdateGroup: env.TELEGRAM_UPDATE_GROUP ?? "",
  };

  return { ...config, ...overrides };
}

function readOptionalNumber(name: string): number | undefined {
  const rawValue = env[name];
  if (!rawValue) {
    return undefined;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readNumberArray(name: string): number[] {
  const rawValue = env[name];
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value));
}

function readNumber(name: string, fallback: number): number {
  const rawValue = env[name];
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : fallback;
}

function readJsonArray(name: string, fallback: unknown[]): unknown[] {
  const rawValue = env[name];
  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
