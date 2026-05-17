import type { BotConfig } from "./config.ts";

export type BetSide = "BACK" | "LAY";

export type EventQuery = {
  sportId?: string;
  competitionId?: string;
  providerId?: string;
};

export type EventSummary = {
  sportId: string;
  seriesId?: string;
  seriesName?: string;
  eventId: string;
  eventName: string;
  eventDate?: string;
  marketId?: string;
  marketName?: string;
  marketType?: string;
  raw: unknown;
};

export type OddQuote = {
  price: number;
  size?: number;
};

export type OddsRunner = {
  outcomeId: string;
  outcomeDesc?: string;
  back?: OddQuote;
  lay?: OddQuote;
  raw: unknown;
};

export type MarketOdds = {
  eventId?: string;
  marketId?: string;
  marketName?: string;
  runners: OddsRunner[];
  receivedAt: string;
  raw: unknown;
};

export type PlaceBetInput = {
  event: EventSummary | BetEvent;
  outcomeId: string;
  outcomeDesc: string;
  side: BetSide;
  amount: number;
  odds?: MarketOdds | OddQuote;
  oddValue?: number;
  oddSize?: number;
  overrides?: Partial<PlaceBetPayload>;
};

export type BetEvent = {
  sportId: string;
  seriesId: string;
  seriesName: string;
  eventId: string;
  eventName: string;
  eventDate: string;
  marketId: string;
  marketName?: string;
  marketType?: string;
};

export type PlaceBetPayload = {
  sportId: string;
  seriesId: string;
  seriesName: string;
  eventId: string;
  eventName: string;
  eventDate: string;
  marketId: string;
  marketName: string;
  marketType: string;
  outcomeId: string;
  outcomeDesc: string;
  betType: BetSide;
  amount: number;
  oddValue: number;
  oddSize: number;
  sessionPrice: number;
  srEventId: string;
  srSeriesId: string;
  srSportId: string;
  minStake: number;
  maxStake: number;
  oddLimt: string;
  mcategory: string;
  delay: number;
};

export type PlaceBetResult = {
  dryRun: boolean;
  payload: PlaceBetPayload;
  response?: unknown;
};

export type ActiveBet = {
  betId: string;
  eventId?: string;
  marketId?: string;
  outcomeId?: string;
  side?: BetSide;
  amount?: number;
  oddValue?: number;
  status?: string;
  raw: unknown;
};

export type HttpClientOptions = {
  config: BotConfig;
};
