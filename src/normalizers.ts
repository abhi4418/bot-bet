import type { ActiveBet, BetSide, EventSummary, MarketOdds, OddQuote, OddsRunner } from "./types.ts";

export function normalizeEventsResponse(data: unknown, fallbackSportId: string): EventSummary[] {
  const events: EventSummary[] = [];
  const seen = new Set<string>();

  visit(data, (node) => {
    const eventId = readString(node, "eventId", "srEventId", "id");
    const eventName = readString(node, "eventName", "name", "eventDesc");

    if (!eventId || !eventName || seen.has(eventId)) {
      return;
    }

    seen.add(eventId);
    events.push({
      sportId: readString(node, "sportId", "srSportId") ?? fallbackSportId,
      seriesId: readString(node, "seriesId", "srSeriesId", "competitionId"),
      seriesName: readString(node, "seriesName", "competitionName", "competition"),
      eventId,
      eventName,
      eventDate: readString(node, "eventDate", "openDate", "startTime", "startDate"),
      marketId: readString(node, "marketId"),
      marketName: readString(node, "marketName"),
      marketType: readString(node, "marketType"),
      raw: node,
    });
  });

  return events;
}

export function normalizeActiveBetsResponse(data: unknown): ActiveBet[] {
  const bets: ActiveBet[] = [];
  const seen = new Set<string>();

  visit(data, (node) => {
    const betId = readString(node, "betId", "id", "bet_id", "orderId");
    if (!betId || seen.has(betId)) {
      return;
    }

    seen.add(betId);
    bets.push({
      betId,
      eventId: readString(node, "eventId", "srEventId"),
      marketId: readString(node, "marketId"),
      outcomeId: readString(node, "outcomeId", "selectionId"),
      side: readBetSide(node),
      amount: readNumber(node, "amount", "stake"),
      oddValue: readNumber(node, "oddValue", "price", "odds"),
      raw: node,
    });
  });

  return bets;
}

export function normalizeOddsMessage(data: unknown, eventId?: string, marketId?: string): MarketOdds | undefined {
  let bestMatch: MarketOdds | undefined;

  visit(data, (node) => {
    if (bestMatch) {
      return;
    }

    const nodeEventId = readString(node, "eventId", "srEventId");
    const nodeMarketId = readString(node, "marketId");

    if (eventId && nodeEventId && nodeEventId !== eventId) {
      return;
    }

    if (marketId && nodeMarketId && nodeMarketId !== marketId) {
      return;
    }

    const runners = readRunners(node);
    if (runners.length === 0) {
      return;
    }

    bestMatch = {
      eventId: nodeEventId,
      marketId: nodeMarketId,
      marketName: readString(node, "marketName"),
      runners,
      receivedAt: new Date().toISOString(),
      raw: node,
    };
  });

  return bestMatch;
}

export function pickQuote(odds: MarketOdds | OddQuote | undefined, side: BetSide, outcomeId?: string): OddQuote | undefined {
  if (!odds) {
    return undefined;
  }

  if ("price" in odds) {
    return odds;
  }

  const runner = outcomeId ? odds.runners.find((item) => item.outcomeId === outcomeId) : odds.runners[0];
  return side === "BACK" ? runner?.back : runner?.lay;
}

export function parseSocketFrames(frame: unknown): unknown[] {
  if (typeof frame !== "string") {
    return [frame];
  }

  if (frame === "o" || frame === "h") {
    return [];
  }

  if (frame.startsWith("a")) {
    const parsed = safeJson(frame.slice(1));
    return Array.isArray(parsed) ? parsed.flatMap(parseSocketFrames) : [];
  }

  const stompBody = readStompBody(frame);
  if (stompBody) {
    return [safeJson(stompBody) ?? stompBody];
  }

  return [safeJson(frame) ?? frame];
}

export function oppositeSide(side: BetSide): BetSide {
  return side === "BACK" ? "LAY" : "BACK";
}

function readRunners(node: Record<string, unknown>): OddsRunner[] {
  const candidates = [
    node.runners,
    node.outcomes,
    node.selections,
    node.runnerDetails,
  ];

  const list = candidates.find(Array.isArray);
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((runner) => normalizeRunner(runner))
    .filter((runner): runner is OddsRunner => Boolean(runner));
}

function normalizeRunner(value: unknown): OddsRunner | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const outcomeId = readString(value, "outcomeId", "selectionId", "id", "runnerId");
  if (!outcomeId) {
    return undefined;
  }

  return {
    outcomeId,
    outcomeDesc: readString(value, "outcomeDesc", "runnerName", "name"),
    back: readQuote(value, "back", "backs", "availableToBack", "backPrices", "b"),
    lay: readQuote(value, "lay", "lays", "availableToLay", "layPrices", "l"),
    raw: value,
  };
}

function readQuote(node: Record<string, unknown>, ...keys: string[]): OddQuote | undefined {
  for (const key of keys) {
    const value = node[key];
    const quote = normalizeQuote(value);
    if (quote) {
      return quote;
    }
  }

  const price = readNumber(node, "price", "oddValue", "odds");
  const size = readNumber(node, "size", "oddSize");
  return price ? { price, size } : undefined;
}

function normalizeQuote(value: unknown): OddQuote | undefined {
  const quoteValue = Array.isArray(value) ? value[0] : value;

  if (typeof quoteValue === "number") {
    return { price: quoteValue };
  }

  if (!isRecord(quoteValue)) {
    return undefined;
  }

  const price = readNumber(quoteValue, "price", "oddValue", "odds", "p");
  if (!price) {
    return undefined;
  }

  return {
    price,
    size: readNumber(quoteValue, "size", "oddSize", "s"),
  };
}

function readBetSide(node: Record<string, unknown>): BetSide | undefined {
  const value = readString(node, "betType", "side", "type")?.toUpperCase();
  return value === "BACK" || value === "LAY" ? value : undefined;
}

function readString(node: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function readNumber(node: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function visit(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, visitor);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  visitor(value);

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) {
      visit(nested, visitor);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readStompBody(frame: string): string | undefined {
  const separatorIndex = frame.indexOf("\n\n");
  if (separatorIndex === -1) {
    return undefined;
  }

  const command = frame.slice(0, frame.indexOf("\n"));
  if (command !== "MESSAGE") {
    return undefined;
  }

  const body = frame.slice(separatorIndex + 2).replace(/\u0000$/, "").trim();
  return body || undefined;
}
