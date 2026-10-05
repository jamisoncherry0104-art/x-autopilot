/**
 * 拟人化行为模块：贝塞尔平滑滚动、随机延时、打字机式输入。
 * 目的不是"骗过检测"，而是让交互节奏接近真人，避免瞬间批量动作带来的异常特征。
 */

import { randomFloat } from '../shared/utils';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
}

/** [minMs, maxMs] 随机延时 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(randomFloat(Math.min(minMs, maxMs), Math.max(minMs, maxMs)));
}

/** 秒区间便捷写法 */
export function randomDelaySec(range: [number, number]): Promise<void> {
  return randomDelay(range[0] * 1000, range[1] * 1000);
}

/* ------------------------------------------------------------------ */
/* 三次贝塞尔缓动                                                      */
/* ------------------------------------------------------------------ */

/** 类 ease-in-out：起步慢、中段快、收尾慢，接近真人滚轮 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/* ------------------------------------------------------------------ */
/* 平滑滚动                                                            */
/* ------------------------------------------------------------------ */

export interface SmoothScrollOptions {
  /** 单次滚动执行的时长 */
  durationMs?: number;
  /** 分帧步数 */
  steps?: number;
  /** 结束后的微幅回退像素，模拟手滑 */
  overshoot?: number;
  /** 滚动容器；默认使用 window */
  container?: HTMLElement | null;
}

/**
 * 以贝塞尔缓动逐帧滚动，而不是一次性 scrollTo。
 * window 与自定义容器均支持。
 */
export async function smoothScrollBy(deltaY: number, opts: SmoothScrollOptions = {}): Promise<void> {
  const durationMs = opts.durationMs ?? randomFloat(400, 900);
  const steps = opts.steps ?? Math.max(8, Math.round(durationMs / 32));
  const overshoot = opts.overshoot ?? randomFloat(-24, 24);
  const container = opts.container ?? null;

  const startY = container ? container.scrollTop : window.scrollY;

  for (let i = 1; i <= steps; i += 1) {
    const t = easeInOutCubic(i / steps);
    const y = startY + deltaY * t;
    if (container) container.scrollTop = y;
    else window.scrollTo({ top: y, behavior: 'auto' });
    await sleep(durationMs / steps);
  }

  // 回弹
  if (Math.abs(overshoot) > 3) {
    const target = container ? container.scrollTop : window.scrollY;
    const over = target + overshoot;
    for (let i = 1; i <= 6; i += 1) {
      const t = easeOutQuad(i / 6);
      const y = over + (target - over) * t;
      if (container) container.scrollTop = y;
      else window.scrollTo({ top: y, behavior: 'auto' });
      await sleep(16);
    }
  }

  await randomDelay(120, 480);
}

/** 随机方向的小幅微滚动，用于营造"人在犹豫"的节奏 */
export async function microScroll(): Promise<void> {
  const delta = randomFloat(-180, 320);
  await smoothScrollBy(delta, { durationMs: randomFloat(260, 620) });
}

/** 一段"浏览"行为：连续 1~3 次滚动，间隔随机 */
export async function browseBurst(scrollRange: [number, number] = [280, 760]): Promise<void> {
  const times = Math.floor(randomFloat(1, 3.99));
  for (let i = 0; i < times; i += 1) {
    await smoothScrollBy(randomFloat(scrollRange[0], scrollRange[1]));
    await randomDelay(600, 2200);
  }
}

/** 把元素滚动到视口舒适位置（不顶到边缘） */
export async function scrollIntoComfortZone(el: Element): Promise<void> {
  const rect = el.getBoundingClientRect();
  const targetY = window.scrollY + rect.top - window.innerHeight * randomFloat(0.22, 0.34);
  const delta = targetY - window.scrollY;
  if (Math.abs(delta) < 40) return;
  await smoothScrollBy(delta, { durationMs: randomFloat(500, 1000) });
}

/* ------------------------------------------------------------------ */
/* 打字机输入                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把文本按"人类打字"的节奏分片输入。
 * 短句整段输入，长句按词组切分；标点后停留更久。
 */
export function chunkForTyping(text: string): string[] {
  if (text.length <= 12) return [text];
  const chunks: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    const isBreak = /[\s,，。.!！?？;；:：、]/.test(ch);
    if (buf.length >= 2 && isBreak) {
      chunks.push(buf);
      buf = '';
    } else if (buf.length >= 6) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 每个片段之间的打字停顿 */
export async function typingPause(chunk: string, baseSpeedMs = 28): Promise<void> {
  const perChar = randomFloat(baseSpeedMs * 0.6, baseSpeedMs * 1.6);
  await sleep(chunk.length * perChar);
  if (/[，,。.!！?？]/.test(chunk.slice(-1))) await randomDelay(120, 420);
}

/* ------------------------------------------------------------------ */
/* 行为门控：全局开关，紧急制动时立即打断所有延时                      */
/* ------------------------------------------------------------------ */

let abortFlag = false;

export function setHumanizerAborted(v: boolean): void {
  abortFlag = v;
}

export function isHumanizerAborted(): boolean {
  return abortFlag;
}

/** 可被紧急制动打断的延时 */
export async function interruptibleDelay(ms: number): Promise<boolean> {
  const step = 120;
  let elapsed = 0;
  while (elapsed < ms) {
    if (abortFlag) return false;
    await sleep(Math.min(step, ms - elapsed));
    elapsed += step;
  }
  return !abortFlag;
}
