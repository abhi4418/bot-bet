import type { BetSide, MarketOdds } from "./types.ts";
import type { OutcomePosition } from "./betLedger.ts";

export type CashoutResult =
  | {
      possible: true;
      side: BetSide;
      outcomeId: string;
      outcomeDesc: string;
      amount: number;
      oddValue: number;
      expectedPnl: number;
    }
  | {
      possible: false;
      reason: string;
    };

/**
 * Calculate the hedge bet that equalises P&L across all outcomes.
 *
 * We always bet on the favourite (odds < 2).
 *
 * If favourite-wins profit > other-wins profit  →  LAY favourite
 *   layStake = (profitFav − profitOther) / layOdds
 *
 * If other-wins profit > favourite-wins profit  →  BACK favourite
 *   backStake = (profitOther − profitFav) / backOdds
 */
export function calculateCashout(
  positions: OutcomePosition[],
  odds: MarketOdds,
  oddsAdjustment: number = 0.05,
): CashoutResult {
  // Ignore "The Draw" which is common in cricket Test/Match Odds
  const mainPositions = positions.filter(
    (p) => p.outcomeDesc.toLowerCase() !== "the draw",
  );

  if (mainPositions.length !== 2) {
    return {
      possible: false,
      reason: `Cashout supports 2 main outcomes, found ${mainPositions.length}.`,
    };
  }

  // Identify favourite runner (back price < 2)
  const favourite = odds.runners.find(
    (r) => r.back && r.back.price > 0 && r.back.price < 2,
  );
  if (!favourite) {
    return { possible: false, reason: "No favourite (back odds < 2) in current odds." };
  }

  const favPos = mainPositions.find((p) => p.outcomeId === favourite.outcomeId);
  const otherPos = mainPositions.find((p) => p.outcomeId !== favourite.outcomeId);

  if (!favPos || !otherPos) {
    return { possible: false, reason: "Cannot match positions to current odds." };
  }

  const diff = favPos.profitIfWins - otherPos.profitIfWins;

  if (Math.abs(diff) < 1) {
    return { possible: false, reason: "Already balanced (diff < ₹1)." };
  }

  if (diff > 0) {
    // Fav-wins gives more → LAY favourite
    const layOdds =
      (favourite.lay?.price ?? favourite.back!.price) + oddsAdjustment;
    const layStake = Math.round(diff / layOdds);
    if (layStake < 1) {
      return { possible: false, reason: "Hedge stake too small." };
    }

    const newFav = favPos.profitIfWins - layStake * (layOdds - 1);
    const newOther = otherPos.profitIfWins + layStake;
    return {
      possible: true,
      side: "LAY",
      outcomeId: favourite.outcomeId,
      outcomeDesc: favourite.outcomeDesc ?? favourite.outcomeId,
      amount: layStake,
      oddValue: layOdds,
      expectedPnl: Math.round(((newFav + newOther) / 2) * 100) / 100,
    };
  } else {
    // Other-wins gives more → BACK favourite
    const backOdds = (favourite.back?.price ?? 1.5) - oddsAdjustment;
    const backStake = Math.round(Math.abs(diff) / backOdds);
    if (backStake < 1) {
      return { possible: false, reason: "Hedge stake too small." };
    }

    const newFav = favPos.profitIfWins + backStake * (backOdds - 1);
    const newOther = otherPos.profitIfWins - backStake;
    return {
      possible: true,
      side: "BACK",
      outcomeId: favourite.outcomeId,
      outcomeDesc: favourite.outcomeDesc ?? favourite.outcomeId,
      amount: backStake,
      oddValue: backOdds,
      expectedPnl: Math.round(((newFav + newOther) / 2) * 100) / 100,
    };
  }
}
