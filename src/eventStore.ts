import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { BettingClient } from "./bettingClient.ts";
import type { EventSummary } from "./types.ts";

export type EventFileRow = {
  sportId: string;
  seriesId: string;
  seriesName: string;
  eventId: string;
  eventName: string;
  eventDate: string;
  marketId: string;
  marketName: string;
  marketType: string;
};

const dataDir = "data";
const eventsJsonPath = `${dataDir}/events.json`;
const eventsTextPath = `${dataDir}/events.txt`;

export class EventStore {
  constructor(private readonly client: BettingClient) {}

  async loadEvents(): Promise<EventFileRow[]> {
    const savedEvents = await this.readSavedEvents();
    if (savedEvents.length > 0) {
      return savedEvents;
    }

    return this.refreshEvents();
  }

  async refreshEvents(): Promise<EventFileRow[]> {
    await mkdir(dataDir, { recursive: true });
    const events = await this.client.getEvents();
    const rows = events.map(toEventFileRow);

    await writeFile(eventsJsonPath, JSON.stringify(rows, null, 2));
    await writeFile(eventsTextPath, toEventsText(rows));

    return rows;
  }

  async readSavedEvents(): Promise<EventFileRow[]> {
    try {
      const raw = await readFile(eventsJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(isEventFileRow);
    } catch {
      return [];
    }
  }

  findExactTitle(events: EventFileRow[], title: string): EventFileRow | undefined {
    return events.find((event) => event.eventName === title);
  }
}

export function toEventFileRow(event: EventSummary): EventFileRow {
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

export function isEventFileRow(value: unknown): value is EventFileRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return typeof row.eventId === "string" && typeof row.eventName === "string";
}

export function toEventsText(events: EventFileRow[]): string {
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
