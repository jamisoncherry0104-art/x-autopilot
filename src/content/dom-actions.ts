/**
 * DOM 交互模块：模拟真人点击、草稿注入、点赞、关注。
 *
 * 关键难点 —— Draft.js 输入框：
 * X.com 的编辑器是 contenteditable + Draft.js。直接设置 textContent 或 innerText
 * 不会触发 React 的内部状态更新，发送按钮会保持 disabled。
 * 必须走 document.execCommand('insertText') 或派发 beforeinput/input 事件，
 * 让 Draft.js 的 onBeforeInput 拦截到变更并同步内部 EditorState。
 */

import { X_SELECTORS } from '../shared/constants';
import { randomFloat, randomInt, sleep } from '../shared/utils';
import { findEditor, findEditors, firstVisible, isVisible, queryAll, sortByVisibility } from './dom-extractor';
import { interruptibleDelay, isHumanizerAborted, randomDelay, scrollIntoComfortZone, typingPause, chunkForTyping } from './humanizer';
import { isProfilePathForPath, pickProfileButton } from './profile-probe';

/* ------------------------------------------------------------------ */
/* 鼠标事件模拟                                                        */
/* ------------------------------------------------------------------ */

export interface ClickPointOptions {
  /** 是否先移动鼠标到目标（派发 mousemove） */
  humanMove?: boolean;
}

/**
 * 在元素上派发一套完整的指针事件序列。
 * Chrome 中 element.click() 对 React 合成事件是有效的，但缺少
 * pointerdown/mousedown/mouseup 序列时，某些控件（尤其是 Radix/Draft.js 体系）不会响应。
 */
export function humanClick(el: Element, opts: ClickPointOptions = {}): boolean {
  if (!isVisible(el)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  // 落在元素内部偏随机的位置，避免每次都命中几何中心
  const x = rect.left + rect.width * randomFloat(0.32, 0.68);
  const y = rect.top + rect.height * randomFloat(0.35, 0.65);
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0,
  };

  if (opts.humanMove !== false) {
    el.dispatchEvent(new PointerEvent('pointerover', { ...base, bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointermove', { ...base, bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousemove', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
  }

  el.dispatchEvent(new MouseEvent('click', base));
  return true;
}

/** 找到可点击的祖先按钮 */
function clickableAncestor(el: Element, depth = 6): Element {
  let cur: Element | null = el;
  for (let i = 0; i < depth && cur; i += 1) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'button' || cur.getAttribute('role') === 'button' || cur.getAttribute('role') === 'menuitem') {
      return cur;
    }
    cur = cur.parentElement;
  }
  return el;
}

/** 点击并等待一小段随机时间，模拟操作后的自然停顿 */
export async function clickWithPause(el: Element, afterMs: [number, number] = [280, 900]): Promise<boolean> {
  await scrollIntoComfortZone(el).catch(() => undefined);
  const target = clickableAncestor(el);
  const ok = humanClick(target);
  if (ok) await randomDelay(afterMs[0], afterMs[1]);
  return ok;
}

/**
 * 等到评论编辑器真正挂载。
 *
 * 注意两点：
 *  1. 这里**不要求「可见」**。X 可能把编辑器渲染在视口外（长评论喂入时文章被撑高），
 *     若把可见性作为硬条件，就会误判成"编辑器不存在"，被上层永久跳过。
 *  2. 返回**候选编辑器列表**（首个可见项优先）。调用方需要在浏览器持有选区时
 *     亲自动手 `editor.focus()` —— 沙箱里对非当前文档元素调 focus() 不会让
 *     `document.activeElement` 生效，含跨 frame 的情况，因此必须自己兜底。
 */
export async function waitForEditors(timeoutMs = 4000): Promise<HTMLElement[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = findEditors();
    if (hits.length > 0) return sortByVisibility(hits);
    if (Date.now() >= deadline) return [];
    await sleep(120);
  }
}

/** 兼容旧签名：返回首个候选编辑器（可能是视口外的） */
export async function waitForEditor(timeoutMs = 4000): Promise<HTMLElement | null> {
  const hits = await waitForEditors(timeoutMs);
  return hits[0] ?? null;
}

/** 编辑器是否已挂载（不要求可见）——用于区分"不存在"与"存在但被滚出视野" */
export function hasEditorInDom(): boolean {
  return findEditors().length > 0;
}

/* ------------------------------------------------------------------ */
/* Draft.js 草稿注入                                                   */
/* ------------------------------------------------------------------ */

/**
 * 聚焦编辑器并把光标放到内容末尾。
 *
 * 注意：这里刻意 **不调用 scrollIntoView**。
 * 平滑滚动是异步的，且会抢走/重置文档选区 —— 若在注入文本的过程中触发滚动，
 * 选区会被中途清空，insertText 注入随即失败。滚动请放在 fillEditor 的最前面一次做完。
 */
export function focusEditor(editor: HTMLElement): void {
  editor.focus();
  // 把光标放到内容末尾
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** 编辑器当前的纯文本（剔除 Draft.js 的零宽占位符） */
function editorPlainText(editor: HTMLElement): string {
  return (editor.textContent ?? '').replace(/\u200b/g, '');
}

/**
 * 用 beforeinput + input 事件手动注入文本。
 * 这是 execCommand 失败时的降级路径，也是部分 Chrome 版本唯一有效的路径。
 */
function insertTextViaInputEvent(editor: HTMLElement, text: string): void {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  // 关键 1：beforeinput（Draft.js 的 onBeforeInput 依赖它）
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: 'insertText',
    data: text,
  });
  editor.dispatchEvent(beforeInput);

  // 关键 2：真正改动 DOM，否则 React 重新渲染时会认为内容未变
  if (range) {
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  } else {
    editor.textContent = (editor.textContent ?? '') + text;
  }

  // 关键 3：input 事件让 React/Draft.js 同步 EditorState
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      composed: true,
      inputType: 'insertText',
      data: text,
    }),
  );
  // 部分受控组件监听 keyup 触发校验
  editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
}

/**
 * 将文本写入 X 的评论/发帖编辑器。
 *
 * 设计要点（都是踩过坑换来的）：
 *  1. **只相信可见的编辑器**。每次插入前重新解析"当前可见的编辑器"，
 *     而不是复用开始时抓到的元素引用 —— Draft 重渲染会让旧引用变成幽灵节点，
 *     往幽灵节点写只会让所见的内容停住不动，而幻影里越堆越多。
 *  2. **不回读编辑器状态**。部分环境下读到的 textContent 与用户所见并不同步，
 *     据此判断"没写进去"会把已经成功的写入重复执行上百次。
 *     因此这里用「提交前预检 + 只写不读」：写之前确认是空的，写的时候不回头验证。
 *  3. **写入目标必须属于当前视口**。用视口矩形判断候选编辑器是否真实存在并可见。
 *
 * @param text 目标文本
 * @param options.typewriter 是否使用分片打字（拟人化），默认 true
 * @returns 是否成功（注入了文本且未发生异常）
 */
export async function fillEditor(
  text: string,
  options: { typewriter?: boolean; editor?: HTMLElement | null } = {},
): Promise<boolean> {
  // 1) 编辑器可能尚未挂载：等它出现（不要求可见，视口外的也算存在）
  const candidates = options.editor ? [options.editor] : await waitForEditors();
  const editor = candidates.find(isInViewport) ?? candidates.find(isVisible) ?? null;
  if (!editor) return false;

  const typewriter = options.typewriter !== false;

  // 2) 先滚动露出编辑器。放在最前面，且只做一次 ——
  //    平滑滚动是异步的，若在注入期间触发会重置选区，导致后续注入全部空转。
  try {
    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    /* 忽略 */
  }
  await randomDelay(260, 620);

  return typewriter ? typewriterInto(editor, text) : writeAll(editor, text);
}

/** 一次性写完（不做逐片；也用于短文本） */
async function writeAll(editor: HTMLElement, text: string): Promise<boolean> {
  // 预检：只相信"当前可见的编辑器"，并把它置空
  const target = currentEditor() ?? editor;
  if (!isInViewport(target)) return false;

  emptyEditor(target);
  focusEditor(target);
  await sleep(60);

  pasteText(target, text);
  await randomDelay(320, 800);
  return true;
}

/** 逐片注入：每片只与选区/焦点打交道，不回头读编辑器内容 */
async function typewriterInto(editor: HTMLElement, text: string): Promise<boolean> {
  // 3) 预检：确认编辑器是空的。Draft 常留一个零宽占位，属正常。
  //    若这里发现已有内容，说明上一轮没清干净 —— 直接放弃，绝不叠加。
  const probe = currentEditor() ?? editor;
  if (!isInViewport(probe)) return false;
  if (editorPlainText(probe).length > 0) {
    if (!emptyEditor(probe)) return false;
  }

  const chunks = chunkForTyping(text);

  for (const chunk of chunks) {
    if (isHumanizerAborted()) return false;

    // 每片都重新解析一次可见编辑器：Draft 重渲染后旧引用会失效
    const target = currentEditor() ?? probe;
    if (!isInViewport(target)) return false;

    // 只写不读：无法可靠回读编辑器状态，读回来的结果会误导判断并引发重复写入
    pasteText(target, chunk);
    await typingPause(chunk);
  }

  await randomDelay(320, 800);
  return true;
}

/** 解析当前视口内的编辑器（每次调用都重新解析，不复用旧引用） */
function currentEditor(): HTMLElement | null {
  const hits = findEditors();
  return hits.find(isInViewport) ?? hits.find(isVisible) ?? null;
}

/** 元素是否真实存在于视口内（不用 getComputedStyle，避免跨 frame 异常） */
function isInViewport(el: Element): boolean {
  try {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  } catch {
    return false;
  }
}

/** 清空编辑器；返回清空后是否确实为空 */
function emptyEditor(editor: HTMLElement): boolean {
  focusEditor(editor);
  try {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      sel.deleteFromDocument();
    }
    document.execCommand('delete', false);
  } catch {
    /* 落到直接置空 */
  }
  try {
    editor.textContent = '';
  } catch {
    /* 忽略 */
  }
  notifyChange(editor, 'deleteContentBackward');
  return editorPlainText(editor).length === 0;
}

/**
 * 把文本写进编辑器。
 *
 * 只在选区确实位于该编辑器内时使用 execCommand（它会改写真实文档），
 * 否则用事件通路。两条通路都不回读 DOM 来决策。
 */
function pasteText(editor: HTMLElement, text: string): void {
  focusEditor(editor);
  const sel = window.getSelection();
  const inEditor =
    document.activeElement === editor && !!sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).startContainer);

  if (inEditor) {
    try {
      document.execCommand('insertText', false, text);
      return;
    } catch {
      /* 落到事件通路 */
    }
  }
  insertTextViaInputEvent(editor, text);
}

/** 派发一次 input 事件，让 React/Draft 同步内部状态 */
function notifyChange(editor: HTMLElement, inputType: string): void {
  editor.dispatchEvent(
    new InputEvent('input', { bubbles: true, cancelable: false, composed: true, inputType, data: null }),
  );
  editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
}


/* ------------------------------------------------------------------ */
/* 按钮定位与点击                                                      */
/* ------------------------------------------------------------------ */

/** 在指定作用域内找到发送/回复按钮，并确认其已启用 */
export function findSubmitButton(scope: ParentNode = document): HTMLButtonElement | null {
  const selectors = [X_SELECTORS.replyButton, X_SELECTORS.tweetButton];
  for (const sel of selectors) {
    const btn = Array.from(scope.querySelectorAll<HTMLButtonElement>(sel)).find((b) => {
      if (!isVisible(b)) return false;
      // disabled 或 aria-disabled=true 时按钮未激活
      if (b.disabled) return false;
      if (b.getAttribute('aria-disabled') === 'true') return false;
      return true;
    });
    if (btn) return btn;
  }
  return null;
}

/** 等待发送按钮变为可用（Draft.js 同步是异步的） */
export async function waitForSubmitEnabled(timeoutMs = 6000): Promise<HTMLButtonElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = findSubmitButton();
    if (btn) return btn;
    await sleep(150);
  }
  return null;
}

/** 提交评论：优先点详情页 inline 按钮，其次弹窗 tweetButton */
export async function submitComment(): Promise<{ ok: boolean; reason?: string }> {
  const btn = await waitForSubmitEnabled();
  if (!btn) return { ok: false, reason: '未找到可用的发送按钮（可能编辑器未成功注入文本）' };

  const ok = await clickWithPause(btn, [400, 1100]);
  if (!ok) return { ok: false, reason: '发送按钮点击事件派发失败' };

  await randomDelay(900, 1800);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 点赞 / 关注                                                         */
/* ------------------------------------------------------------------ */

/** 点赞指定推文；已点赞则返回 skipped */
export async function likeArticle(article: Element): Promise<'liked' | 'already' | 'failed'> {
  if (article.querySelector(X_SELECTORS.likeActive)) return 'already';
  const btn = article.querySelector(X_SELECTORS.like) ?? article.querySelector(`[data-testid="like"]`);
  if (!btn) return 'failed';
  const ok = await clickWithPause(btn, [500, 1400]);
  if (!ok) return 'failed';
  // 校验状态是否翻转
  await sleep(320);
  return article.querySelector(X_SELECTORS.likeActive) ? 'liked' : 'failed';
}

/**
 * 关注作者：优先使用推文内的关注按钮；
 * 时间线上的推文通常没有关注按钮，需要点进 Profile —— 这里只做前者，
 * 后者交给 service worker 决定是否值得跳转，避免打断巡航节奏。
 */
export async function followAuthor(article: Element): Promise<'followed' | 'already' | 'unavailable' | 'failed'> {
  if (article.querySelector(X_SELECTORS.unfollow)) return 'already';

  let btn = article.querySelector<HTMLElement>(X_SELECTORS.follow);
  if (!btn) {
    // 悬停作者名时出现的快捷关注按钮
    const handleLink = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')).find((a) =>
      (a.textContent ?? '').trim().startsWith('@'),
    );
    if (handleLink) {
      handleLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 0, clientY: 0 }));
      await randomDelay(200, 500);
      btn = document.querySelector<HTMLElement>('[data-testid$="-follow"]');
    }
  }

  if (!btn) return 'unavailable';

  // 先记住"关注前"的状态，点击后据此判断是否真的翻转了
  const wasFollowing = needsShallowCheck(article);
  const ok = await clickWithPause(btn, [600, 1600]);
  if (!ok) return 'failed';
  await randomDelay(600, 1400);

  // 校验状态翻转：出现 unfollow 才算关注成功。
  // 原实现写成 `? 'followed' : 'followed'`，等于无条件报成功，
  // 会让上层日志显示"已关注"但实际没点上。
  const nowFollowing = document.querySelector(X_SELECTORS.unfollow) !== null;
  if (nowFollowing && !wasFollowing) return 'followed';
  return nowFollowing ? 'already' : 'failed';
}

/** 关注前的状态探测（详情页关注按钮可能不在 article 内） */
function needsShallowCheck(article: Element): boolean {
  if (article.querySelector(X_SELECTORS.unfollow)) return true;
  return document.querySelector(X_SELECTORS.unfollow) !== null;
}

/**
 * 关注详情页的主推文作者。
 *
 * 详情页的关注按钮不一定在推文块内（X 会把它放在主推文的操作栏），
 * 因此这里按优先级探测：
 *  1) 主推文 article 内（含悬停才出现的快捷按钮）
 *  2) `[data-testid="placementTracking"]` 主区域内的第一个关注按钮
 * 都没有就返回 unavailable，交由上层提示"该页面没有关注入口"。
 */
export async function followAuthorOnDetailPage(): Promise<'followed' | 'already' | 'unavailable' | 'failed'> {
  const mainArticle = document.querySelector(X_SELECTORS.tweet);
  if (mainArticle) {
    const res = await followAuthor(mainArticle);
    if (res !== 'unavailable') return res;
  }

  // 主推文块内没有：找主栏里第一个未被禁用的关注按钮
  const primary = document.querySelector(X_SELECTORS.primaryColumn) ?? document;
  const btn = Array.from(primary.querySelectorAll<HTMLElement>('[data-testid$="-follow"]')).find((b) => isVisible(b));
  if (!btn) {
    // 已关注的情况：存在 unfollow 按钮
    const unfollow = Array.from(primary.querySelectorAll<HTMLElement>('[data-testid$="-unfollow"]')).find((b) =>
      isVisible(b),
    );
    if (unfollow) return 'already';
    return 'unavailable';
  }

  const ok = await clickWithPause(btn, [600, 1600]);
  if (!ok) return 'failed';
  await randomDelay(500, 1200);
  // 校验状态翻转：点完应出现 unfollow
  return document.querySelector(X_SELECTORS.unfollow) ? 'followed' : 'failed';
}

/* ------------------------------------------------------------------ */
/* 作者主页关注                                                        */
/* ------------------------------------------------------------------ */

/**
 * 判断当前页面是否为指定用户的个人主页。
 * URL 判定逻辑集中在 profile-probe.ts，与 useStorage 的详情页判定同源约束。
 */
function isProfilePathFor(handle: string): boolean {
  return isProfilePathForPath(location.pathname, handle);
}

/**
 * 关注「个人主页」上的作者。
 *
 * 与 followAuthorOnDetailPage 的关键差别：主页的关注按钮**不在推文块里**，
 * 而位于页面头部的个人资料区。定位策略（见 profile-probe.ts）：
 *   1) 主栏内第一个「可见且未禁用」的 follow 按钮（多候选取最宽，避开迷你按钮）；
 *   2) 若存在可见的 unfollow 按钮，直接判定为「已关注」。
 *
 * 关注前会校验 URL 的 handle 与目标一致；不一致直接返回 unavailable，
 * 避免把「恰好打开的别的页面」上的按钮点掉。
 */
export async function followProfileOnPage(
  handle: string,
): Promise<'followed' | 'already' | 'unavailable' | 'failed'> {
  if (!isProfilePathFor(handle)) {
    // 页面尚未切到目标主页（SPA 还在渲染 / 停在别处），交由上层重试或提示
    return 'unavailable';
  }

  const primary = document.querySelector<HTMLElement>(X_SELECTORS.primaryColumn) ?? document.body;

  // 已关注：资料区存在 unfollow 按钮
  if (pickProfileButton(primary, 'unfollow')) return 'already';

  const followBtn = pickProfileButton(primary, 'follow');
  if (!followBtn) return 'unavailable';

  const ok = await clickWithPause(followBtn, [600, 1600]);
  if (!ok) return 'failed';
  await randomDelay(600, 1400);

  // 校验状态翻转：点完必须出现 unfollow，否则视为失败（不做无条件报成功）
  return pickProfileButton(primary, 'unfollow') ? 'followed' : 'failed';
}

/* ------------------------------------------------------------------ */
/* 详情页入口                                                          */
/* ------------------------------------------------------------------ */

/** 从推文块中取出永久链接（/status/数字） */
function permalinkOf(article: Element): HTMLAnchorElement | null {
  return (
    Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).find((a) =>
      /\/status\/\d+$/.test(a.getAttribute('href') ?? ''),
    ) ?? null
  );
}

/**
 * 点进目标推文的详情页，并等到详情页真正就绪。
 *
 * 点击后**轮询确认 URL 已切换且主推文已渲染**，避免"点了但 SPA 还没渲染完"
 * 就继续下一步（这会让后续的编辑器定位落到旧页面上）。
 *
 * @returns 详情页永久链接；未能进入返回 null
 */
/**
 * 点进目标推文的详情页，并等到详情页真正就绪。
 *
 * 点击后**轮询确认 URL 已切换且主推文已渲染**，避免"点了但 SPA 还没渲染完"
 * 就继续下一步（这会让后续的编辑器定位落到旧页面上）。
 *
 * 注意：这里刻意**不做 `location.assign` 这类硬导航兜底** ——
 * 硬导航会卸载 content script，正在执行的 `CS_AUTO_ROUND` 通道随之断开，
 * service worker 会收到一个无意义的错误。X 的时间戳链接是标准 SPA 路由，
 * 点击必然生效；万一没跳成功，直接返回 null 让上层跳过该条更安全。
 *
 * @returns 详情页永久链接；未能进入返回 null
 */
export async function enterDetailPage(article: Element): Promise<string | null> {
  const link = permalinkOf(article);
  const href = link?.getAttribute('href');
  if (!link || !href) return null;

  // 目标路径（去掉查询串与锚点），用于确认 SPA 确实跳过去了
  const targetPath = href.split('?')[0].split('#')[0];

  await clickWithPause(link, [600, 1400]);

  // 等 URL 切换 + 主推文正文渲染（两者都满足才算就绪）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (location.pathname.startsWith(targetPath) && document.querySelector(X_SELECTORS.tweetText)) {
      await randomDelay(400, 1000);
      return `${location.origin}${targetPath}`;
    }
    await sleep(200);
  }
  return null;
}

/** 展开评论区（详情页的回复按钮会聚焦到编辑器） */
export async function focusReplyEditor(article: Element): Promise<boolean> {
  const replyBtn = article.querySelector<HTMLElement>(X_SELECTORS.replyButton);
  if (replyBtn && isVisible(replyBtn)) {
    await clickWithPause(replyBtn, [400, 900]);
    await randomDelay(300, 800);
  }
  // 编辑器是点完回复后才渲染的，必须等待其挂载，否则上层会误判"编辑器不可用"
  return (await waitForEditor()) !== null;
}

/**
 * 等到详情页的主推文渲染出来。
 *
 * 详情页是 SPA 异步渲染的：URL 已经切过去、但 `article[data-testid="tweet"]`
 * 可能还没挂载。若此时直接 querySelector 取一次就判定"未找到主推文"，
 * 会把「还没渲染」误判成「不存在」，整条评论被无谓跳过。
 *
 * @returns 主推文元素；超时返回 null
 */
export async function waitForMainArticle(timeoutMs = 4000): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = document.querySelector<HTMLElement>(X_SELECTORS.tweet);
    if (el) return el;
    if (Date.now() >= deadline) return null;
    await sleep(120);
  }
}

/** 随机阅读停留，模拟真人在评论区思考 */
export async function readingDwell(rangeMs: [number, number]): Promise<boolean> {
  const ms = randomInt(rangeMs[0], rangeMs[1]);
  return interruptibleDelay(ms);
}

/**
 * 从详情页返回上一条推文所在的时间线。
 *
 * 优先点详情页头部的返回按钮（X 的 `[data-testid="app-bar-back"]`），
 * 它走的是 SPA 回退、能保留时间线滚动位置；找不到按钮才退化为 history.back()。
 *
 * @returns 是否已切回时间线
 */
export async function goBackToTimeline(): Promise<boolean> {
  const backBtn = document.querySelector<HTMLElement>('[data-testid="app-bar-back"]');
  if (backBtn && isVisible(backBtn)) {
    await clickWithPause(backBtn, [500, 1200]);
  } else {
    try {
      history.back();
    } catch {
      return false;
    }
  }

  // 等到离开详情页（不再是 /status/ 路径）
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!/^\/[^/]+\/status\/\d+/.test(location.pathname)) {
      await randomDelay(400, 1000);
      return true;
    }
    await sleep(200);
  }
  return false;
}

export { queryAll, firstVisible, isVisible, findEditor };
