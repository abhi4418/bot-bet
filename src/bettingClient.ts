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

    // Log raw response for visibility
    console.log("[BET API] Response:", JSON.stringify(response));

    // The API returns HTTP 200 even for soft failures — inspect the body.
    const state = assertBetResponseSuccess(response, payload.amount);

    if (state === "IN_PROGRESS") {
      let betFound = false;
      let apiErrorMsg: string | undefined;

      // Wait initial 6s for the in-play betting delay before we start polling
      console.log(`[BET API] Bet is IN_PROGRESS. Waiting 6s before polling...`);
      await new Promise((r) => setTimeout(r, 6000));

      // Poll bet-status up to 10 times (20s total)
      for (let i = 0; i < 10; i++) {
        try {
          // Fetch raw response to debug why it parses to 0 bets
          const rawStatus = await this.http.get<unknown>(
            new URL("/api/v1/bs/bet-status", this.config.apiBaseUrl).toString(),
          );
          console.log(`[BET API] Polling (${i + 1}/10) Raw response:`, JSON.stringify(rawStatus).slice(0, 500));
          
          if (typeof rawStatus === "object" && rawStatus !== null) {
            const rs = rawStatus as any;
            const status = typeof rs.status === "string" ? rs.status.toUpperCase() : "";
            
            if (status === "ACCEPTED" || status === "SUCCESS" || status === "OK") {
              betFound = true;
              break;
            }
            if (status === "REJECTED" || status === "FAILED" || rs.success === false) {
              apiErrorMsg = rs.message || rs.msg || `Bet ${status}`;
              break;
            }
            // If IN_PROGRESS or BETTING_IN_PROGRESS, continue polling
          }

        } catch (e) {
          console.warn("[BET API] Polling bet-status error:", e);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!betFound) {
        throw new Error(apiErrorMsg ? `Bet rejected by API: ${apiErrorMsg}` : "Bet was not confirmed by the server (stuck in IN_PROGRESS). Please check balance or limits.");
      }
    }

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

/**
 * Inspects the raw API response body for soft failures.
 * The bet API returns HTTP 200 even when the bet is rejected (e.g. insufficient
 * balance, odds moved, stake limits). We need to check the body explicitly.
 */
function assertBetResponseSuccess(response: unknown, amount: number): "SUCCESS" | "IN_PROGRESS" {
  if (!response) {
    throw new Error("Bet API returned an empty response.");
  }

  // String response — should be a bet ID (numeric-ish). If it contains
  // error keywords treat it as a failure.
  if (typeof response === "string") {
    const lower = response.toLowerCase();
    if (
      lower.includes("fail") ||
      lower.includes("error") ||
      lower.includes("insufficient") ||
      lower.includes("balance") ||
      lower.includes("reject") ||
      lower.includes("invalid")
    ) {
      throw new Error(`Bet rejected by API: ${response}`);
    }
    // Looks like a bet ID — success.
    return "SUCCESS";
  }

  if (typeof response !== "object") return "SUCCESS";

  const r = response as Record<string, unknown>;

  // Common patterns: { status: "FAIL" | "ERROR" }, { success: false }
  const status = typeof r.status === "string" ? r.status.toUpperCase() : undefined;
  
  if (status === "IN_PROGRESS" || status === "BETTING_IN_PROGRESS" || status === "PENDING") {
    return "IN_PROGRESS";
  }

  if (status && status !== "OK" && status !== "SUCCESS" && status !== "ACCEPTED") {
    const msg = typeof r.message === "string" ? r.message : typeof r.msg === "string" ? r.msg : JSON.stringify(response);
    throw new Error(`Bet rejected by API (status=${r.status}): ${msg}`);
  }

  if (r.success === false) {
    const msg = typeof r.message === "string" ? r.message : typeof r.msg === "string" ? r.msg : JSON.stringify(response);
    throw new Error(`Bet rejected by API: ${msg}`);
  }

  // Check message field for known failure keywords even on 200
  const msgField = (typeof r.message === "string" ? r.message : typeof r.msg === "string" ? r.msg : "").toLowerCase();
  const FAILURE_KEYWORDS = ["insufficient", "balance", "reject", "exceed", "limit", "invalid", "fail", "error", "not enough"];
  for (const kw of FAILURE_KEYWORDS) {
    if (msgField.includes(kw)) {
      throw new Error(`Bet rejected by API: ${r.message ?? r.msg}`);
    }
  }

  return "SUCCESS";
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
