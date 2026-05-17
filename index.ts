import type { Interface as ReadlineInterface } from "node:readline/promises";
import type { BetSide, EventSummary as EventSummaryType, MarketOdds, OddsRunner, PlaceBetPayload } from "./src/types.ts";

export { BettingClient, createBettingClient } from "./src/bettingClient.ts";
export { loadConfig } from "./src/config.ts";
export type {
  ActiveBet,
  BetSide,
  EventQuery,
  EventSummary,
  MarketOdds,
  OddsRunner,
  PlaceBetInput,
  PlaceBetResult,
} from "./src/types.ts";

if (import.meta.main) {
  const { appendFile, mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { createInterface } = await import("node:readline/promises");
  const { createBettingClient } = await import("./src/bettingClient.ts");
  const { ApiError } = await import("./src/http.ts");

  const client = createBettingClient();
  try {
    await mkdir("data", { recursive: true });
    const selectedEvent = await loadSelectedEvent();
    await fillMissingBetEventFields(selectedEvent);
    await writeFile("data/selected-event.json", JSON.stringify(selectedEvent, null, 2));

    console.log("Selected event:");
    console.log(selectedEvent);
    console.log("Saved selection to data/selected-event.json");

    await runBetCli(client, selectedEvent);
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(error.message);
      console.error(error.body);
      process.exit(1);
    }

    throw error;
  }

  function toEventFileRow(event: EventSummaryType) {
    return {
      sportId: event.sportId,
      seriesId: event.seriesId ?? "",
      seriesName: event.seriesName ?? "",
      eventId: event.eventId,
      eventName: event.eventName,
      eventDate: event.eventDate ?? "",
      marketId: event.marketId ?? "",
      marketName: event.marketName ?? "",
      marketType: event.marketType ?? "",
    };
  }

  function toEventsText(events: ReturnType<typeof toEventFileRow>[]): string {
    const lines = [
      "Available events",
      "================",
      "",
      ...events.map((event, index) =>
        [
          `${index + 1}. ${event.eventName}`,
          `   eventId: ${event.eventId}`,
          `   seriesId: ${event.seriesId}`,
          `   seriesName: ${event.seriesName}`,
          `   eventDate: ${event.eventDate}`,
          `   marketId: ${event.marketId}`,
          `   marketName: ${event.marketName}`,
        ].join("\n"),
      ),
      "",
    ];

    return lines.join("\n");
  }

  async function loadEventsFromFileOrApi(): Promise<ReturnType<typeof toEventFileRow>[]> {
    const savedEvents = await readSavedEvents();
    if (savedEvents.length > 0) {
      return savedEvents;
    }

    console.log("No saved events found. Fetching events from API...");
    const events = await client.getEvents();
    const eventRows = events.map(toEventFileRow);

    await writeFile("data/events.json", JSON.stringify(eventRows, null, 2));
    await writeFile("data/events.txt", toEventsText(eventRows));

    console.log(`Saved ${eventRows.length} events to data/events.json and data/events.txt`);
    return eventRows;
  }

  async function readSavedEvents(): Promise<ReturnType<typeof toEventFileRow>[]> {
    try {
      const raw = await readFile("data/events.json", "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(isEventFileRow);
    } catch {
      return [];
    }
  }

  async function readSavedSelectedEvent(): Promise<ReturnType<typeof toEventFileRow> | undefined> {
    try {
      const raw = await readFile("data/selected-event.json", "utf8");
      const parsed = JSON.parse(raw);
      if (!isEventFileRow(parsed) || !parsed.seriesId) {
        return undefined;
      }

      console.log(`Reusing selected event from data/selected-event.json: ${parsed.eventName}`);
      return parsed;
    } catch {
      return undefined;
    }
  }

  async function loadSelectedEvent(): Promise<ReturnType<typeof toEventFileRow>> {
    const savedSelectedEvent = await readSavedSelectedEvent();
    if (savedSelectedEvent) {
      return savedSelectedEvent;
    }

    const eventRows = await loadEventsFromFileOrApi();
    console.log(`Using ${eventRows.length} events from data/events.json`);

    if (eventRows.length === 0) {
      console.log("No events returned by the API.");
      process.exit(0);
    }

    return askForEventSelection(eventRows);
  }

  function isEventFileRow(value: unknown): value is ReturnType<typeof toEventFileRow> {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return typeof row.eventId === "string" && typeof row.eventName === "string";
  }

  async function askForEventSelection(events: ReturnType<typeof toEventFileRow>[]) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      while (true) {
        const eventId = (await readline.question("Enter eventId for the match you want: ")).trim();
        const seriesId = (await readline.question("Enter seriesId for the match you want: ")).trim();
        const selectedEvent = events.find((event) => event.eventId === eventId && event.seriesId === seriesId);

        if (selectedEvent) {
          return selectedEvent;
        }

        console.log("No event matched that eventId + seriesId. Check data/events.txt and try again.");
      }
    } finally {
      readline.close();
    }
  }

  async function fillMissingBetEventFields(event: ReturnType<typeof toEventFileRow>) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      if (!event.seriesName) {
        event.seriesName = await askRequired(readline, "Enter seriesName: ");
      }
      if (!event.eventDate) {
        event.eventDate = await askRequired(readline, "Enter eventDate: ");
      }
      if (!event.marketId) {
        event.marketId = await askRequired(readline, "Enter marketId: ");
      }
      if (!event.marketName) {
        event.marketName = "Match Odds";
      }
      if (!event.marketType) {
        event.marketType = "MO";
      }
    } finally {
      readline.close();
    }
  }

  async function runBetCli(client: ReturnType<typeof createBettingClient>, event: ReturnType<typeof toEventFileRow>) {
    let latestOdds: MarketOdds | undefined;
    let lastPrintedOddsAt = 0;
    let resolveFirstOdds: (odds: MarketOdds) => void = () => {};
    const firstOdds = new Promise<MarketOdds>((resolve) => {
      resolveFirstOdds = resolve;
    });

    console.log("Connecting to live odds feed...");
    await writeFile("data/odds-feed.log", "");
    const stream = client.streamMarketOdds(
      event,
      (odds) => {
        latestOdds = odds;
        resolveFirstOdds(odds);

        const now = Date.now();
        if (now - lastPrintedOddsAt >= 2_000) {
          lastPrintedOddsAt = now;
          printOdds(odds);
        }
      },
      (error) => {
        console.error(error.message);
      },
      (diagnostics) => {
        void appendOddsDiagnostic(diagnostics);
      },
    );

    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      latestOdds = await withTimeout(firstOdds, 15_000);

      if (!latestOdds) {
        console.log("No odds snapshot received yet. Keeping websocket open while you choose side.");
      }

      while (true) {
        const { side, amount } = await askForBetCommand(readline);
        const autoBet = await waitForAutoBetCandidate(() => latestOdds, side);
        printAutoBetCandidate(autoBet);

        console.log("");
        console.log("Bet preview:");
        console.log({
          eventName: event.eventName,
          eventId: event.eventId,
          seriesId: event.seriesId,
          marketId: autoBet.odds.marketId,
          marketName: autoBet.odds.marketName,
          outcomeId: autoBet.runner.outcomeId,
          outcomeDesc: autoBet.runner.outcomeDesc,
          side: autoBet.side,
          amount,
          oddValue: autoBet.quote.price,
          oddSize: autoBet.quote.size ?? 0,
        });

        try {
          const result = await client.placeBet({
            event,
            outcomeId: autoBet.runner.outcomeId,
            outcomeDesc: autoBet.runner.outcomeDesc ?? autoBet.runner.outcomeId,
            side: autoBet.side,
            amount,
            odds: autoBet.odds,
            oddValue: autoBet.quote.price,
            oddSize: autoBet.quote.size ?? 0,
            overrides: {
              marketId: autoBet.odds.marketId ?? event.marketId,
              marketName: autoBet.odds.marketName ?? event.marketName,
              marketType: readMarketType(autoBet.odds) ?? event.marketType,
              ...readMarketLimits(autoBet.odds),
            },
          });

          console.log(result.dryRun ? "Dry run bet payload:" : "Bet placed:");
          console.log(result);
        } catch (error) {
          if (error instanceof ApiError) {
            console.error(error.message);
            console.error(error.body);
            await writeFile(
              "data/last-bet-error.json",
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
          } else {
            console.error(error);
          }
        }

        console.log("");
        console.log("Ready for next bet. Use BACK 500 or LAY 500. Press Ctrl+C to stop.");
      }
    } finally {
      stream.close();
      readline.close();
    }
  }

  async function appendOddsDiagnostic(diagnostics: { direction: string; value?: unknown }): Promise<void> {
    const shouldLog = (typeof Bun !== "undefined" ? Bun.env.BETBOT_LOG_WS : process.env.BETBOT_LOG_WS) === "true";
    if (!shouldLog) {
      return;
    }

    const line = JSON.stringify({
      at: new Date().toISOString(),
      direction: diagnostics.direction,
      value: truncateDiagnosticValue(diagnostics.value),
    });

    await appendFile("data/odds-feed.log", `${line}\n`);
  }

  function truncateDiagnosticValue(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }

    return value.length > 2_000 ? `${value.slice(0, 2_000)}...<truncated>` : value;
  }

  function printOdds(odds: MarketOdds): void {
    console.log("");
    console.log(`Live odds ${odds.receivedAt}`);
    console.log(`market: ${odds.marketName ?? "-"} ${odds.marketId ?? ""}`.trim());
    console.log("outcomeId | runner | back | lay");
    for (const runner of odds.runners) {
      const back = runner.back ? `${runner.back.price}${formatSize(runner.back.size)}` : "-";
      const lay = runner.lay ? `${runner.lay.price}${formatSize(runner.lay.size)}` : "-";
      console.log(`${runner.outcomeId} | ${runner.outcomeDesc ?? ""} | ${back} | ${lay}`);
    }
    console.log("");
  }

  function formatSize(size: number | undefined): string {
    return typeof size === "number" ? ` (${size})` : "";
  }

  type AutoBetCandidate = {
    odds: MarketOdds;
    runner: OddsRunner;
    side: BetSide;
    quote: {
      price: number;
      size?: number;
    };
  };

  async function waitForAutoBetCandidate(getLatestOdds: () => MarketOdds | undefined, side: BetSide): Promise<AutoBetCandidate> {
    console.log(`Waiting for ${side} odds below 100...`);
    while (true) {
      const odds = getLatestOdds();
      const candidate = odds ? findCandidateForSide(odds, side) : undefined;
      if (candidate) {
        return candidate;
      }

      await sleep(500);
    }
  }

  function findCandidateForSide(odds: MarketOdds, side: BetSide): AutoBetCandidate | undefined {
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

  function printAutoBetCandidate(candidate: AutoBetCandidate): void {
    console.log("");
    console.log("Auto-selected <100 odds:");
    console.log({
      market: `${candidate.odds.marketName ?? "-"} ${candidate.odds.marketId ?? ""}`.trim(),
      outcomeId: candidate.runner.outcomeId,
      outcomeDesc: candidate.runner.outcomeDesc,
      side: candidate.side,
      oddValue: candidate.quote.price,
      oddSize: candidate.quote.size ?? 0,
    });
  }

  function readMarketType(odds: MarketOdds): string | undefined {
    const raw = odds.raw;
    if (typeof raw !== "object" || raw === null || !("marketType" in raw)) {
      return undefined;
    }

    const marketType = (raw as { marketType?: unknown }).marketType;
    return typeof marketType === "string" ? marketType : undefined;
  }

  function readMarketLimits(odds: MarketOdds): Partial<PlaceBetPayload> {
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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function askForRunner(
    readline: ReadlineInterface,
    getLatestOdds: () => MarketOdds | undefined,
  ): Promise<OddsRunner | undefined> {
    while (true) {
      const odds = getLatestOdds();
      if (!odds?.runners.length) {
        return undefined;
      }

      printOdds(odds);
      const answer = (await readline.question("Enter runner number or outcomeId: ")).trim();
      const asIndex = Number(answer);
      const runner = Number.isInteger(asIndex) && asIndex > 0 ? odds.runners[asIndex - 1] : odds.runners.find((item) => item.outcomeId === answer);

      if (runner) {
        return runner;
      }

      console.log("No runner matched that input. Try again.");
    }
  }

  async function askForBetCommand(readline: ReadlineInterface): Promise<{ side: BetSide; amount: number }> {
    while (true) {
      const input = (await readline.question("Enter bet as SIDE AMOUNT, e.g. BACK 500: ")).trim();
      const [sideRaw, amountRaw] = input.split(/\s+/);
      const side = sideRaw?.toUpperCase();
      const amount = Number(amountRaw);

      if ((side === "BACK" || side === "LAY") && Number.isFinite(amount) && amount > 0) {
        return {
          side,
          amount,
        };
      }

      console.log("Use format BACK 500 or LAY 500. Press Ctrl+C to stop.");
    }
  }

  async function askForPositiveNumber(
    readline: ReadlineInterface,
    question: string,
  ): Promise<number> {
    while (true) {
      const value = Number((await readline.question(question)).trim());
      if (Number.isFinite(value) && value > 0) {
        return value;
      }

      console.log("Enter a positive number.");
    }
  }

  async function askForOptionalNumber(
    readline: ReadlineInterface,
    question: string,
  ): Promise<number | undefined> {
    const answer = (await readline.question(question)).trim();
    if (!answer) {
      return undefined;
    }

    const value = Number(answer);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }

    console.log("Invalid number. Using 0.");
    return undefined;
  }

  async function askRequired(
    readline: ReadlineInterface,
    question: string,
  ): Promise<string> {
    while (true) {
      const answer = (await readline.question(question)).trim();
      if (answer) {
        return answer;
      }

      console.log("This value is required.");
    }
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), timeoutMs);
    });

    const result = await Promise.race([promise, timeoutPromise]);
    if (timeout) {
      clearTimeout(timeout);
    }

    return result;
  }
}
