import { sanitizeError } from "./error-sanitizer.js";

export type JulesTelemetryEvent =
  | "api_request" | "poll" | "checkpoint" | "retry" | "wait"
  | "dedupe" | "interaction" | "outcome" | "health";

export interface JulesTelemetryRecord {
  event: JulesTelemetryEvent;
  paperclipIssueId: string;
  julesSessionId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export type TelemetrySink = (record: JulesTelemetryRecord) => void | Promise<void>;

const SENSITIVE_KEY = /api[-_]?key|authorization|credential|password|prompt|secret|token/i;

export function redactTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTelemetry);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactTelemetry(entry)]));
  }
  return typeof value === "string" ? sanitizeError(value, { maxLen: 500 }) : value;
}

export function createTelemetry(
  paperclipIssueId: string,
  sink: TelemetrySink = (record) => console.log(JSON.stringify(record)),
) {
  return async (event: JulesTelemetryEvent, julesSessionId: string | null, fields: Record<string, unknown> = {}) => {
    const record = redactTelemetry({
      event,
      paperclipIssueId,
      julesSessionId,
      timestamp: new Date().toISOString(),
      ...fields,
    }) as JulesTelemetryRecord;
    await sink(record);
  };
}
