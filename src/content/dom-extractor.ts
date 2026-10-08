import { X_SELECTORS } from '../shared/constants';
import type { TweetSnapshot } from '../shared/types';
import { fingerprint } from '../shared/utils';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\u200b/g, '').trim();
}

export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

export function queryAll<T extends Element = Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function firstVisible<T extends Element = Element>(selector: string, root: ParentNode = document): T | null {
  return queryAll<T>(selector, root).find(isVisible) ?? null;
}

/* ------------------------------------------------------------------ */
/* 单条推文解析                                                        */
/* ------------------------------------------------------------------ */

/** 从 User-Name 区块中提取显示名与 handle */
export function parseUserName(article: Element): { authorName: string; authorHandle: string } {
  const block = article.querySelector(X_SELECTORS.userName);
  if (!block) return { authorName: '', authorHandle: '' };

  // handle 一定带 @ 前缀，这是比 class 更可靠的锚点
  const links = Array.from(block.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'));
  let handle = '';
  let name = '';

  for (const a of links) {
    const t = textOf(a);
    if (t.startsWith('@')) {
      handle = t.slice(1);
    } else if (!name && t && !/^\d/.test(t) && t !== '·') {
      name = t;
    }
  }

  if (!handle) {
    // 降级：从 href 里取第一个非保留路径段
    const reserved = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search', 'compose']);
    for (const a of links) {
      const seg = a.getAttribute('href')?.split('/').filter(Boolean)[0];
      if (seg && !reserved.has(seg)) {
        handle = seg;
        break;
      }
    }
  }

  if (!name) name = handle;
  return { authorName: name, authorHandle: handle };
}

/** 判断 article 是否为转推 */
export function isRetweet(article: Element): boolean {
  const social = article.querySelector('[data-testid="socialContext"]');
  const label = textOf(social).toLowerCase();
  return label.includes('repost') || label.includes('转推') || label.includes('retweet');
}

/** 推文正文（可能为多段） */
export function extractText(article: Element): string {
  const nodes = article.querySelectorAll(X_SELECTORS.tweetText);
  if (nodes.length === 0) return '';
  return Array.from(nodes)
    .map((n) => textOf(n))
    .filter(Boolean)
    .join('\n');
}

/** 从推文内时间链接解析永久地址 */
export function extractUrl(article: Element): string | null {
  const links = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'));
  for (const a of links) {
    const href = a.getAttribute('href');
    if (href && /\/status\/\d+/.test(href)) {
      return new URL(href, location.origin).toString();
    }
  }
  return null;
}

/** 是否已关注（依据 follow/unfollow 按钮） */
export function extractFollowing(article: Element): boolean | null {
  if (article.querySelector(X_SELECTORS.unfollow)) return true;
  if (article.querySelector(X_SELECTORS.follow)) return false;
  return null;
}

export function isReply(article: Element): boolean {
  // 详情页/时间线中，回复通常有 "Replying to @xxx" 提示
  const spans = Array.from(article.querySelectorAll('div[dir="ltr"] > span'));
  return spans.some((s) => /^(Replying to|回复)/i.test(textOf(s)));
}

/** 解析单条推文为快照 */
export function parseArticle(article: Element): TweetSnapshot {
  const text = extractText(article);
  const { authorName, authorHandle } = parseUserName(article);
  const url = extractUrl(article);
  return {
    text,
    authorName,
    authorHandle,
    following: extractFollowing(article),
    url,
    capturedAt: Date.now(),
    isRetweet: isRetweet(article),
    isReply: isReply(article),
    fingerprint: fingerprint(`${authorHandle}::${text}`),
  };
}

/* ------------------------------------------------------------------ */
/* 页面级抓取                                                          */
/* ------------------------------------------------------------------ */

/** 取在视口中可见的推文（按与视口中心的距离排序，最近的优先） */
export function visibleArticles(): Element[] {
  const centerY = window.innerHeight / 2;
  return queryAll(X_SELECTORS.tweet)
    .filter(isVisible)
    .filter((a) => !a.closest('[data-testid="sidebarColumn"]'))
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return Math.abs(ra.top - centerY) - Math.abs(rb.top - centerY);
    });
}

/** 时间线：批量抓取可见推文 */
export function extractTimeline(limit = 30): TweetSnapshot[] {
  const out: TweetSnapshot[] = [];
  for (const article of visibleArticles()) {
    const snap = parseArticle(article);
    // 过滤掉「推荐关注」这类无正文的卡片
    if (!snap.text && !snap.authorHandle) continue;
    if (!snap.text) continue;
    out.push(snap);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 详情页抓取：主推文 = 视口内最上方且拥有最大正文块的那条；
 * 其余位于其上方的作为 ancestors，提供上下文给 LLM。
 */
export function extractDetail(): { main: TweetSnapshot; ancestors: TweetSnapshot[] } | null {
  const articles = queryAll(X_SELECTORS.tweet).filter(isVisible);
  if (articles.length === 0) return null;

  // 兜底：primaryColumn 不存在时，取第一条含正文块的 tweet（排除纯转发/媒体卡）
  let mainEl: Element | null = articles.find((a) => a.querySelector(X_SELECTORS.tweetText)) ?? null;

  // 更精确：主推文在 DOM 中通常位于 primaryColumn 内第一个含 tweetText 且不是 reply 的 article
  const primary = document.querySelector(X_SELECTORS.primaryColumn);
  if (primary) {
    const candidates = queryAll(X_SELECTORS.tweet, primary).filter((a) => a.querySelector(X_SELECTORS.tweetText));
    if (candidates.length > 0) {
      // 主推文为 URL 中 status id 匹配的那条
      const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1];
      const matched = statusId
        ? candidates.find((a) => a.querySelector(`a[href*="/status/${statusId}"]`))
        : undefined;
      mainEl = matched ?? candidates[0];
    }
  }

  if (!mainEl) return null;

  const main = parseArticle(mainEl);
  const mainTop = mainEl.getBoundingClientRect().top;
  const ancestors = articles
    .filter((a) => a !== mainEl && a.getBoundingClientRect().top < mainTop)
    .map(parseArticle)
    .filter((s) => s.text)
    .slice(-3);

  return { main, ancestors };
}

/* ------------------------------------------------------------------ */
/* 自检报告                                                            */
/* ------------------------------------------------------------------ */

export interface SelftestRow {
  found: boolean;
  count: number;
  selector: string;
}

/** editor 选择器单独做多候选探测 */
export function findEditor(): HTMLElement | null {
  const candidates = [X_SELECTORS.editor, X_SELECTORS.editorFallback, 'div[contenteditable="true"][role="textbox"]'];
  for (const sel of candidates) {
    const hit = firstVisible<HTMLElement>(sel);
    if (hit) return hit;
  }
  return null;
}

/**
 * 收集全部候选编辑器（**不要求可见**）。
 *
 * 为什么需要：X 在长评论场景下会把编辑器渲染到视口之外，此时 firstVisible()
 * 会返回 null，导致上游误判"编辑器不存在"。凡是"是否存在"的判定都必须用这里，
 * 只有"该往哪个填"才谈得上可见性优先。
 */
export function findEditors(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const selectors = [X_SELECTORS.editor, X_SELECTORS.editorFallback, 'div[contenteditable="true"][role="textbox"]'];
  for (const sel of selectors) {
    for (const el of queryAll<HTMLElement>(sel)) {
      if (!out.includes(el)) out.push(el);
    }
  }
  return out;
}

/** 可见项排前面，其余按 DOM 顺序保留 */
export function sortByVisibility(els: HTMLElement[]): HTMLElement[] {
  const visible = els.filter(isVisible);
  const hidden = els.filter((el) => !isVisible(el));
  return [...visible, ...hidden];
}

export function probeSelectors() {
  const mk = (sel: string): SelftestRow => {
    const all = queryAll(sel);
    return { found: all.length > 0, count: all.length, selector: sel };
  };
  return {
    tweetArticle: mk(X_SELECTORS.tweet),
    tweetText: mk(X_SELECTORS.tweetText),
    userName: mk(X_SELECTORS.userName),
    editor: {
      found: findEditor() !== null,
      count: queryAll(X_SELECTORS.editor).length,
      selector: `${X_SELECTORS.editor} / ${X_SELECTORS.editorFallback}`,
    },
    replyButton: mk(X_SELECTORS.replyButton),
    likeButton: mk(X_SELECTORS.like),
    followButton: mk(`${X_SELECTORS.follow}, ${X_SELECTORS.unfollow}`),
    url: location.href,
    checkedAt: Date.now(),
  };
}
