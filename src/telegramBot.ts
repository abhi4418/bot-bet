import axios from "axios";
import type { BettingClient } from "./bettingClient.ts";
import type { BotConfig } from "./config.ts";
import { EventStore, type EventFileRow } from "./eventStore.ts";
import { normalizeAlias, type SessionManager, type MatchSession } from "./sessionManager.ts";
import { findCandidateForSide } from "./betLogic.ts";
import type { BetSide } from "./types.ts";

type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type PendingSelection = {
  event: EventFileRow;
};

const pageSize = 8;

export class TelegramBot {
  private readonly token: string;
  private readonly allowedChatIds: Set<number>;
  private readonly eventStore: EventStore;
  private readonly pendingSelections = new Map<number, PendingSelection>();
  private readonly pendingBets = new Map<number, { alias: string; side: BetSide }>();
  private readonly oddsNotifiers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastSentPrice = new Map<string, number>();
  private eventsCache: EventFileRow[] = [];
  private offset = 0;
  private stopped = false;

  constructor(
    config: BotConfig,
    client: BettingClient,
    private readonly sessionManager: SessionManager,
  ) {
    this.token = config.telegramBotToken;
    this.allowedChatIds = new Set(config.telegramAllowedChatIds);
    this.eventStore = new EventStore(client);
  }

  async start(): Promise<void> {
    if (!this.token) {
      throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram mode.");
    }

    this.eventsCache = await this.eventStore.loadEvents();
    await this.sessionManager.restoreSavedSessions();
    // start notifiers for any restored sessions
    for (const s of this.sessionManager.listSessions()) {
      if (this.isAllowed(s.chatId)) {
        this.startOddsNotifier(s);
      }
    }
    console.log("Telegram bot started. Send /events in Telegram.");

    while (!this.stopped) {
      const updates = await this.getUpdates();
      for (const update of updates) {
        this.offset = update.update_id + 1;
        await this.handleUpdate(update);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    if (update.message?.text) {
      await this.handleMessage(update.message);
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    if (!this.isAllowed(chatId)) {
      await this.sendMessage(chatId, "Unauthorized chat.");
      return;
    }

    const text = message.text?.trim() ?? "";
    const pendingSelection = this.pendingSelections.get(chatId);
    const pendingBet = this.pendingBets.get(chatId);
    if (pendingBet && !text.startsWith("/")) {
      const amount = Number(text.trim());
      if (!Number.isFinite(amount) || amount <= 0) {
        await this.sendMessage(chatId, "Please enter a valid numeric amount.");
        return;
      }

      const result = await this.sessionManager.placeBet(chatId, pendingBet.alias, pendingBet.side, amount);
      this.pendingBets.delete(chatId);
      if (!result.ok) {
        await this.sendMessage(chatId, result.reason);
        return;
      }

      await this.sendMessage(
        chatId,
        [
          result.result.dryRun ? "Dry run bet payload built." : "Bet placed.",
          `Alias: ${pendingBet.alias}`,
          `Outcome: ${result.outcomeDesc} (${result.outcomeId})`,
          `Odds: ${result.oddValue} size ${result.oddSize}`,
          `Market: ${result.odds.marketName ?? "-"} ${result.odds.marketId ?? ""}`.trim(),
        ].join("\n"),
      );
      return;
    }
    if (pendingSelection && !text.startsWith("/")) {
      await this.createSessionFromAlias(chatId, text, pendingSelection.event);
      return;
    }

    if (text === "/start" || text === "/help") {
      await this.sendHelp(chatId);
      return;
    }

    if (text === "/events") {
      await this.showEventsPage(chatId, 0);
      return;
    }

    if (text === "/refresh") {
      this.eventsCache = await this.eventStore.refreshEvents();
      await this.sendMessage(chatId, `Refreshed ${this.eventsCache.length} events.`);
      await this.showEventsPage(chatId, 0);
      return;
    }

    if (text === "/sessions") {
      await this.sendMessage(chatId, this.formatSessions(chatId));
      return;
    }

    if (text.startsWith("/bet ")) {
      await this.handleBetCommand(chatId, text);
      return;
    }

    if (text.startsWith("/stop ")) {
      const alias = text.split(/\s+/)[1] ?? "";
      const stopped = await this.sessionManager.stopSession(chatId, alias);
      if (stopped) this.stopOddsNotifier(chatId, alias);
      await this.sendMessage(chatId, stopped ? `Stopped ${alias}.` : `No active session named ${alias}.`);
      return;
    }

    if (text === "/stopall") {
      const count = await this.sessionManager.stopAll(chatId);
      this.stopAllNotifiers(chatId);
      await this.sendMessage(chatId, `Stopped ${count} session(s).`);
      return;
    }

    if (text.startsWith("/select ")) {
      await this.handleSelectCommand(chatId, text);
      return;
    }

    await this.sendMessage(chatId, "Unknown command. Send /help for commands.");
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const chatId = callback.message?.chat.id;
    if (chatId === undefined) {
      return;
    }

    if (!this.isAllowed(chatId)) {
      await this.answerCallback(callback.id, "Unauthorized chat.");
      return;
    }

    const data = callback.data ?? "";
    if (data.startsWith("events:")) {
      const page = Number(data.split(":")[1]);
      await this.answerCallback(callback.id);
      await this.showEventsPage(chatId, Number.isInteger(page) ? page : 0, callback.message?.message_id);
      return;
    }

    if (data.startsWith("pick:")) {
      const index = Number(data.split(":")[1]);
      const event = this.eventsCache[index];
      if (!event) {
        await this.answerCallback(callback.id, "Event not found. Send /refresh.");
        return;
      }
      // Auto-create a short session alias and start streaming odds
      const alias = `a${Date.now()}`;
      let session: MatchSession | undefined;
      try {
        session = await this.sessionManager.startSession(chatId, alias, event, false);
      } catch (err) {
        await this.answerCallback(callback.id, "Failed to start session for event.");
        return;
      }

      // start notifier for this session so Telegram receives live odds
      this.startOddsNotifier(session);

      const keyboard = [[{ text: "BACK", callback_data: `bet:${alias}:BACK` }, { text: "LAY", callback_data: `bet:${alias}:LAY` }]];
      const oddsText = session?.latestOdds
        ? `\nCurrent odds: ${session.latestOdds.marketName ?? "-"} ${session.latestOdds.marketId ?? ""}`.trim()
        : "\nWaiting for live odds...";
      await this.answerCallback(callback.id, event.eventName);
      await this.sendMessage(chatId, `Selected: ${event.eventName}${oddsText}\nChoose side:`, keyboard);
    }

    if (data.startsWith("bet:")) {
      const parts = data.split(":");
      const alias = parts[1];
      const side = (parts[2] as BetSide) ?? "BACK";
      // store pending bet and ask for amount
      this.pendingBets.set(chatId, { alias, side });
      await this.answerCallback(callback.id);
      await this.sendMessage(chatId, `Enter amount to ${side} for session ${alias}:`);
      return;
    }

    }

  private async createSessionFromAlias(chatId: number, alias: string, event: EventFileRow): Promise<void> {
    const normalizedAlias = normalizeAlias(alias);
    if (!normalizedAlias) {
      await this.sendMessage(chatId, "Alias must be 1-24 chars: letters, numbers, underscore, or dash.");
      return;
    }

    try {
      const session = await this.sessionManager.startSession(chatId, normalizedAlias, event);
      this.pendingSelections.delete(chatId);
      // start notifier for this session
      this.startOddsNotifier(session);
      await this.sendMessage(
        chatId,
        `Started session '${session.alias}' for ${event.eventName}.\nUse /bet ${session.alias} BACK 500`,
      );
    } catch (error) {
      await this.sendMessage(chatId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleBetCommand(chatId: number, text: string): Promise<void> {
    const parts = text.split(/\s+/);
    const alias = parts[1] ?? "";
    const side = parts[2]?.toUpperCase();
    const amount = Number(parts[3]);

    if (!alias || (side !== "BACK" && side !== "LAY") || !Number.isFinite(amount) || amount <= 0) {
      await this.sendMessage(chatId, "Use /bet {alias} BACK 500 or /bet {alias} LAY 500.");
      return;
    }

    const result = await this.sessionManager.placeBet(chatId, alias, side as BetSide, amount);
    if (!result.ok) {
      await this.sendMessage(chatId, result.reason);
      return;
    }

    await this.sendMessage(
      chatId,
      [
        result.result.dryRun ? "Dry run bet payload built." : "Bet placed.",
        `Alias: ${alias}`,
        `Outcome: ${result.outcomeDesc} (${result.outcomeId})`,
        `Odds: ${result.oddValue} size ${result.oddSize}`,
        `Market: ${result.odds.marketName ?? "-"} ${result.odds.marketId ?? ""}`.trim(),
      ].join("\n"),
    );
  }

  private async handleSelectCommand(chatId: number, text: string): Promise<void> {
    const match = text.match(/^\/select\s+([a-zA-Z0-9_-]+)\s+"(.+)"$/);
    if (!match) {
      await this.sendMessage(chatId, 'Use /select alias "Exact Event Title"');
      return;
    }

    const [, alias, title] = match;
    const event = this.eventStore.findExactTitle(this.eventsCache, title);
    if (!event) {
      await this.sendMessage(chatId, `No exact event title found: ${title}`);
      return;
    }

    await this.createSessionFromAlias(chatId, alias, event);
  }

  private async showEventsPage(chatId: number, page: number, messageId?: number): Promise<void> {
    if (this.eventsCache.length === 0) {
      this.eventsCache = await this.eventStore.loadEvents();
    }

    const pageCount = Math.max(1, Math.ceil(this.eventsCache.length / pageSize));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const start = safePage * pageSize;
    const events = this.eventsCache.slice(start, start + pageSize);
    const keyboard = events.map((event, index) => [
      {
        text: event.eventName.slice(0, 60),
        callback_data: `pick:${start + index}`,
      },
    ]);

    const nav = [];
    if (safePage > 0) {
      nav.push({ text: "Prev", callback_data: `events:${safePage - 1}` });
    }
    if (safePage < pageCount - 1) {
      nav.push({ text: "Next", callback_data: `events:${safePage + 1}` });
    }
    if (nav.length > 0) {
      keyboard.push(nav);
    }

    const text = `Events page ${safePage + 1}/${pageCount}`;
    if (messageId) {
      await this.editMessage(chatId, messageId, text, keyboard);
    } else {
      await this.sendMessage(chatId, text, keyboard);
    }
  }

  private formatSessions(chatId: number): string {
    const sessions = this.sessionManager.listSessions(chatId);
    if (sessions.length === 0) {
      return "No active sessions. Send /events to select a match.";
    }

    return sessions
      .map((session) => {
        const odds = session.latestOdds;
        const oddsLine = odds
          ? `${odds.marketName ?? "-"} ${odds.marketId ?? ""} at ${odds.receivedAt}`.trim()
          : "waiting for odds";

        return [
          `${session.alias}: ${session.event.eventName}`,
          `eventId: ${session.event.eventId}`,
          `odds: ${oddsLine}`,
        ].join("\n");
      })
      .join("\n\n");
  }

  private async sendHelp(chatId: number): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        "Commands:",
        "/events - show event buttons",
        "/refresh - fetch latest events",
        "/sessions - list active sessions",
        "/bet {alias} BACK 500",
        "/stop {alias}",
        "/stopall",
      ].join("\n"),
    );
  }

  private isAllowed(chatId: number): boolean {
    return this.allowedChatIds.size === 0 || this.allowedChatIds.has(chatId);
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const response = await this.telegramRequest<TelegramUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });

    return response;
  }

  private startOddsNotifier(session: MatchSession): void {
    const key = `${session.chatId}:${session.alias}`;
    if (this.oddsNotifiers.has(key)) return;

    const sendIfChanged = () => {
      const odds = session.latestOdds;
      if (!odds) return;

      for (const side of ["BACK", "LAY"] as const) {
        const candidate = findCandidateForSide(odds, side as BetSide);
        if (!candidate) continue;

        const price = candidate.quote.price;
        const sideKey = `${key}:${side}`;
        const last = this.lastSentPrice.get(sideKey);
        if (last === price) continue;

        const text = `${candidate.runner.outcomeDesc ?? candidate.runner.outcomeId}: ${price} (size ${candidate.quote.size ?? 0})`;
        const keyboard = [[{ text: "BACK", callback_data: `bet:${session.alias}:BACK` }, { text: "LAY", callback_data: `bet:${session.alias}:LAY` }]];
        this.sendMessage(session.chatId, text, keyboard).catch(() => {});
        this.lastSentPrice.set(sideKey, price);
      }
    };

    // check every 2 seconds
    const interval = setInterval(sendIfChanged, 2000);
    this.oddsNotifiers.set(key, interval as unknown as ReturnType<typeof setInterval>);
  }

  private stopOddsNotifier(chatId: number, alias: string): void {
    const key = `${chatId}:${alias}`;
    const interval = this.oddsNotifiers.get(key);
    if (interval) {
      clearInterval(interval as unknown as number);
      this.oddsNotifiers.delete(key);
    }
    // remove lastSentPrice entries
    for (const side of ["BACK", "LAY"]) {
      this.lastSentPrice.delete(`${key}:${side}`);
    }
  }

  private stopAllNotifiers(chatId?: number): void {
    for (const key of Array.from(this.oddsNotifiers.keys())) {
      const [kChatIdStr] = key.split(":");
      const kChatId = Number(kChatIdStr);
      if (chatId === undefined || kChatId === chatId) {
        const interval = this.oddsNotifiers.get(key);
        if (interval) clearInterval(interval as unknown as number);
        this.oddsNotifiers.delete(key);
      }
    }
    if (chatId === undefined) {
      this.lastSentPrice.clear();
    } else {
      for (const side of ["BACK", "LAY"]) {
        // find keys for this chatId
        for (const k of Array.from(this.lastSentPrice.keys())) {
          if (k.startsWith(`${chatId}:`)) this.lastSentPrice.delete(k);
        }
      }
    }
  }

  private sendMessage(chatId: number, text: string, keyboard?: Array<Array<{ text: string; callback_data: string }>>): Promise<unknown> {
    return this.telegramRequest("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  private editMessage(chatId: number, messageId: number, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<unknown> {
    return this.telegramRequest("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  private answerCallback(callbackQueryId: string, text?: string): Promise<unknown> {
    return this.telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  private async telegramRequest<T>(method: string, body: unknown): Promise<T> {
    const response = await axios.post<{ ok: boolean; result: T; description?: string }>(
      `https://api.telegram.org/bot${this.token}/${method}`,
      body,
      {
        validateStatus: () => true,
      },
    );

    if (!response.data.ok) {
      throw new Error(response.data.description ?? `Telegram ${method} failed`);
    }

    return response.data.result;
  }
}
