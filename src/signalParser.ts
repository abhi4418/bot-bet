import type { BetSide } from "./types.ts";
import { getLimitAmount } from "./limitStore.ts";

export type ParsedSignal =
  | { type: "bet"; side: BetSide; playerOrTeam: string; amount?: number }
  | { type: "cashout"; target: string };

/**
 * Parse a raw message into a structured signal.
 *
 * Accepted formats:
 *   BACK Punjab Kings 500
 *   LAY Mumbai Indians 1000
 *   CASHOUT Punjab Kings
 */
export function parseSignal(message: string): ParsedSignal | undefined {
  const text = message.trim();
  if (!text) return undefined;

  // Ignore post-match or summary messages
  const lowerText = text.toLowerCase();
  const ignorePhrases = [
    "done & dusted",
    "done and dusted",
    "cashed in",
    "cash in",
    "won",
    "loss",
    "profit"
  ];
  if (ignorePhrases.some((phrase) => lowerText.includes(phrase))) {
    return undefined;
  }

  const cashoutMatch = text.match(/^CASHOUT\s+(.+)$/i);
  if (cashoutMatch) {
    return { type: "cashout", target: cashoutMatch[1].trim() };
  }

  // ── TIPSTER FORMAT: 🏆 Match Winner : Team ✅ ─────────────────────
  const tipsterMatch = text.match(/Match\s*Winner\s*:\s*([^✅\n\r]+)/i);
  if (tipsterMatch && (text.includes("🏆") || text.includes("✅") || /stake|unit/i.test(text))) {
    const playerOrTeam = tipsterMatch[1].trim();
    let multiplier = 1;
    const unitMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:-|)(?:unit|limit)s?/i);
    if (unitMatch) {
      multiplier = Number(unitMatch[1]);
    }
    return {
      type: "bet",
      side: "BACK",
      playerOrTeam,
      amount: multiplier * getLimitAmount(),
    };
  }

  // ── MANUAL BET: {BACK|LAY} {player/team} {amount or unit} ──────────────────
  const betMatch = text.match(/^(BACK|LAY)\s+(.+?)\s+(\d+(?:\.\d+)?)(?:\s*(?:-|)(unit|limit)s?)?$/i);
  if (betMatch) {
    const side = betMatch[1].toUpperCase() as BetSide;
    const playerOrTeam = betMatch[2].trim();
    const value = Number(betMatch[3]);
    const isUnitOrLimit = !!betMatch[4];
    
    let amount = value;
    if (isUnitOrLimit) {
      amount = value * getLimitAmount();
    }

    if (amount > 0) {
      return { type: "bet", side, playerOrTeam, amount };
    }
  }

  // ── CASUAL FORMAT: "2 limit punjab winner" OR "punjab 2 limit" ─────────────
  const casualMatch1 = text.match(/^(\d+(?:\.\d+)?)\s*(?:-|)(unit|limit)s?\s+(.+?)(?:\s+winner)?$/i);
  const casualMatch2 = text.match(/^(.+?)(?:\s+winner)?\s+(\d+(?:\.\d+)?)\s*(?:-|)(unit|limit)s?$/i);
  
  if (casualMatch1) {
    return { 
      type: "bet", 
      side: "BACK", 
      playerOrTeam: casualMatch1[3].trim(), 
      amount: Number(casualMatch1[1]) * getLimitAmount() 
    };
  }
  
  if (casualMatch2) {
    return { 
      type: "bet", 
      side: "BACK", 
      playerOrTeam: casualMatch2[1].trim(), 
      amount: Number(casualMatch2[2]) * getLimitAmount() 
    };
  }

  return undefined;
}

/**
 * Fuzzy-match a player/team name against a list of events.
 *
 * Strategies (in order):
 *   1. Exact substring match (case-insensitive)
 *   2. Highest number of matching words
 */
export function findMatchingEvent<T extends { eventName: string }>(
  events: T[],
  playerOrTeam: string,
): T | undefined {
  const search = playerOrTeam.toLowerCase();

  const exactMatch = events.find((e) =>
    e.eventName.toLowerCase().includes(search),
  );
  if (exactMatch) return exactMatch;

  const words = search.split(/\s+/).filter((w) => w.length > 2); // Ignore very short words like 'v', 'vs', 'fc'
  if (words.length > 0) {
    let bestEvent: T | undefined;
    let maxScore = 0;

    for (const e of events) {
      const name = e.eventName.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score++;
      }

      if (score > maxScore) {
        maxScore = score;
        bestEvent = e;
      }
    }

    if (bestEvent && maxScore > 0) {
      return bestEvent;
    }
  }

  return undefined;
}
