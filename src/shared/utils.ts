/** className 合并工具（等价 shadcn 的 cn，不引入额外依赖成本） */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** [min, max] 区间随机整数 */
export function randomInt(min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/** [min, max] 区间随机浮点 */
export function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 概率命中 */
export function chance(p: number): boolean {
  return Math.random() < clamp(p, 0, 1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** 秒 -> "1m 23s" 可读时长 */
export function humanDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 简易稳定指纹（FNV-1a 变体），用于推文去重 */
export function fingerprint(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
