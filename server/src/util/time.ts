/** 时间工具：全库统一使用 ISO-8601 UTC 字符串，避免时区歧义 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}

/** 解析 Headscale 返回的时间戳；空值/非法返回 null */
export function parseHsTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 距今秒数；无值返回 null */
export function secondsSince(value: unknown): number | null {
  const d = parseHsTime(value);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

/** ISO 时间差（秒） */
export function diffSeconds(fromIso: string, toIso: string): number {
  return Math.max(0, Math.floor((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
}
