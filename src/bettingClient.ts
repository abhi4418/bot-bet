import { loadConfig, type BotConfig } from "./config.ts";
import { HttpClient } from "./http.ts";
import { normalizeActiveBetsResponse, normalizeEventsResponse, oppositeSide, pickQuote } from "./normalizers.ts";
import { OddsFeedClient, type OddsStream, type OddsStreamDiagnostics } from "./oddsFeed.ts";
import type {
  ActiveBet,
  BetEvent,
  BetSide,
  EventQuery,
  EventSummary,
  MarketOdds,
  PlaceBetInput,
  PlaceBetPayload,
  PlaceBetResult,
} from "./types.ts";

export class BettingClient {
  private readonly http: HttpClient;
  private readonly oddsFeed: OddsFeedClient;

  constructor(private readonly config: BotConfig) {
    this.http = new HttpClient(config);
    this.oddsFeed = new OddsFeedClient(config);
  }

  async getEvents(query: EventQuery = {}): Promise<EventSummary[]> {
    const sportId = query.sportId ?? this.config.defaultSportId;
    const providerId = query.providerId ?? this.config.defaultProviderId;
    const url = `${this.config.catalogBaseUrl}/catalog/v2/sports-feed/sports/live-events?providerId=${encodeURIComponent(providerId)}`;

    const response = await this.http.get<unknown>(url);
    return normalizeEventsResponse(response, sportId);
  }

  getCurrentMarketOdds(event: Pick<EventSummary, "eventId" | "marketId">): Promise<MarketOdds> {
    return this.oddsFeed.waitForMarketOdds({
      eventId: event.eventId,
      marketId: event.marketId,
    });
  }

  streamMarketOdds(
    event: Pick<EventSummary, "eventId" | "marketId">,
    onOdds: (odds: MarketOdds) => void,
    onError?: (error: Error) => void,
    onDiagnostics?: (diagnostics: OddsStreamDiagnostics) => void,
  ): OddsStream {
    return this.oddsFeed.streamMarketOdds(
      {
        eventId: event.eventId,
      },
      onOdds,
      onError,
      onDiagnostics,
    );
  }

  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    const payload = this.buildPlaceBetPayload(input);

    if (this.config.dryRun) {
      return {
        dryRun: true,
        payload,
      };
    }

    const response = await this.http.post<unknown>(new URL(this.getPlaceBetPath(payload), this.config.apiBaseUrl).toString(), payload);

    return {
      dryRun: false,
      payload,
      response,
    };
  }

  async getActiveBets(): Promise<ActiveBet[]> {
    const response = await this.http.get<unknown>(
      new URL("/api/v1/bs/bet-status", this.config.apiBaseUrl).toString(),
    );

    return normalizeActiveBetsResponse(response);
  }

  async placeOppositeSideBet(input: Omit<PlaceBetInput, "side"> & { originalSide: BetSide }): Promise<PlaceBetResult> {
    return this.placeBet({
      ...input,
      side: oppositeSide(input.originalSide),
    });
  }

  private buildPlaceBetPayload(input: PlaceBetInput): PlaceBetPayload {
    const event = assertBetEvent(input.event, this.config);
    const quote = pickQuote(input.odds, input.side, input.outcomeId);
    const oddValue = input.oddValue ?? quote?.price;

    if (!oddValue) {
      throw new Error("oddValue is required. Pass oddValue directly or provide websocket odds with a matching outcome.");
    }

    return {
      sportId: event.sportId,
      seriesId: event.seriesId,
      seriesName: event.seriesName,
      eventId: event.eventId,
      eventName: event.eventName,
      eventDate: event.eventDate,
      marketId: event.marketId,
      marketName: event.marketName ?? this.config.defaultMarketName,
      marketType: event.marketType ?? this.config.defaultMarketType,
      outcomeId: input.outcomeId,
      outcomeDesc: input.outcomeDesc,
      betType: input.side,
      amount: input.amount,
      oddValue,
      oddSize: input.oddSize ?? quote?.size ?? 0,
      sessionPrice: -1,
      srEventId: event.eventId,
      srSeriesId: event.seriesId,
      srSportId: event.sportId,
      minStake: this.config.defaultMinStake,
      maxStake: this.config.defaultMaxStake,
      oddLimt: this.config.defaultOddLimit,
      mcategory: "ALL",
      delay: this.config.defaultBetDelay,
      ...input.overrides,
    };
  }

  private getPlaceBetPath(payload: PlaceBetPayload): string {
    return payload.marketType === "BOOKMAKER" ? this.config.placeBookmakerPath : this.config.placeMatchOddsPath;
  }
}

export function createBettingClient(overrides: Partial<BotConfig> = {}): BettingClient {
  return new BettingClient(loadConfig(overrides));
}

function assertBetEvent(event: EventSummary | BetEvent, config: BotConfig): BetEvent {
  const missing: string[] = [];
  const sportId = event.sportId ?? config.defaultSportId;
  const seriesId = event.seriesId;
  const seriesName = event.seriesName;
  const eventDate = event.eventDate;
  const marketId = event.marketId;

  if (!seriesId) missing.push("seriesId");
  if (!seriesName) missing.push("seriesName");
  if (!eventDate) missing.push("eventDate");
  if (!marketId) missing.push("marketId");

  if (missing.length > 0) {
    throw new Error(`Event is missing fields required for placing a bet: ${missing.join(", ")}.`);
  }

  return {
    sportId,
    seriesId: seriesId as string,
    seriesName: seriesName as string,
    eventId: event.eventId,
    eventName: event.eventName,
    eventDate: eventDate as string,
    marketId: marketId as string,
    marketName: event.marketName,
    marketType: event.marketType,
  };
}
