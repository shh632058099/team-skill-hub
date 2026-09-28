import type { EventSink } from "./types.js";

export class LoggingEventSink implements EventSink {
  emit(event: string, payload: Record<string, unknown>): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...payload }));
  }
}
