declare const _brand: unique symbol;
export type Brand<T, B> = T & { [_brand]: B };

export type PaperclipId = Brand<string, 'PaperclipId'>;
export type JulesSessionName = Brand<string, 'JulesSessionName'>;
export type JulesSessionId = Brand<string, 'JulesSessionId'>;
export type JulesActivityId = Brand<string, 'JulesActivityId'>;
export type PrUrl = Brand<string, 'PrUrl'>;

export function isPaperclipId(val: unknown): val is PaperclipId { return typeof val === 'string' && val.length > 0; }
export function isJulesSessionName(val: unknown): val is JulesSessionName { return typeof val === 'string' && val.length > 0; }
export function isJulesSessionId(val: unknown): val is JulesSessionId { return typeof val === 'string' && val.length > 0; }
export function isJulesActivityId(val: unknown): val is JulesActivityId { return typeof val === 'string' && val.length > 0; }
export function isPrUrl(val: unknown): val is PrUrl { return typeof val === 'string' && val.startsWith('http'); }

export function asPaperclipId(val: string): PaperclipId {
  if (!isPaperclipId(val)) throw new Error("Invalid PaperclipId");
  return val;
}
export function asJulesSessionName(val: string): JulesSessionName {
  if (!isJulesSessionName(val)) throw new Error("Invalid JulesSessionName");
  return val;
}
export function asJulesSessionId(val: string): JulesSessionId {
  if (!isJulesSessionId(val)) throw new Error("Invalid JulesSessionId");
  return val;
}
export function parseJulesSessionName(value: string): JulesSessionName {
  if (!value) throw new Error("Invalid JulesSessionName");
  return value as JulesSessionName;
}
export function toJulesSessionId(name: JulesSessionName): JulesSessionId {
  const parts = name.split('/');
  return parts[parts.length - 1] as JulesSessionId;
}

export function asJulesActivityId(val: string): JulesActivityId {
  if (!isJulesActivityId(val)) throw new Error("Invalid JulesActivityId");
  return val;
}
export function asPrUrl(val: string): PrUrl {
  if (!isPrUrl(val)) throw new Error("Invalid PrUrl");
  return val;
}
