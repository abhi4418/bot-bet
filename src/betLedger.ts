import type { BetSide } from "./types.ts";

export type BetRecord = {
  eventId: string;
  outcomeId: string;
  outcomeDesc: string;
  side: BetSide;
  amount: number;
  oddValue: number;
  timestamp: string;
};

export type OutcomePosition = {
  outcomeId: string;
  outcomeDesc: string;
  profitIfWins: number;
};

export class BetLedger {
  private readonly bets = new Map<string, BetRecord[]>();

  recordBet(bet: BetRecord): void {
    const existing = this.bets.get(bet.eventId) ?? [];
    existing.push(bet);
    this.bets.set(bet.eventId, existing);
  }

  getBetsForEvent(eventId: string): BetRecord[] {
    return this.bets.get(eventId) ?? [];
  }

  /**
   * Calculate the net position for each outcome of an event.
   *
   * BACK on outcome X:
   *   X wins  → +stake × (odds − 1)
   *   X loses → −stake
   *
   * LAY on outcome X:
   *   X wins  → −stake × (odds − 1)   (liability)
   *   X loses → +stake
   */
  getPosition(
    eventId: string,
    allRunners?: { outcomeId: string; outcomeDesc?: string }[],
  ): OutcomePosition[] {
    const bets = this.getBetsForEvent(eventId);
    if (bets.length === 0) return [];

    // Collect every known outcome (from bets + allRunners)
    const descMap = new Map<string, string>();
    for (const bet of bets) {
      if (!descMap.has(bet.outcomeId)) {
        descMap.set(bet.outcomeId, bet.outcomeDesc);
      }
    }
    if (allRunners) {
      for (const r of allRunners) {
        if (!descMap.has(r.outcomeId)) {
          descMap.set(r.outcomeId, r.outcomeDesc ?? r.outcomeId);
        }
      }
    }

    const positions: OutcomePosition[] = [];

    for (const [outcomeId, desc] of descMap) {
      let profitIfWins = 0;

      for (const bet of bets) {
        if (bet.side === "BACK") {
          if (bet.outcomeId === outcomeId) {
            profitIfWins += bet.amount * (bet.oddValue - 1);
          } else {
            profitIfWins -= bet.amount;
          }
        } else {
          // LAY
          if (bet.outcomeId === outcomeId) {
            profitIfWins -= bet.amount * (bet.oddValue - 1);
          } else {
            profitIfWins += bet.amount;
          }
        }
      }

      positions.push({
        outcomeId,
        outcomeDesc: desc,
        profitIfWins: Math.round(profitIfWins * 100) / 100,
      });
    }

    return positions;
  }

  clear(eventId: string): void {
    this.bets.delete(eventId);
  }

  clearAll(): void {
    this.bets.clear();
  }
}
