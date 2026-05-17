import type { BotConfig } from "./config.ts";
import { normalizeOddsMessage, parseSocketFrames } from "./normalizers.ts";
import type { MarketOdds } from "./types.ts";

export type WaitForOddsInput = {
  eventId?: string;
  marketId?: string;
  timeoutMs?: number;
  subscribeMessages?: unknown[];
};

export type OddsStream = {
  close: () => void;
};

export type OddsStreamDiagnostics = {
  direction: "open" | "send" | "receive" | "parsed-unmatched" | "odds" | "error" | "close";
  value?: unknown;
};

export class OddsFeedClient {
  private socket?: WebSocket;

  constructor(private readonly config: BotConfig) {}

  waitForMarketOdds(input: WaitForOddsInput = {}): Promise<MarketOdds> {
    const timeoutMs = input.timeoutMs ?? this.config.oddsTimeoutMs;
    const subscribeMessages = input.subscribeMessages ?? this.config.oddsSubscribeMessages;

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.oddsFeedUrl);
      this.socket = socket;

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out waiting ${timeoutMs}ms for market odds.`));
      }, timeoutMs);

      socket.addEventListener("open", () => {
        for (const message of subscribeMessages) {
          socket.send(serializeSubscribeMessage(message, input));
        }
      });

      socket.addEventListener("message", (event) => {
        for (const frame of parseSocketFrames(event.data)) {
          const odds = normalizeOddsMessage(frame, input.eventId, input.marketId);
          if (!odds) {
            continue;
          }

          clearTimeout(timeout);
          socket.close();
          resolve(odds);
          return;
        }
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Odds websocket connection failed."));
      });
    });
  }

  streamMarketOdds(
    input: WaitForOddsInput = {},
    onOdds: (odds: MarketOdds) => void,
    onError: (error: Error) => void = () => {},
    onDiagnostics: (diagnostics: OddsStreamDiagnostics) => void = () => {},
  ): OddsStream {
    const subscribeMessages = input.subscribeMessages ?? this.config.oddsSubscribeMessages;
    const socket = new WebSocket(this.config.oddsFeedUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      onDiagnostics({ direction: "open", value: this.config.oddsFeedUrl });
      for (const message of subscribeMessages) {
        const payload = serializeSubscribeMessage(message, input);
        socket.send(payload);
        onDiagnostics({ direction: "send", value: payload });
      }
    });

    socket.addEventListener("message", (event) => {
      onDiagnostics({ direction: "receive", value: event.data });
      for (const frame of parseSocketFrames(event.data)) {
        const odds = normalizeOddsMessage(frame, input.eventId, input.marketId);
        if (odds) {
          onDiagnostics({ direction: "odds", value: odds });
          onOdds(odds);
        } else {
          onDiagnostics({ direction: "parsed-unmatched", value: frame });
        }
      }
    });

    socket.addEventListener("error", () => {
      const error = new Error("Odds websocket connection failed.");
      onDiagnostics({ direction: "error", value: error.message });
      onError(error);
    });

    socket.addEventListener("close", (event) => {
      onDiagnostics({
        direction: "close",
        value: {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        },
      });
    });

    return {
      close: () => socket.close(),
    };
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

function serializeSubscribeMessage(message: unknown, input: WaitForOddsInput): string {
  if (typeof message === "string") {
    return renderTemplate(message, input);
  }

  return renderTemplate(JSON.stringify(message), input);
}

function renderTemplate(value: string, input: WaitForOddsInput): string {
  return value
    .replaceAll("{eventId}", input.eventId ?? "")
    .replaceAll("{marketId}", input.marketId ?? "");
}
