import type { BetSide, MarketOdds, OddsRunner, PlaceBetPayload } from "./types.ts";

export type AutoBetCandidate = {
  odds: MarketOdds;
  runner: OddsRunner;
  side: BetSide;
  quote: {
    price: number;
    size?: number;
  };
};

export function findCandidateForSide(odds: MarketOdds, side: BetSide): AutoBetCandidate | undefined {
  for (const runner of odds.runners) {
    const quote = side === "BACK" ? runner.back : runner.lay;
    if (quote && quote.price > 0 && quote.price < 100) {
      return {
        odds,
        runner,
        side,
        quote,
      };
    }
  }

  return undefined;
}

export function readMarketType(odds: MarketOdds): string | undefined {
  const raw = odds.raw;
  if (typeof raw !== "object" || raw === null || !("marketType" in raw)) {
    return undefined;
  }

  const marketType = (raw as { marketType?: unknown }).marketType;
  return typeof marketType === "string" ? marketType : undefined;
}

export function readMarketLimits(odds: MarketOdds): Partial<PlaceBetPayload> {
  const raw = odds.raw;
  if (typeof raw !== "object" || raw === null || !("limits" in raw)) {
    return {};
  }

  const limits = (raw as { limits?: unknown }).limits;
  if (typeof limits !== "object" || limits === null) {
    return {};
  }

  const values = limits as Record<string, unknown>;
  const overrides: Partial<PlaceBetPayload> = {};
  const minStake = readNumberValue(values.minBetValue);
  const maxStake = readNumberValue(values.maxBetValue);
  const oddLimit = readNumberValue(values.oddsLimit);
  const delay = readNumberValue(values.delay);

  if (minStake !== undefined) overrides.minStake = minStake;
  if (maxStake !== undefined) overrides.maxStake = maxStake;
  if (oddLimit !== undefined) overrides.oddLimt = oddLimit.toString();
  if (delay !== undefined) overrides.delay = delay;

  return overrides;
}

function readNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
