import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { BettingClient } from "./bettingClient.ts";
import { findCandidateForSide, readMarketLimits, readMarketType } from "./betLogic.ts";
import type { EventFileRow } from "./eventStore.ts";
import { isEventFileRow } from "./eventStore.ts";
import { ApiError } from "./http.ts";
import type { OddsStream } from "./oddsFeed.ts";
import type { BetSide, MarketOdds, PlaceBetResult } from "./types.ts";

export type SessionSnapshot = {
  chatId: number;
  alias: string;
  event: EventFileRow;
  startedAt: string;
};

export type MatchSession = SessionSnapshot & {
  latestOdds?: MarketOdds;
  stream: OddsStream;
};

export type BetExecutionResult =
  | {
      ok: true;
      result: PlaceBetResult;
      odds: MarketOdds;
      outcomeId: string;
      outcomeDesc: string;
      oddValue: number;
      oddSize: number;
    }
  | {
      ok: false;
      reason: string;
    };

const dataDir = "data";
const sessionsPath = `${dataDir}/sessions.json`;

export class SessionManager {
  private readonly sessions = new Map<string, MatchSession>();

  constructor(
    private readonly client: BettingClient,
    private readonly maxParallelMatches?: number,
  ) {}

  async restoreSavedSessions(): Promise<void> {
    const saved = await this.readSavedSessions();
    for (const session of saved) {
      if (this.maxParallelMatches !== undefined && this.sessions.size >= this.maxParallelMatches) {
        break;
      }

      this.startSession(session.chatId, session.alias, session.event, false);
    }
  }

  async startSession(chatId: number, alias: string, event: EventFileRow, persist = true): Promise<MatchSession> {
    const normalizedAlias = normalizeAlias(alias);
    if (!normalizedAlias) {
      throw new Error("Alias must use letters, numbers, underscore, or dash.");
    }

    const key = sessionKey(chatId, normalizedAlias);
    const existing = this.sessions.get(key);
    if (!existing && this.maxParallelMatches !== undefined && this.sessions.size >= this.maxParallelMatches) {
      throw new Error(`Maximum active sessions reached: ${this.maxParallelMatches}`);
    }

    if (existing) {
      existing.stream.close();
    }

    const session: MatchSession = {
      chatId,
      alias: normalizedAlias,
      event,
      startedAt: new Date().toISOString(),
      stream: this.client.streamMarketOdds(
        event,
        (odds) => {
          session.latestOdds = odds;
        },
        (error) => {
          console.error(`[${normalizedAlias}] ${error.message}`);
        },
      ),
    };

    // Try to get a quick snapshot of current market odds (non-blocking).
    void this.client
      .getCurrentMarketOdds({ eventId: event.eventId, marketId: event.marketId })
      .then((odds) => {
        session.latestOdds = odds;
      })
      .catch(() => {
        // ignore snapshot errors; stream will update when available
      });

    this.sessions.set(key, session);
    if (persist) {
      await this.saveSessions();
    }

    return session;
  }

  async stopSession(chatId: number, alias: string): Promise<boolean> {
    const key = sessionKey(chatId, alias);
    const session = this.sessions.get(key);
    if (!session) {
      return false;
    }

    session.stream.close();
    this.sessions.delete(key);
    await this.saveSessions();
    return true;
  }

  async stopAll(chatId?: number): Promise<number> {
    let count = 0;

    for (const [key, session] of this.sessions) {
      if (chatId !== undefined && session.chatId !== chatId) {
        continue;
      }

      session.stream.close();
      this.sessions.delete(key);
      count += 1;
    }

    await this.saveSessions();
    return count;
  }

  listSessions(chatId?: number): MatchSession[] {
    return [...this.sessions.values()].filter((session) => chatId === undefined || session.chatId === chatId);
  }

  getSession(chatId: number, alias: string): MatchSession | undefined {
    return this.sessions.get(sessionKey(chatId, alias));
  }

  async placeBet(chatId: number, alias: string, side: BetSide, amount: number): Promise<BetExecutionResult> {
    const session = this.getSession(chatId, alias);
    if (!session) {
      return {
        ok: false,
        reason: `Unknown session '${alias}'. Use /sessions to see active aliases.`,
      };
    }

    if (!session.latestOdds) {
      return {
        ok: false,
        reason: `No live odds received yet for '${alias}'. Try again in a few seconds.`,
      };
    }

    const candidate = findCandidateForSide(session.latestOdds, side);
    if (!candidate) {
      return {
        ok: false,
        reason: `No ${side} odds below 100 found for '${alias}' in latest ${session.latestOdds.marketName ?? "market"} odds.`,
      };
    }

    try {
      const result = await this.client.placeBet({
        event: session.event,
        outcomeId: candidate.runner.outcomeId,
        outcomeDesc: candidate.runner.outcomeDesc ?? candidate.runner.outcomeId,
        side,
        amount,
        odds: candidate.odds,
        oddValue: candidate.quote.price,
        oddSize: candidate.quote.size ?? 0,
        overrides: {
          marketId: candidate.odds.marketId ?? session.event.marketId,
          marketName: candidate.odds.marketName ?? session.event.marketName,
          marketType: readMarketType(candidate.odds) ?? session.event.marketType,
          ...readMarketLimits(candidate.odds),
        },
      });

      return {
        ok: true,
        result,
        odds: candidate.odds,
        outcomeId: candidate.runner.outcomeId,
        outcomeDesc: candidate.runner.outcomeDesc ?? candidate.runner.outcomeId,
        oddValue: candidate.quote.price,
        oddSize: candidate.quote.size ?? 0,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        await writeFile(
          `${dataDir}/last-bet-error.json`,
          JSON.stringify(
            {
              message: error.message,
              status: error.status,
              body: error.body,
              request: error.request,
            },
            null,
            2,
          ),
        );

        return {
          ok: false,
          reason: `${error.message}\n${JSON.stringify(error.body)}`,
        };
      }

      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readSavedSessions(): Promise<SessionSnapshot[]> {
    try {
      const raw = await readFile(sessionsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(isSessionSnapshot);
    } catch {
      return [];
    }
  }

  private async saveSessions(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const snapshots = this.listSessions().map(({ chatId, alias, event, startedAt }) => ({
      chatId,
      alias,
      event,
      startedAt,
    }));

    await writeFile(sessionsPath, JSON.stringify(snapshots, null, 2));
  }
}

export function normalizeAlias(alias: string): string | undefined {
  const normalized = alias.trim().toLowerCase();
  return /^[a-z0-9_-]{1,24}$/.test(normalized) ? normalized : undefined;
}

function sessionKey(chatId: number, alias: string): string {
  return `${chatId}:${normalizeAlias(alias) ?? alias}`;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.chatId === "number" &&
    typeof row.alias === "string" &&
    typeof row.startedAt === "string" &&
    isEventFileRow(row.event)
  );
}
