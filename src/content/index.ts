/**
 * Content Script 入口。
 *
 * 两种通信通道刻意区分开：
 *  1) 手动模式：sidepanel 直接 chrome.tabs.sendMessage 到本标签页，要求快速响应；
 *  2) 自动模式：service worker 无法可靠地在 MV3 中长期持有标签页通道，
 *     因此由本脚本主动向 SW 请求「原子步骤」（取标签页 / 延时 / 记录日志），
 *     SW 只做调度与状态，不在 SW 里操作 DOM。
 */

import type { Result, SelfTestReport, TweetDetailContext, TweetSnapshot, ToContentMessage } from '../shared/types';
import { extractDetail, extractTimeline, parseArticle, probeSelectors, visibleArticles } from './dom-extractor';
import {
  fillEditor,
  followAuthorOnDetailPage,
  followProfileOnPage,
  hasEditorInDom,
  followAuthor,
  likeArticle,
  readingDwell,
  submitComment,
} from './dom-actions';
import {
  browseBurst,
  interruptibleDelay,
  isHumanizerAborted,
  microScroll,
  randomDelay,
  scrollIntoComfortZone,
  setAutoRoundInFlight,
  setHumanizerAborted,
  smoothScrollBy,
} from './humanizer';

/* ------------------------------------------------------------------ */
/* 与 service worker 的握手                                            */
/* ------------------------------------------------------------------ */

async function sendToSw<T = unknown>(message: unknown): Promise<Result<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(message)) as Result<T> | undefined;
    return res ?? { ok: false, error: 'service worker 无响应' };
  } catch (err) {
    return { ok: false, error: `消息发送失败：${(err as Error).message}` };
  }
}

function swLog(level: 'INFO' | 'ACTION' | 'WAIT' | 'WARNING' | 'ERROR' | 'DONE', message: string): void {
  void sendToSw({ type: 'SW_LOG', level, message, scope: 'DOM' });
}

/* ------------------------------------------------------------------ */
/* 手动模式指令处理                                                    */
/* ------------------------------------------------------------------ */

type Handler = (msg: ToContentMessage) => Promise<Result<unknown>>;

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (error: string, code?: string): Result<never> => ({ ok: false, error, code });

const handlers: Record<ToContentMessage['type'], Handler> = {
  async CS_PING() {
    return ok({ url: location.href, ready: true });
  },

  async CS_EXTRACT() {
    const detail = extractDetail();
    if (detail && detail.main.text) {
      return ok<TweetDetailContext>(detail);
    }
    const timeline = extractTimeline(20);
    if (timeline.length === 0) {
      return fail('当前页面未找到可抓取的推文，请确认已打开 X 的推文详情页或首页时间线', 'NO_TWEET');
    }
    const synthesized: TweetDetailContext = { main: timeline[0], ancestors: [] };
    return ok<TweetDetailContext>(synthesized);
  },

  async CS_FILL(msg) {
    if (msg.type !== 'CS_FILL') return fail('消息类型不匹配');
    if (!msg.text?.trim()) return fail('待注入文本为空', 'EMPTY_TEXT');
    const success = await fillEditor(msg.text, { typewriter: true });
    if (!success) {
      // 区分两种失败：编辑器根本没挂载 vs 已挂载但不在可写入状态。
      // 用 hasEditorInDom() 而非 findEditor()：后者要求"可见"，
      // 而 X 在长评论场景下会把编辑器渲染到视口外，会被误判成"不存在"。
      if (!hasEditorInDom()) {
        return fail(
          '未找到评论编辑器。请先在推文下方点击「回复」展开输入框，并确认页面已完全加载后再试。',
          'EDITOR_MISSING',
        );
      }
      return fail(
        '评论框暂时无法写入。请滚动到评论框位置、手动点击一下使其获得焦点，然后重试。',
        'FILL_FAILED',
      );
    }
    return ok({ filled: true, chars: msg.text.length });
  },

  async CS_SUBMIT() {
    const result = await submitComment();
    return result.ok ? ok({ submitted: true }) : fail(result.reason ?? '发送失败', 'SUBMIT_FAILED');
  },

  async CS_FOLLOW() {
    const outcome = await followAuthorOnDetailPage();
    if (outcome === 'failed') return fail('关注操作未能生效，可能被风控拦截', 'FOLLOW_FAILED');
    return ok({ outcome });
  },

  async CS_FOLLOW_PROFILE(msg) {
    if (msg.type !== 'CS_FOLLOW_PROFILE') return fail('消息类型不匹配');
    const outcome = await followProfileOnPage(msg.handle);
    if (outcome === 'failed') return fail('关注操作未能生效，可能被风控拦截', 'FOLLOW_FAILED');
    return ok({ outcome });
  },

  async CS_HUMAN_DELAY(msg) {
    if (msg.type !== 'CS_HUMAN_DELAY') return fail('消息类型不匹配');
    await randomDelay(msg.minMs, msg.maxMs);
    return ok({ waited: true });
  },

  async CS_SELFTEST() {
    return ok<SelfTestReport>(probeSelectors());
  },
};

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

const manualRouter = (
  message: ToContentMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean => {
  const handler = handlers[message?.type as ToContentMessage['type']];
  if (!handler) return false;

  handler(message)
    .then(sendResponse)
    .catch((err: Error) => sendResponse(fail(`执行异常：${err.message}`, 'HANDLER_THROWN')));
  return true; // 保持通道打开以支持异步响应
};

/* ------------------------------------------------------------------ */
/* 自动模式：由本脚本驱动的原子步骤                                    */
/* ------------------------------------------------------------------ */

/** 轮次内的节奏停顿：本地随机取时长，可被紧急制动打断 */
async function humanPause(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.round(minMs + Math.random() * Math.max(0, maxMs - minMs));
  await interruptibleDelay(ms);
}

/**
 * 单轮巡航的完整执行体。
 * 调用方（service worker）通过 SW_EXECUTE_ROUND 下发一次，本函数自驱完成整轮。
 */
export interface RoundPayload {
  likeQuota: number;
  commentQuota: number;
  followQuota: number;
  likeProbability: number;
  followProbability: number;
  maxTweets: number;
  actionDelaySec: [number, number];
  scrollDelaySec: [number, number];
  readDwellMs: [number, number];
  autoSubmitComment: boolean;
  /** 轮开始时 SW 认为已经处理过的指纹 */
  seen: string[];
}

export interface RoundOutcome {
  likes: number;
  comments: number;
  follows: number;
  drafts: number;
  scanned: number;
  seen: string[];
  aborted: boolean;
  error: string | null;
}

export async function runAutoRound(payload: RoundPayload): Promise<RoundOutcome> {
  const outcome: RoundOutcome = {
    likes: 0,
    comments: 0,
    follows: 0,
    drafts: 0,
    scanned: 0,
    seen: [...payload.seen],
    aborted: false,
    error: null,
  };
  const seenSet = new Set(outcome.seen);

  /*
   * 迭代预算 & 空转检测。
   *
   * 只靠 scanned（已处理条数）封顶是不够的：如果时间线反复给出同一条已处理推文
   * （X 的虚拟列表回收、或滚动到底后回弹），scanned 永远不增长，循环就会无限滚动下去，
   * 既不会走 done、也不会走 scanned>=maxTweets —— 表现为「自动模式卡在滚动不停」。
   *
   * 因此额外加两道闸：
   *  - 迭代次数硬上限（scanned 与 maxTweets 之外的兜底）；
   *  - 连续无进展计数，超过阈值直接收尾。
   */
  const maxIterations = Math.max(12, payload.maxTweets * 6);
  const maxIdleStreak = 6;
  let iterations = 0;
  let idleStreak = 0;

  /*
   * 关注点击数的硬上限。
   *
   * 关注成功与否要靠 DOM 状态翻转来确认，而这个确认在悬停卡片被 React
   * 就地重渲染时并不可靠。只拿 outcome.follows 当闸门的话，一旦确认失败
   * 计数就永远不涨，循环会一直点关注下去 —— 这是直接放大账号风险的方向。
   *
   * 所以另记一份「真的点出去多少次」，点满配额就停手，宁可少报也不多关注。
   */
  let followClicks = 0;

  swLog('INFO', `本轮开始：目标 赞${payload.likeQuota} / 评${payload.commentQuota} / 关注${payload.followQuota}`);

  try {
    while (!isHumanizerAborted()) {
      iterations += 1;
      if (iterations > maxIterations) {
        swLog('WARNING', `达到单轮迭代上限 ${maxIterations} 次，提前收尾`);
        break;
      }

      const done =
        outcome.likes >= payload.likeQuota &&
        outcome.comments >= payload.commentQuota &&
        (outcome.follows >= payload.followQuota || followClicks >= payload.followQuota);
      if (done) {
        swLog('DONE', '本轮配额已全部达成');
        break;
      }
      if (outcome.scanned >= payload.maxTweets) {
        swLog('WARNING', `达到单轮浏览上限 ${payload.maxTweets} 条，提前收尾`);
        break;
      }

      swLog('WAIT', '浏览时间线，寻找未处理的推文…');
      await browseBurst();

      const candidates = visibleArticles();
      if (candidates.length === 0) {
        idleStreak += 1;
        swLog('WARNING', `视口内没有推文（连续 ${idleStreak}/${maxIdleStreak} 次），继续向下滚动`);
        if (idleStreak >= maxIdleStreak) {
          swLog('WARNING', '连续多次未发现新推文，本轮提前收尾');
          break;
        }
        await smoothScrollBy(600 + Math.random() * 500);
        await humanPause(payload.scrollDelaySec[0] * 1000, payload.scrollDelaySec[1] * 1000);
        continue;
      }

      // 挑选第一条未处理且有正文的推文
      let picked: { el: Element; snap: TweetSnapshot } | null = null;
      for (const el of candidates) {
        const snap = parseArticle(el);
        if (!snap.text || snap.text.length < 8) continue;
        if (snap.isRetweet) continue;
        if (seenSet.has(snap.fingerprint)) continue;
        picked = { el, snap };
        break;
      }

      if (!picked) {
        idleStreak += 1;
        swLog('WAIT', `视口内推文均已处理（连续 ${idleStreak}/${maxIdleStreak} 次），继续滚动`);
        if (idleStreak >= maxIdleStreak) {
          swLog('WARNING', '连续多次未发现新推文，本轮提前收尾');
          break;
        }
        await smoothScrollBy(520 + Math.random() * 620);
        await humanPause(payload.scrollDelaySec[0] * 1000, payload.scrollDelaySec[1] * 1000);
        continue;
      }

      // 有进展，清空空转计数
      idleStreak = 0;

      const { el, snap } = picked;
      seenSet.add(snap.fingerprint);
      outcome.seen = [...seenSet].slice(-400);
      outcome.scanned += 1;

      swLog('INFO', `[${outcome.scanned}] @${snap.authorHandle}：${snap.text.slice(0, 42)}${snap.text.length > 42 ? '…' : ''}`);
      await scrollIntoComfortZone(el).catch(() => undefined);

      /* --- 点赞 --- */
      if (outcome.likes < payload.likeQuota && Math.random() < payload.likeProbability) {
        const res = await likeArticle(el);
        if (res === 'liked') {
          outcome.likes += 1;
          swLog('ACTION', `点赞成功（${outcome.likes}/${payload.likeQuota}）`);
        } else if (res === 'already') {
          swLog('INFO', '该推文已点过赞，跳过');
        } else {
          swLog('WARNING', '点赞失败：按钮不可用或被风控拦截');
        }
        await humanPause(payload.actionDelaySec[0] * 1000, payload.actionDelaySec[1] * 1000);
      }

      /* --- 关注 --- */
      /*
       * 关注必须排在评论之前：评论会导航到详情页再返回，
       * 返回后时间线可能已重新渲染，这里持有的 el 引用会失效。
       */
      if (
        outcome.follows < payload.followQuota &&
        followClicks < payload.followQuota &&
        Math.random() < payload.followProbability
      ) {
        const res = await followAuthor(el);
        if (res === 'followed' || res === 'failed') followClicks += 1;
        if (res === 'followed') {
          outcome.follows += 1;
          swLog('ACTION', `已关注 @${snap.authorHandle}（${outcome.follows}/${payload.followQuota}）`);
        } else if (res === 'already') {
          swLog('INFO', `已关注过 @${snap.authorHandle}`);
        } else if (res === 'unavailable') {
          swLog('INFO', '时间线未提供关注入口，跳过');
        } else {
          swLog('WARNING', `关注 @${snap.authorHandle}：已点击但未能确认状态翻转（${followClicks}/${payload.followQuota}）`);
        }
        await humanPause(payload.actionDelaySec[0] * 1000, payload.actionDelaySec[1] * 1000);
      }

      /* --- 评论 --- */
      /*
       * 正确流程：点进推文详情页 → 等页面就绪 → 生成评论 → 填入（→ 发送）→ 返回时间线。
       *
       * 早先的实现直接在时间线上点内联回复按钮弹 modal，跳过了"真正打开推文"，
       * 且 modal 与详情页两套编辑器混用，导致注入定位到错误的目标而失败。
       *
       * 这是本循环里唯一的导航动作，必须放在最后 —— 一旦离开时间线，
       * 上面拿到的 el / snap 都可能失效。
       */
      if (outcome.comments < payload.commentQuota && !isHumanizerAborted()) {
        const { enterDetailPage, goBackToTimeline } = await import('./dom-actions');

        // 1) 点进详情页 —— 必须是真实导航，后续元素引用全部依赖新页面
        const detailUrl = await enterDetailPage(el);
        if (!detailUrl) {
          swLog('WARNING', '未能进入推文详情页，跳过该条评论');
        } else {
          const detail = extractDetail();
          if (!detail) {
            swLog('WARNING', '详情页未解析到推文内容，跳过该条评论');
          } else {
            // 2) 模拟阅读正文
            const readingOk = await readingDwell(payload.readDwellMs);
            if (readingOk) {
              swLog('ACTION', `已进入详情页 @${detail.main.authorHandle}，请求 AI 生成评论…`);
              const gen = await sendToSw<{ text: string }>({
                type: 'SW_GENERATE_FOR',
                snapshot: detail.main,
                // 上文真的传给模型 —— 早先只传 main，UI 那句「作为生成上下文」是空的
                ancestors: detail.ancestors,
              });

              if (!gen.ok) {
                swLog('ERROR', `评论生成失败：${gen.error}`);
              } else {
                const comment = await postCommentOnDetailPage(gen.data.text, payload.autoSubmitComment);
                if (comment.ok && comment.submitted) {
                  outcome.comments += 1;
                  swLog('ACTION', `评论已提交（${outcome.comments}/${payload.commentQuota}）：${gen.data.text.slice(0, 30)}…`);
                } else if (comment.ok) {
                  // 草稿模式：返回时间线时这个草稿就被销毁了，不能算作完成一次评论
                  outcome.drafts += 1;
                  swLog(
                    'ACTION',
                    `已填入草稿未发送（本轮第 ${outcome.drafts} 条，评论配额仍为 ${outcome.comments}/${payload.commentQuota}）：${gen.data.text.slice(0, 30)}…`,
                  );
                } else {
                  swLog('WARNING', comment.reason ?? '评论写入失败，跳过该条');
                }
              }
            }
          }

          // 3) 无论成败都要退出详情页，回到时间线继续巡航
          const back = await goBackToTimeline();
          if (!back) {
            swLog('WARNING', '未能自动返回时间线，本轮提前结束');
            break;
          }
        }

        await humanPause(payload.actionDelaySec[0] * 1000, payload.actionDelaySec[1] * 1000);
      }

      await microScroll();
    }
  } catch (err) {
    outcome.error = (err as Error).message;
    swLog('ERROR', `本轮异常终止：${outcome.error}`);
  }

  if (followClicks > outcome.follows) {
    swLog(
      'WARNING',
      `本轮共点击关注 ${followClicks} 次，仅确认成功 ${outcome.follows} 次；已按点击数封顶，不再继续关注`,
    );
  }

  if (!payload.autoSubmitComment && outcome.drafts > 0 && outcome.comments < payload.commentQuota) {
    swLog(
      'WARNING',
      `「自动提交评论」处于关闭状态：本轮填入 ${outcome.drafts} 条草稿（返回时间线后即被丢弃），` +
        `实际发送 ${outcome.comments}/${payload.commentQuota}。` +
        `草稿模式不会填满评论配额，需要真正发帖请在设置里打开自动提交。`,
    );
  }

  outcome.aborted = isHumanizerAborted();
  return outcome;
}

/**
 * 在已打开的详情页上展开回复框、填入评论（可选发送）。
 *
 * 详情页的编辑器默认是收起的，必须先点「回复」把它展开。
 * 只走详情页 inline 这条路径 —— 弹窗 modal 的编辑器是另一套结构，
 * 混用会导致注入定位错目标（这正是早先"文本注入失败"的成因）。
 */
async function postCommentOnDetailPage(
  text: string,
  autoSubmit: boolean,
): Promise<{ ok: boolean; submitted: boolean; reason?: string }> {
  const { focusReplyEditor, fillEditor, submitComment, waitForMainArticle } = await import('./dom-actions');

  // 详情页异步渲染，主推文可能还没挂载 —— 必须等，不能取一次就判死。
  // 选择器知识集中在 dom-actions / X_SELECTORS，这里不重复硬编码。
  const mainArticle = await waitForMainArticle();
  if (!mainArticle) return { ok: false, submitted: false, reason: '详情页未找到主推文' };

  // 1) 展开并聚焦回复编辑器（内部会等待其挂载）
  const opened = await focusReplyEditor(mainArticle);
  if (!opened) return { ok: false, submitted: false, reason: '未能展开评论编辑器' };

  // 2) 注入
  const filled = await fillEditor(text, { typewriter: true });
  if (!filled) return { ok: false, submitted: false, reason: '文本注入失败（评论框未接受输入）' };

  if (!autoSubmit) return { ok: true, submitted: false };

  // 3) 发送
  await humanPause(1200, 2200);
  const sub = await submitComment();
  if (!sub.ok) return { ok: false, submitted: false, reason: `评论提交失败：${sub.reason}` };
  return { ok: true, submitted: true };
}

/* ------------------------------------------------------------------ */
/* 自动模式开关                                                        */
/* ------------------------------------------------------------------ */

interface AutoRunMessage {
  type: 'CS_AUTO_ROUND';
  payload: RoundPayload;
}

const autoRoundListener = (
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean => {
  const msg = message as AutoRunMessage;
  if (msg?.type !== 'CS_AUTO_ROUND') return false;

  setAutoRoundInFlight(true);
  setHumanizerAborted(false);
  runAutoRound(msg.payload)
    .then((outcome) => sendResponse({ ok: true, data: outcome } satisfies Result<RoundOutcome>))
    .catch((err: Error) => sendResponse({ ok: false, error: err.message } satisfies Result<never>))
    .finally(() => setAutoRoundInFlight(false));
  return true;
};

// 紧急制动：由 SW 广播。只在有自动轮次在飞时真正生效，见 humanizer.ts
const abortListener = (message: unknown): boolean => {
  const msg = message as { type?: string };
  if (msg?.type === 'CS_ABORT') {
    setHumanizerAborted(true);
  }
  return false;
};

/**
 * 幂等守卫。
 *
 * manifest 已经声明了 content_scripts，但 SW 的 ensureContentScript() 在 ping
 * 连续失败后还会用 chrome.scripting.executeScript 再注入一次做兜底。x.com 是
 * 重型 SPA，document_idle 可能晚于 tab.status === 'complete'，于是兜底注入会和
 * 清单注入叠加 —— 监听器双份注册，一条 CS_AUTO_ROUND 让整轮并发跑两遍，
 * 点赞 / 评论 / 关注全部翻倍。
 *
 * 两份脚本跑在同一个 isolated world，window 是共享的，因此用它做标记。
 */
const LOAD_GUARD = '__xAutopilotContentLoaded';
const guardScope = window as unknown as Record<string, boolean>;

if (!guardScope[LOAD_GUARD]) {
  guardScope[LOAD_GUARD] = true;
  chrome.runtime.onMessage.addListener(manualRouter);
  chrome.runtime.onMessage.addListener(autoRoundListener);
  chrome.runtime.onMessage.addListener(abortListener);
  swLog('INFO', 'Content script 已就绪');
}
