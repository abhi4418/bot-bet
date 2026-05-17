import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import * as readline from "node:readline";

import type { BotConfig } from "./config.ts";
import type { BettingClient } from "./bettingClient.ts";
import type { EventFileRow } from "./eventStore.ts";
import { EventStore, toEventFileRow } from "./eventStore.ts";
import { BetLedger, type BetRecord } from "./betLedger.ts";
import { calculateCashout } from "./cashoutEngine.ts";
import { parseSignal, findMatchingEvent } from "./signalParser.ts";
import type { MarketOdds, OddsRunner, BetSide } from "./types.ts";
import type { OddsStream } from "./oddsFeed.ts";
import { readMarketType, readMarketLimits } from "./betLogic.ts";
import { loginAndStore, isAuthTokenSet, clearAuthToken } from "./authStore.ts";
import { getLimitAmount, setLimitAmount } from "./limitStore.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActiveStream = {
  event: EventFileRow;
  stream: OddsStream;
  latestOdds?: MarketOdds;
};

// ---------------------------------------------------------------------------
// UserTelegramClient
// ---------------------------------------------------------------------------

/** Event series names to skip (not real games). */
const SKIP_SERIES_PATTERNS = [/simulated\s*reality/i];

export class UserTelegramClient {
  private client!: TelegramClient;
  private readonly eventStore: EventStore;
  private readonly ledger = new BetLedger();
  private readonly activeStreams = new Map<string, ActiveStream>();
  private readonly processedMsgIds = new Set<number>();
  private readonly autoCashedOutEvents = new Set<string>();
  /** Tracks users mid-way through the interactive login flow. */
  private readonly pendingLogin = new Map<number, { step: "username" } | { step: "password"; username: string }>();

  /** Tracks pending manual cashouts awaiting confirmation. */
  private readonly pendingCashouts = new Map<
    number,
    { 
      event: EventFileRow;
      odds: MarketOdds;
      cashout: ReturnType<typeof calculateCashout>;
      targetText: string;
    }
  >();
  private eventsCache: EventFileRow[] = [];
  private stopped = false;

  constructor(
    private readonly config: BotConfig,
    private readonly bettingClient: BettingClient,
  ) {
    this.eventStore = new EventStore(bettingClient);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.config.telegramApiId || !this.config.telegramApiHash) {
      throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required.");
    }

    const session = new StringSession(this.config.telegramSessionString);
    this.client = new TelegramClient(session, this.config.telegramApiId, this.config.telegramApiHash, {
      connectionRetries: 5,
    });

    await this.client.start({
      phoneNumber: () => this.prompt("Enter your phone number: "),
      password: () => this.prompt("Enter 2FA password (if any): "),
      phoneCode: () => this.prompt("Enter the OTP code: "),
      onError: (err: Error) => console.error("[TG Auth]", err.message),
    });

    // Persist session string for next run
    const savedSession = this.client.session.save() as unknown as string;
    if (savedSession && savedSession !== this.config.telegramSessionString) {
      await this.persistSessionString(savedSession);
      console.log("[TG] Session string saved to .env");
    }

    const me = await this.client.getMe();
    console.log(`[TG] Logged in as ${me.firstName ?? ""} (ID: ${me.id})`);

    // Cache entities so we can resolve numeric IDs
    console.log("[TG] Fetching dialogs to cache entities...");
    await this.client.getDialogs();

    // Load live events
    await this.refreshEvents();

    // Register message handlers
    this.registerHandlers();

    console.log("[TG] Listening for signals...");
    console.log(`[TG] Signal channel: ${this.config.telegramSignalChannel}`);
    console.log(`[TG] Update group:   ${this.config.telegramUpdateGroup}`);

    // Keep alive
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const [, active] of this.activeStreams) {
      active.stream.close();
    }
    this.activeStreams.clear();
    this.client?.disconnect();
  }

  // ── Event Handlers ──────────────────────────────────────────────────

  private registerHandlers(): void {
    const channelId = this.config.telegramSignalChannel;
    const groupId = this.config.telegramUpdateGroup;

    // Listen to the signal channel
    if (channelId) {
      this.client.addEventHandler(
        async (event) => {
          const message = event.message;
          if (!message?.message) return;
          if (this.isDuplicate(message.id)) return;
          console.log(`[SIGNAL] ${message.message}`);
          await this.handleSignal(message.message, "channel");
        },
        new NewMessage({ chats: [this.resolveChat(channelId)] }),
      );
    }

    // Also listen to the update group (for manual commands)
    if (groupId) {
      this.client.addEventHandler(
        async (event) => {
          const message = event.message;
          if (!message?.message) return;
          if (this.isDuplicate(message.id)) return;

          const text = message.message.trim();
          const senderId = message.senderId ? Number(message.senderId) : 0;

          // --- Login command ---
          if (text.toLowerCase() === "login") {
            await this.handleLoginCommand(senderId, "start");
            return;
          }

          // --- Logout command ---
          if (text.toLowerCase() === "logout" || text.toLowerCase() === "/logout") {
            clearAuthToken();
            console.log("[AUTH] Logged out. Token cleared from memory.");
            await this.sendGroupMessage("👋 Logged out successfully. Token cleared from memory.\nType `login` to authenticate again.");
            return;
          }

          // --- Help command ---
          if (text.toLowerCase() === "help" || text.toLowerCase() === "/help") {
            const helpText = `🤖 **Bot Commands:**
- \`login\` : Authenticate to the betting server
- \`logout\` : Clear authentication token
- \`setlimit <amount>\` : Change the base limit amount (currently ₹${getLimitAmount()})
- \`help\` : Show this help message
- \`BACK/LAY <team> <amount>\` : Place a manual bet
- \`<amount> limit <team>\` : Place a casual signal bet`;
            await this.sendGroupMessage(helpText);
            return;
          }

          // --- Set Limit command ---
          if (text.toLowerCase().startsWith("setlimit ") || text.toLowerCase().startsWith("/setlimit ")) {
            const parts = text.split(" ");
            const amount = Number(parts[1]);
            if (isNaN(amount) || amount <= 0) {
              await this.sendGroupMessage("❌ Invalid amount. Usage: `setlimit 500`");
              return;
            }
            setLimitAmount(amount);
            await this.sendGroupMessage(`✅ Base limit amount updated to ₹${amount}. Signals like "1 limit" will now place a ₹${amount} bet.`);
            return;
          }

          // --- Intercept pending cashout confirmation ---
          if (this.pendingCashouts.has(senderId)) {
            const reply = text.toLowerCase();
            if (reply === "yes" || reply === "y") {
              await this.executePendingCashout(senderId);
            } else {
              this.pendingCashouts.delete(senderId);
              await this.sendGroupMessage("❌ Cashout cancelled.");
            }
            return;
          }

          // --- Intercept pending cashout confirmation ---
          if (this.pendingCashouts.has(senderId)) {
            const reply = text.toLowerCase();
            if (reply === "yes" || reply === "y") {
              await this.executePendingCashout(senderId);
            } else {
              this.pendingCashouts.delete(senderId);
              await this.sendGroupMessage("❌ Cashout cancelled.");
            }
            return;
          }

          // --- Intercept replies that are part of a pending login flow ---
          if (this.pendingLogin.has(senderId)) {
            await this.handleLoginCommand(senderId, text);
            return;
          }

          // Only process messages that look like signals
          const parsed = parseSignal(text);
          if (!parsed) return;
          console.log(`[GROUP] ${text}`);
          await this.handleSignal(text, "group", senderId);
        },
        new NewMessage({ chats: [this.resolveChat(groupId)] }),
      );
    }
  }

  /** Deduplicate messages — returns true if already processed. */
  private isDuplicate(msgId: number): boolean {
    if (this.processedMsgIds.has(msgId)) return true;
    this.processedMsgIds.add(msgId);
    // Keep the set bounded
    if (this.processedMsgIds.size > 500) {
      const first = this.processedMsgIds.values().next().value;
      if (first !== undefined) this.processedMsgIds.delete(first);
    }
    return false;
  }

  // ── Login Command ────────────────────────────────────────────────────

  /**
   * Multi-step interactive login handler.
   * Step flow:  "start" → ask for username
   *             username reply → ask for password
   *             password reply → call login API → store token
   */
  private async handleLoginCommand(senderId: number, input: string): Promise<void> {
    const state = this.pendingLogin.get(senderId);

    // ── Step 0: trigger ──────────────────────────────────────────────
    if (input === "start") {
      this.pendingLogin.set(senderId, { step: "username" });
      await this.sendGroupMessage("🔐 *Login*\nPlease reply with your *username*:");
      return;
    }

    // ── Step 1: waiting for username ─────────────────────────────────
    if (state?.step === "username") {
      const username = input.trim();
      if (!username) {
        await this.sendGroupMessage("Username cannot be empty. Please reply with your username:");
        return;
      }
      this.pendingLogin.set(senderId, { step: "password", username });
      await this.sendGroupMessage(`Got it — username: \`${username}\`\nNow reply with your *password*:`);
      return;
    }

    // ── Step 2: waiting for password ─────────────────────────────────
    if (state?.step === "password") {
      const password = input.trim();
      if (!password) {
        await this.sendGroupMessage("Password cannot be empty. Please reply with your password:");
        return;
      }

      this.pendingLogin.delete(senderId);
      await this.sendGroupMessage("⏳ Logging in...");

      try {
        const token = await loginAndStore(state.username, password);
        // Show only first/last 6 chars of the token for confirmation
        const preview = `${token.slice(0, 6)}...${token.slice(-6)}`;
        console.log(`[AUTH] Login successful for ${state.username}. Token: ${preview}`);
        await this.sendGroupMessage(
          `✅ Login successful!\nToken stored in memory (${preview}).\n\nThe bot will now use this token for all API calls.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[AUTH] Login failed:", msg);
        await this.sendGroupMessage(`❌ Login failed: ${msg}\n\nType \`login\` to try again.`);
      }
      return;
    }

    // Shouldn't reach here, but clean up just in case
    this.pendingLogin.delete(senderId);
  }

  // ── Signal Processing ───────────────────────────────────────────────

  private async handleSignal(text: string, source: string, senderId = 0): Promise<void> {
    const signal = parseSignal(text);
    if (!signal) return;

    // Bail early if we have no token — avoids hammering the API and getting rate-limited
    if (!isAuthTokenSet()) {
      console.warn(`[SIGNAL] Ignoring signal from ${source} — not authenticated. Type 'login' in the update group.`);
      await this.sendGroupMessage("⚠️ Signal received but bot is not authenticated. Type `login` in this group first.");
      return;
    }

    try {
      if (signal.type === "cashout") {
        await this.handleCashout(signal.target, false, senderId);
      } else {
        await this.handleBet(signal.side, signal.playerOrTeam, signal.amount);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] ${source}: ${msg}`);
      await this.sendGroupMessage(`❌ Error: ${msg}`);
    }
  }

  private async handleBet(signalSide: BetSide, playerOrTeam: string, amountInput?: number): Promise<void> {
    const amount = amountInput ?? this.config.defaultStake;

    // Refresh events if cache is empty
    if (this.eventsCache.length === 0) {
      await this.refreshEvents();
    }

    // Find matching event
    const event = findMatchingEvent(this.eventsCache, playerOrTeam);
    if (!event) {
      await this.sendGroupMessage(`⚠️ No event found for "${playerOrTeam}"`);
      return;
    }

    // Ensure we have an active odds stream for this event
    const odds = await this.ensureOddsStream(event);
    if (!odds) {
      await this.sendGroupMessage(`⚠️ No live odds for ${event.eventName}`);
      return;
    }

    // Find the favourite (back odds < 2)
    const favourite = odds.runners.find(
      (r) => r.back && r.back.price > 0 && r.back.price < 2,
    );
    if (!favourite) {
      await this.sendGroupMessage(`⚠️ No favourite (odds < 2) in ${event.eventName}`);
      return;
    }

    // Determine if the signal player is the favourite or not
    const isSignalPlayerFavourite = this.isRunnerMatch(favourite, playerOrTeam);

    // Translate the signal to an action on the favourite
    // BACK non-fav → LAY fav,  LAY non-fav → BACK fav
    // BACK fav → BACK fav,     LAY fav → LAY fav
    let actualSide: BetSide;
    if (isSignalPlayerFavourite) {
      actualSide = signalSide; // same
    } else {
      actualSide = signalSide === "BACK" ? "LAY" : "BACK"; // flip
    }

    // Pick odds with adjustment
    const adj = this.config.oddsAdjustment;
    let oddValue: number;
    let oddSize: number;

    if (actualSide === "BACK") {
      oddValue = (favourite.back?.price ?? 1.5) - adj;
      oddSize = favourite.back?.size ?? 0;
    } else {
      oddValue = (favourite.lay?.price ?? favourite.back?.price ?? 1.5) + adj;
      oddSize = favourite.lay?.size ?? 0;
    }

    // Place the bet
    const result = await this.bettingClient.placeBet({
      event,
      outcomeId: favourite.outcomeId,
      outcomeDesc: favourite.outcomeDesc ?? favourite.outcomeId,
      side: actualSide,
      amount,
      odds,
      oddValue,
      oddSize,
      overrides: {
        marketId: odds.marketId ?? event.marketId,
        marketName: odds.marketName ?? event.marketName,
        marketType: readMarketType(odds) ?? event.marketType,
        ...readMarketLimits(odds),
      },
    });

    // Record in ledger
    const record: BetRecord = {
      eventId: event.eventId,
      outcomeId: favourite.outcomeId,
      outcomeDesc: favourite.outcomeDesc ?? favourite.outcomeId,
      side: actualSide,
      amount,
      oddValue,
      timestamp: new Date().toISOString(),
    };
    this.ledger.recordBet(record);

    // Build confirmation message
    const dryTag = result.dryRun ? " [DRY RUN]" : "";
    const translation = isSignalPlayerFavourite
      ? ""
      : `\n↪ Translated: ${signalSide} ${playerOrTeam} → ${actualSide} ${favourite.outcomeDesc ?? favourite.outcomeId}`;

    const positions = this.ledger.getPosition(event.eventId, odds.runners);
    const posText = positions
      .map((p) => `  ${p.outcomeDesc}: ₹${p.profitIfWins}`)
      .join("\n");

    const msg = [
      `✅ Bet placed${dryTag}`,
      `Event: ${event.eventName}`,
      `${actualSide} ${favourite.outcomeDesc ?? favourite.outcomeId} @ ${oddValue}`,
      `Amount: ₹${amount}`,
      translation,
      `\n📊 Position:`,
      posText,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(msg);
    await this.sendGroupMessage(msg);
  }

  private async handleCashout(target: string, isAuto = false, senderId = 0): Promise<void> {
    // Find matching event
    const event = findMatchingEvent(this.eventsCache, target);
    if (!event) {
      await this.sendGroupMessage(`⚠️ No event found for cashout: "${target}"`);
      return;
    }

    // Get current odds first (need runners for position calc)
    const active = this.activeStreams.get(event.eventId);
    const odds = active?.latestOdds;
    if (!odds) {
      await this.sendGroupMessage(`⚠️ No live odds available for cashout on ${event.eventName}`);
      return;
    }

    const positions = this.ledger.getPosition(event.eventId, odds.runners);
    if (positions.length === 0) {
      await this.sendGroupMessage(`⚠️ No bets recorded for ${event.eventName}`);
      return;
    }

    // Calculate cashout
    const cashout = calculateCashout(positions, odds, this.config.oddsAdjustment);
    if (!cashout.possible) {
      await this.sendGroupMessage(`⚠️ Cashout not possible: ${cashout.reason}`);
      return;
    }

    // If this is a manual cashout from a user, ask for confirmation first
    if (!isAuto && senderId) {
      this.pendingCashouts.set(senderId, {
        event,
        odds,
        cashout,
        targetText: target
      });

      const msg = [
        `🤔 **Confirm Cashout for ${event.eventName}?**`,
        `Hedge Bet: ${cashout.side} ${cashout.outcomeDesc} @ ${cashout.oddValue}`,
        `Stake: ₹${cashout.amount}`,
        `\n**Projected Final Ledger (both sides):**`,
        `All outcomes will have an expected P&L of roughly: **₹${cashout.expectedPnl}**`,
        `\nReply with **yes** to confirm or **no** to cancel.`
      ];
      await this.sendGroupMessage(msg.join("\n"));
      return;
    }

    // If it's auto-cashout, execute immediately
    await this.executeCashout(event, odds, cashout);
  }

  private async executePendingCashout(senderId: number): Promise<void> {
    const pending = this.pendingCashouts.get(senderId);
    if (!pending) return;
    this.pendingCashouts.delete(senderId);
    
    await this.sendGroupMessage(`⏳ Executing cashout...`);
    await this.executeCashout(pending.event, pending.odds, pending.cashout as any);
  }

  private async executeCashout(event: EventFileRow, odds: MarketOdds, cashout: Exclude<ReturnType<typeof calculateCashout>, { possible: false }>): Promise<void> {
    // Mark as cashed out to avoid auto-cashout double triggering
    this.autoCashedOutEvents.add(event.eventId);

    // Place the hedge bet
    const result = await this.bettingClient.placeBet({
      event,
      outcomeId: cashout.outcomeId,
      outcomeDesc: cashout.outcomeDesc,
      side: cashout.side,
      amount: cashout.amount,
      odds,
      oddValue: cashout.oddValue,
      oddSize: 0,
      overrides: {
        marketId: odds.marketId ?? event.marketId,
        marketName: odds.marketName ?? event.marketName,
        marketType: readMarketType(odds) ?? event.marketType,
        ...readMarketLimits(odds),
      },
    });

    // Record hedge bet in ledger
    this.ledger.recordBet({
      eventId: event.eventId,
      outcomeId: cashout.outcomeId,
      outcomeDesc: cashout.outcomeDesc,
      side: cashout.side,
      amount: cashout.amount,
      oddValue: cashout.oddValue,
      timestamp: new Date().toISOString(),
    });

    const dryTag = result.dryRun ? " [DRY RUN]" : "";
    const newPositions = this.ledger.getPosition(event.eventId, odds.runners);
    const posText = newPositions
      .map((p) => `  ${p.outcomeDesc}: ₹${p.profitIfWins}`)
      .join("\n");

    const msg = [
      `💰 CASHOUT${dryTag}`,
      `Event: ${event.eventName}`,
      `Hedge: ${cashout.side} ${cashout.outcomeDesc} @ ${cashout.oddValue}`,
      `Amount: ₹${cashout.amount}`,
      `Expected P&L: ₹${cashout.expectedPnl}`,
      `\n📊 Final Position:`,
      posText,
    ].join("\n");

    console.log(msg);
    await this.sendGroupMessage(msg);
  }

  // ── Odds Management ─────────────────────────────────────────────────

  private async ensureOddsStream(event: EventFileRow): Promise<MarketOdds | undefined> {
    const existing = this.activeStreams.get(event.eventId);
    if (existing?.latestOdds) {
      return existing.latestOdds;
    }

    if (!existing) {
      // Start a new stream
      const active: ActiveStream = {
        event,
        stream: this.bettingClient.streamMarketOdds(
          event,
          (odds) => {
            active.latestOdds = odds;
            this.checkAutoCashout(event, odds).catch((err) => 
              console.error("[AUTO-CASHOUT] Error:", err)
            );
          },
          (error) => {
            console.error(`[WS] ${event.eventName}: ${error.message}`);
          },
        ),
      };
      this.activeStreams.set(event.eventId, active);
    }

    // Wait briefly for odds to arrive
    const target = this.activeStreams.get(event.eventId)!;
    for (let i = 0; i < 20; i++) {
      if (target.latestOdds) return target.latestOdds;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Also try a one-shot fetch
    try {
      const odds = await this.bettingClient.getCurrentMarketOdds(event);
      target.latestOdds = odds;
      return odds;
    } catch {
      return target.latestOdds;
    }
  }

  private async checkAutoCashout(event: EventFileRow, odds: MarketOdds): Promise<void> {
    if (this.autoCashedOutEvents.has(event.eventId)) return;

    const positions = this.ledger.getPosition(event.eventId, odds.runners);
    if (positions.length === 0) return;

    const mainPositions = positions.filter((p) => p.outcomeDesc.toLowerCase() !== "the draw");
    if (mainPositions.length !== 2) return;

    const diff = Math.abs(mainPositions[0].profitIfWins - mainPositions[1].profitIfWins);
    if (diff < 10) return; // Already balanced enough, don't cash out

    // Find the player we are "winning" on (profitIfWins > 0 and higher than the other)
    const posA = mainPositions[0];
    const posB = mainPositions[1];
    
    const winningPos = posA.profitIfWins > posB.profitIfWins ? posA : posB;
    if (winningPos.profitIfWins <= 0) return; // We aren't winning on either!

    // Find current back odds of the winning outcome
    const runner = odds.runners.find((r) => r.outcomeId === winningPos.outcomeId);
    if (!runner?.back || runner.back.price === 0) return;

    // "reached 40p favourite" => odds <= 1.40
    if (runner.back.price <= 1.40) {
      this.autoCashedOutEvents.add(event.eventId);
      console.log(`[AUTO-CASHOUT] ${event.eventName}: ${runner.outcomeDesc} reached ${runner.back.price}`);
      await this.sendGroupMessage(`⚡ **Auto Cashout Triggered!**\n${runner.outcomeDesc} reached 40p (${runner.back.price}). Cashing out ${event.eventName}...`);
      await this.handleCashout(event.eventName, true);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private isRunnerMatch(runner: OddsRunner, playerOrTeam: string): boolean {
    const desc = (runner.outcomeDesc ?? "").toLowerCase();
    const search = playerOrTeam.toLowerCase();
    if (desc.includes(search)) return true;

    const words = search.split(/\s+/).filter((w) => w.length > 1);
    return words.length > 0 && words.some((w) => desc.includes(w));
  }

  private async refreshEvents(): Promise<void> {
    try {
      const all = await this.eventStore.refreshEvents();
      this.eventsCache = all.filter(
        (e) => !SKIP_SERIES_PATTERNS.some((re) => re.test(e.seriesName)),
      );
      const skipped = all.length - this.eventsCache.length;
      console.log(`[EVENTS] Loaded ${this.eventsCache.length} live events (skipped ${skipped} simulated).`);
    } catch (err) {
      console.error("[EVENTS] Failed to refresh:", err instanceof Error ? err.message : err);
    }
  }

  private async sendGroupMessage(text: string): Promise<void> {
    if (!this.config.telegramUpdateGroup) return;
    try {
      await this.client.sendMessage(this.resolveChat(this.config.telegramUpdateGroup), {
        message: text,
      });
    } catch (err) {
      console.error("[TG] Failed to send group message:", err instanceof Error ? err.message : err);
    }
  }

  private resolveChat(chatId: string): string | number {
    const num = Number(chatId);
    return Number.isFinite(num) ? num : chatId;
  }

  private async persistSessionString(session: string): Promise<void> {
    try {
      const envPath = ".env";
      let envContent = "";
      try {
        envContent = await readFile(envPath, "utf8");
      } catch {
        // .env doesn't exist yet
      }

      if (envContent.includes("TELEGRAM_SESSION_STRING=")) {
        envContent = envContent.replace(
          /TELEGRAM_SESSION_STRING=.*/,
          `TELEGRAM_SESSION_STRING=${session}`,
        );
      } else {
        envContent += `\nTELEGRAM_SESSION_STRING=${session}\n`;
      }

      await writeFile(envPath, envContent);
    } catch (err) {
      console.error("[TG] Could not save session to .env:", err);
      console.log("[TG] Session string (save manually):", session);
    }
  }

  private prompt(question: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
}
