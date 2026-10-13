/**
 * Service Worker：自动巡航的调度中枢。
 *
 * 设计要点：
 *  1. MV3 的 service worker 会被回收，setInterval / setTimeout 不可靠，
 *     所有跨轮次的等待必须走 chrome.alarms（最小粒度 30s，短等待用 alarm + 唤醒回填）。
 *  2. SW 不操作 DOM。整轮巡航交给 content script 自驱执行（CS_AUTO_ROUND），
 *     SW 只负责：发起轮次、消费 content 上报的日志、调度下一轮、执行紧急制动。
 *  3. SW 只作为 LLM 的代理出口，避免 API Key 暴露在页面上下文里。
 */

import { ALARM_AUTO_TICK, ALARM_ROUND_WATCHDOG, HOME_TIMELINE_URL, ROUND_DEFER_POLL_MS, ROUND_WATCHDOG_MS, profileUrl } from '../shared/constants';
import {
  LlmError,
  createContext,
  generateComment,
  testConnection,
  type ApiContext,
  type HttpTransport,
} from '../shared/api';
import {
  appendLog,
  clearLogs,
  getRuntime,
  getSettings,
  idleRuntime,
  patchSettings,
  setRuntime,
} from '../shared/storage';
import type {
  AutomationRuntime,
  FollowOutcome,
  LogLevel,
  Result,
  RoundCounters,
  RoundReport,
  ToBackgroundMessage,
  TweetSnapshot,
} from '../shared/types';

/* ------------------------------------------------------------------ */
/* 内部状态（SW 被回收后从 storage 恢复）                              */
/* ------------------------------------------------------------------ */

interface SwState {
  running: boolean;
  /** 当前任务所在标签页 */
  tabId: number | null;
}

const state: SwState = { running: false, tabId: null };

/**
 * 单轮循环的重入守卫。
 *
 * alarm 与冷启动兜底可能同时触发恢复；两者都在进入后、第一个 await 之前同步置位，
 * 因此后到的那次会直接退出，不会并发跑两轮。
 */
let cycleInFlight = false;
let resuming = false;

/**
 * 已经收尾过的轮次（runtime.roundStartedAt）。
 *
 * 同一轮的结果会从两条通道回来（sendResponse 续跑 + SW_ROUND_REPORT 上报），
 * 在 SW 还活着的那个实例里两者都会命中，用它在内存里去重。跨实例的去重靠
 * 落盘状态：finalizeRound 只处理 phase 仍为「轮内」的运行时，收尾后立刻变 cooling。
 */
let finalizedRoundAt: number | null = null;

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

async function log(level: LogLevel, message: string, scope: 'SW' | 'UI' | 'DOM' = 'SW'): Promise<void> {
  try {
    await appendLog({ level, message, scope });
  } catch {
    // storage 异常不能中断主流程
  }
  // 广播给侧边栏，实现"实时"体感（storage.onChanged 有节流）
  chrome.runtime.sendMessage({ type: 'LOG_PUSH', level, message, scope }).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* 运行态                                                              */
/* ------------------------------------------------------------------ */

async function pushRuntime(patch: Partial<AutomationRuntime>): Promise<AutomationRuntime> {
  const current = await getRuntime();
  const next: AutomationRuntime = {
    ...current,
    ...patch,
    counters: { ...current.counters, ...(patch.counters ?? {}) },
  };
  await setRuntime(next);
  chrome.runtime.sendMessage({ type: 'RUNTIME_PUSH', runtime: next }).catch(() => undefined);
  return next;
}

/* ------------------------------------------------------------------ */
/* 标签页                                                              */
/* ------------------------------------------------------------------ */

async function findXTab(): Promise<chrome.tabs.Tab | null> {
  const patterns = ['https://x.com/*', 'https://twitter.com/*'];
  const tabs = await chrome.tabs.query({ url: patterns });
  if (tabs.length === 0) return null;
  // 优先活跃标签页，否则第一个
  return tabs.find((t) => t.active) ?? tabs[0];
}

async function ensureXTab(): Promise<chrome.tabs.Tab> {
  const existing = await findXTab();
  if (existing?.id) {
    state.tabId = existing.id;
    if (!existing.url?.includes('x.com/home') && !existing.url?.includes('twitter.com/home')) {
      await log('INFO', '导航至首页时间线');
      await chrome.tabs.update(existing.id, { url: HOME_TIMELINE_URL, active: true });
      await waitForTabReady(existing.id);
    } else {
      await reloadToFreshTimeline(existing.id);
    }
    return existing;
  }

  await log('INFO', '未检测到已打开的 X 标签页，正在创建');
  const created = await chrome.tabs.create({ url: HOME_TIMELINE_URL, active: true });
  if (created.id) {
    state.tabId = created.id;
    await waitForTabReady(created.id);
  }
  return created;
}

/**
 * 已在首页时也要整页刷新，取一份全新的时间线。
 *
 * X 的时间线是虚拟列表：不刷新就还是同一批推文，而它们的指纹全部命中
 * runtime.counters.seen，循环只能靠空转计数提前收尾 —— 表现为「巡航在跑，
 * 但一轮也做不动」。刷完首屏就是最新的推文。
 *
 * 顺序有讲究：先挂好 onUpdated 监听，**再**触发 reload。反过来做会在
 * 「reload 已派发、浏览器还没开始加载」的窗口里读到旧页面的
 * `status === 'complete'`，于是把整轮指令发给一个即将被卸载的 content script。
 */
async function reloadToFreshTimeline(tabId: number): Promise<void> {
  await log('INFO', '刷新首页时间线');
  const navigated = waitTabNavigated(tabId);
  await chrome.tabs.reload(tabId);
  await navigated;
  // 与 waitForTabReady 一致：给 X 的 React 首屏渲染留时间
  await sleep(1500);
}

/** 等到标签页完成一次「loading → complete」的真实导航 */
function waitTabNavigated(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    let sawLoading = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      else if (info.status === 'complete' && sawLoading) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // 兜底：导航因故没有事件（如被拦截），超时后照常放行
    timer = setTimeout(finish, timeoutMs);
  });
}

async function waitForTabReady(tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') {
      // 再给 X 的 React 首屏渲染留时间
      await sleep(1500);
      return;
    }
    await sleep(400);
  }
  await log('WARNING', '页面加载超时，继续尝试执行');
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  for (let i = 0; i < 8; i += 1) {
    const res = await sendToTab<{ ready: boolean }>(tabId, { type: 'CS_PING' });
    if (res.ok) return true;
    // 页面刚导航完，content script 可能尚未注入；主动注入一次
    if (i === 3) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch {
        /* 多数情况下 content_scripts 已声明，此项只是双保险 */
      }
    }
    await sleep(500);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 与 content script / sidepanel 通信                                  */
/* ------------------------------------------------------------------ */

async function sendToTab<T>(tabId: number, message: unknown): Promise<Result<T>> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, message)) as Result<T> | undefined;
    return res ?? { ok: false, error: 'content script 无响应' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/* 轮次调度                                                            */
/* ------------------------------------------------------------------ */

const countersSnapshot = (): RoundCounters => ({
  likes: 0,
  comments: 0,
  follows: 0,
  drafts: 0,
  scanned: 0,
  seen: [],
});

async function startAutomation(): Promise<Result<{ started: true }>> {
  const settings = await getSettings();
  if (!settings.llm.apiKey && settings.automation.commentQuotaPerRound > 0) {
    await log('WARNING', '未配置 API Key，本轮将只执行点赞/关注，跳过评论');
  }

  state.running = true;
  cycleInFlight = false;
  resuming = false;
  finalizedRoundAt = null;
  await chrome.alarms.clear(ALARM_AUTO_TICK);
  await clearRoundWatchdog();
  await pushRuntime({
    phase: 'navigating',
    round: 0,
    counters: countersSnapshot(),
    nextRoundAt: null,
    roundStartedAt: null,
    lastError: null,
  });
  // automation.enabled 是配置里的「总开关」，此前只被 preflight 读过、
  // 从没人写，导致它的值与真实运行状态永久脱节。
  await patchSettings({ automation: { enabled: true } });
  await log('INFO', '自动巡航已启动');

  void runRoundCycle(1);
  return { ok: true, data: { started: true } };
}

async function stopAutomation(reason = '用户手动停止'): Promise<Result<{ stopped: true }>> {
  state.running = false;
  await chrome.alarms.clear(ALARM_AUTO_TICK);
  await clearRoundWatchdog();

  // 广播制动，令 content script 立刻放弃当前动作
  const tab = state.tabId ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
  const tabId = tab?.id ?? (await findXTab())?.id ?? null;
  if (tabId !== null) {
    await sendToTab(tabId, { type: 'CS_ABORT' });
  }

  await pushRuntime({ phase: 'stopped', nextRoundAt: null });
  await patchSettings({ automation: { enabled: false } });
  await log('WARNING', `紧急制动已触发：${reason}`);
  return { ok: true, data: { stopped: true } };
}

/**
 * 单轮循环：执行 → 冷却 → 下一轮。
 *
 * `round` 是**面向日志的轮号，从 1 开始**，并且会原样写进 runtime.round。
 * 也就是说 runtime.round 恒等于「当前（或最近一次）轮次的编号」，
 * 需要它的时候直接读，不要再 +1 —— 之前这里传的是 0 基下标、别处按 1 基读，
 * 同一份状态被两套编号解释，日志才会出现「第 5 轮结束后开始第 5 轮」。
 */
async function runRoundCycle(round: number): Promise<void> {
  // 同步占位，早于任何 await —— alarm 与冷启动兜底并发恢复时后到者直接退出
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    await executeRoundCycle(round);
  } finally {
    cycleInFlight = false;
  }
}

async function executeRoundCycle(round: number): Promise<void> {
  if (!state.running) return;

  /*
   * 先问页面「上一轮还在跑吗」，且必须早于 ensureXTab()。
   *
   * 顺序有讲究：ensureXTab 会整页刷新，刷新会把页面里那一轮直接抹掉，
   * 于是这个探测永远返回 false，并发也就照常发生。
   * 而一轮被后台降速拖慢不等于丢失，页面里的循环仍在点按钮；这时候再下发
   * 一轮，就是两个循环同时操作同一个账号 —— 风险最大的方向。
   */
  if ((await inFlightRoundTab()) !== null) {
    await deferForInFlightRound();
    return;
  }

  const settings = await getSettings();
  const a = settings.automation;

  // 每轮开始先把页面拉回首页时间线，并整页刷新取最新推文
  await pushRuntime({ phase: 'navigating', round });
  let tab: chrome.tabs.Tab;
  try {
    tab = await ensureXTab();
  } catch (err) {
    await failRound(`无法打开 X 标签页：${(err as Error).message}`);
    return;
  }
  if (!tab.id) {
    await failRound('标签页 ID 缺失');
    return;
  }
  state.tabId = tab.id;

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    await failRound('content script 未注入成功，请刷新页面后重试');
    return;
  }

  const runtime = await getRuntime();
  const roundStartedAt = Date.now();
  await pushRuntime({
    phase: 'scrolling',
    roundStartedAt,
    counters: { ...countersSnapshot(), seen: runtime.counters.seen },
  });

  await log('INFO', `===== 第 ${round} 轮开始 =====`);

  /*
   * 先挂看门狗，再发指令。
   *
   * 一轮要跑几分钟到几十分钟，而 MV3 的 SW 活不了那么久（空闲约 30s 回收，
   * 连续活动也有绝对上限）—— 下发指令的这个实例大概率撑不到结果回来。
   * 因此轮次结果除了走 sendResponse，content script 还会另发一条 SW_ROUND_REPORT
   * 把**新实例**唤起来收尾；万一两条都没到（标签页被关、页面崩溃、脚本被卸载），
   * 就由这个 alarm 兜底。否则巡航就停在最后一轮，再也没有东西把它叫醒。
   */
  armRoundWatchdog(roundStartedAt);

  const res = await sendToTab<RoundReport>(tab.id, {
    type: 'CS_AUTO_ROUND',
    payload: {
      likeQuota: a.likeQuotaPerRound,
      commentQuota: a.commentQuotaPerRound,
      followQuota: a.followQuotaPerRound,
      likeProbability: a.likeProbability,
      followProbability: a.followProbability,
      maxTweets: a.maxTweetsPerRound,
      actionDelaySec: a.actionDelaySec,
      scrollDelaySec: a.scrollDelaySec,
      readDwellMs: a.readDwellMs,
      autoSubmitComment: a.autoSubmitComment,
      seen: runtime.counters.seen,
      roundStartedAt,
    },
  });

  if (!res.ok) {
    await failRound(`轮次执行失败：${res.error}`);
    return;
  }

  await finalizeRound(roundStartedAt, res.data);
}

/**
 * 轮次收尾：写计数 → 进冷却 → 挂下一次唤醒。
 *
 * 由三条路径调用，且必须是**幂等**的：
 *  - sendResponse 的续跑（下发指令的实例还活着）；
 *  - SW_ROUND_REPORT（实例已被回收，由这条消息把新实例唤起来）；
 *  - 看门狗到点，此时拿不到结果，只把状态推下去。
 *
 * 判定「这一轮已经收过尾」不依赖内存状态：收尾后 phase 立刻变成 cooling，
 * 而这里只接受轮内状态（navigating / scrolling），所以跨实例的重复调用会被丢弃。
 */
async function finalizeRound(roundStartedAt: number, report: RoundReport | null): Promise<void> {
  // 去重闸门放在**第一个 await 之前**：SW 还活着时两条通道会在同一个实例里并发
  // 走到这里，若先 await 再判，两边都可能通过检查、把收尾做两遍（重复日志、
  // 重复计算冷却时长）。
  if (finalizedRoundAt === roundStartedAt) return; // 本实例里另一条通道已经收尾
  finalizedRoundAt = roundStartedAt;

  const rt = await getRuntime();
  if (rt.phase !== 'navigating' && rt.phase !== 'scrolling') return; // 已收尾 / 已制动
  if (rt.roundStartedAt !== roundStartedAt) return; // 迟到的旧轮报告

  await clearRoundWatchdog();

  const settings = await getSettings();
  const round = rt.round;
  const counters: RoundCounters | undefined = report
    ? {
        ...rt.counters,
        likes: report.likes,
        comments: report.comments,
        follows: report.follows,
        drafts: report.drafts,
        scanned: report.scanned,
        seen: report.seen,
      }
    : undefined;

  await pushRuntime({ phase: 'cooling', roundStartedAt: null, counters });

  if (report) {
    await log(
      'DONE',
      `第 ${round} 轮结束｜赞 ${report.likes}・评 ${report.comments}・关注 ${report.follows}` +
        `${report.drafts > 0 ? `・草稿 ${report.drafts}` : ''}｜浏览 ${report.scanned} 条`,
    );
    if (report.error) await log('ERROR', `轮次内异常：${report.error}`);
  } else {
    await log('WARNING', `第 ${round} 轮结果未能送达，按「未知」收尾（页面动作已中止）`);
  }

  const [minM, maxM] = settings.automation.roundSleepMin;
  const sleepMs = Math.round((minM + Math.random() * Math.max(0, maxM - minM)) * 60_000);
  const wakeAt = Date.now() + sleepMs;

  await pushRuntime({ nextRoundAt: wakeAt });
  await log('WAIT', `进入冷却，将在 ${Math.round(sleepMs / 60000)} 分钟后开始第 ${round + 1} 轮`);

  state.running = true; // 收尾即意味着巡航意图仍在
  scheduleWake(wakeAt);
}

async function failRound(reason: string): Promise<void> {
  await log('ERROR', reason);
  // 本轮已经认输：留着看门狗的话，它会在下一轮在飞时误判成孤儿轮并把它打断
  await clearRoundWatchdog();
  await pushRuntime({ phase: 'error', lastError: reason, nextRoundAt: null });
  if (state.running) {
    // 出错后等 2 分钟重试本轮，而不是直接放弃。
    // 轮次号不从这里传：唤醒后由 resumeAfterWake() 从 storage 读回，
    // 因为等到 alarm 真响时本 SW 实例多半已经被回收过了。
    const wakeAt = Date.now() + 120_000;
    await pushRuntime({ nextRoundAt: wakeAt });
    scheduleWake(wakeAt);
  }
}

/**
 * 跨轮次定时：**只**用 chrome.alarms。
 *
 * alarms 是唯一能跨 SW 回收存活的计时器。早先这里还在内存 Map 里存了一份
 * 唤醒回调、并对 60s 内的短等待加了一条 setTimeout 快路径 —— 但 MV3 的 SW
 * 空闲约 30s 就被杀，而冷却动辄 15~30 分钟：等 alarm 真响时内存早已清空，
 * 回调丢失，巡航跑完第一轮就静默停摆，侧边栏还停在过期的倒计时上。
 *
 * 因此唤醒意图一律落盘（phase + nextRoundAt），到点由 resumeAfterWake() 读回。
 */
function scheduleWake(at: number): void {
  // Chrome 对 alarm 的最小提前量是 30s，更短会被静默抬高
  const delayMs = Math.max(30_000, at - Date.now());
  void chrome.alarms
    .clear(ALARM_AUTO_TICK)
    .then(() => chrome.alarms.create(ALARM_AUTO_TICK, { when: Date.now() + delayMs }));
}

/**
 * 轮次存活看门狗。
 *
 * 起点固定用 roundStartedAt 而不是 now：轮内每几条动作就有 swLog 消息把 SW
 * 唤醒一次，若按 now 续期，这个看门狗会被自己无限延后，等于没有。
 * 已过期时 Chrome 会很快触发，正好落到恢复分支里收尾。
 */
function armRoundWatchdog(roundStartedAt: number): void {
  scheduleRoundWatchdog(roundStartedAt + ROUND_WATCHDOG_MS);
}

/** 把看门狗挂到指定时刻；「仍在运行」的续期路径按 now 起算，孤儿判定按 roundStartedAt 起算 */
function scheduleRoundWatchdog(when: number): void {
  void chrome.alarms
    .clear(ALARM_ROUND_WATCHDOG)
    .then(() => chrome.alarms.create(ALARM_ROUND_WATCHDOG, { when }));
}

async function clearRoundWatchdog(): Promise<void> {
  await chrome.alarms.clear(ALARM_ROUND_WATCHDOG).catch(() => undefined);
}

/**
 * 页面里是否还有一轮巡航在飞，返回持有它的 tabId（没有则 null）。
 *
 * 这是**唯一**可靠的判据。runtime.phase 只能说明 SW 当时以为在轮内，
 * 而一轮的结果可能在几十分钟之后才从页面里送出来；内存状态跨 SW 回收不可信，
 * 落盘状态又可能过期，只有直接问页面才知道那个循环还在不在。
 */
async function inFlightRoundTab(): Promise<number | null> {
  const tab = await findXTab();
  if (!tab?.id) return null;
  const res = await sendToTab<{ inFlight: boolean }>(tab.id, { type: 'CS_ROUND_STATE' });
  return res.ok && res.data.inFlight ? tab.id : null;
}

/**
 * 「上一轮还在跑」时的处置：只推迟，绝不并发下发第二轮。
 *
 * 标签页切到后台后 Chrome 会把页面计时器降速到约每分钟一次，一轮因此能拖到
 * 几小时。慢不等于丢：那一轮跑完照样会把结果送回来正常收尾。所以这里保持
 * 状态不动、看门狗顺延，隔几分钟再问一次页面。
 */
async function deferForInFlightRound(): Promise<void> {
  state.running = true;
  const rt = await getRuntime();
  if (rt.phase === 'navigating' || rt.phase === 'scrolling') {
    scheduleRoundWatchdog(Date.now() + ROUND_WATCHDOG_MS);
  }
  const wakeAt = Date.now() + ROUND_DEFER_POLL_MS;
  await log(
    'WARNING',
    `第 ${rt.round} 轮仍在页面中运行（标签页多半被切到后台，页面计时器已降速），` +
      `不并发开新轮，${Math.round(ROUND_DEFER_POLL_MS / 60_000)} 分钟后再查`,
  );
  scheduleWake(wakeAt);
}

/**
 * alarm 到点后的恢复：从 storage 读回运行意图，不依赖任何内存状态。
 *
 *  - phase === 'navigating' / 'scrolling' → 看门狗到点，先问页面还在不在跑
 *  - phase === 'cooling' → 冷却结束，跑**下一轮**（runtime.round 是刚跑完的那轮）
 *  - phase === 'error'   → 上次失败，**重试本轮**
 *  - 其余（stopped / idle）→ 用户已主动停手，不动
 */
async function resumeAfterWake(): Promise<void> {
  // alarm 事件与冷启动兜底会并发走到这里；resuming 在任何 await 之前同步置位，
  // 保证恢复动作（含日志）只发生一次。
  if (resuming || cycleInFlight) return;
  resuming = true;
  try {
    const rt = await getRuntime();

    if (rt.phase === 'navigating' || rt.phase === 'scrolling') {
      await reconcileInFlightRound(rt);
      return;
    }

    if (!rt.nextRoundAt) return;
    if (rt.phase !== 'cooling' && rt.phase !== 'error') return;

    state.running = true;
    state.tabId = (await findXTab())?.id ?? null;
    const nextRound = rt.phase === 'error' ? Math.max(1, rt.round) : rt.round + 1;
    await log(
      'INFO',
      rt.phase === 'error' ? `重试第 ${nextRound} 轮` : `冷却结束，开始第 ${nextRound} 轮`,
    );
    await runRoundCycle(nextRound);
  } finally {
    resuming = false;
  }
}

/**
 * 看门狗到点时的孤儿轮处置。
 *
 * 先问一次页面：还在跑就只是慢，走推迟路径，绝不开第二轮。
 * 真的两条通道都没到（标签页被关、页面崩溃、脚本被卸载）才判定丢失。
 *
 * 判定丢失后必须先广播制动 —— 页面里的整轮循环是 content script 在跑，SW 死了它
 * 照旧运行；若直接进冷却，下一轮唤醒时上一轮的残留循环可能还在点按钮，
 * 动作翻倍正是账号风险最大的方向。
 */
async function reconcileInFlightRound(rt: AutomationRuntime): Promise<void> {
  state.running = true;
  state.tabId = (await findXTab())?.id ?? null;

  if (state.tabId !== null) {
    const res = await sendToTab<{ inFlight: boolean }>(state.tabId, { type: 'CS_ROUND_STATE' });
    if (res.ok && res.data.inFlight) {
      await deferForInFlightRound();
      return;
    }
  }

  await log(
    'WARNING',
    `第 ${rt.round} 轮超过 ${Math.round(ROUND_WATCHDOG_MS / 60_000)} 分钟仍未回报结果，判定为丢失`,
  );
  if (state.tabId !== null) await sendToTab(state.tabId, { type: 'CS_ABORT' });
  if (rt.roundStartedAt !== null) await finalizeRound(rt.roundStartedAt, null);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_AUTO_TICK && alarm.name !== ALARM_ROUND_WATCHDOG) return;
  void resumeAfterWake();
});

/* ------------------------------------------------------------------ */
/* LLM 代理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 为什么在 SW 里发请求：
 *
 * side panel 是普通文档，fetch 受同源策略约束。若模型网关不返回
 * Access-Control-Allow-Origin（例如 cli.xueqiubot.com 的 OPTIONS 预检
 * 直接 405），浏览器会在网络层拦下请求，抛 "TypeError: Failed to fetch"，
 * 插件表现为"无法连接到模型"，与参数是否填对无关。
 *
 * 而 MV3 service worker 的跨域请求受 host_permissions 授权保护，
 * 不受 CORS 限制。因此所有出站 HTTP 都从这里走。
 */
async function proxyHttp(req: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<Result<{ ok: boolean; status: number; text: string }>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: true, data: { ok: res.ok, status: res.status, text } };
  } catch (err) {
    const e = err as Error;
    const reason =
      e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `请求超时（${req.timeoutMs}ms）`
        : e?.message ?? String(err);
    return {
      ok: false,
      error: `网关请求失败：${reason}。请检查网络，并确认「${new URL(req.url).origin}」已加入扩展的 host_permissions。`,
      code: 'NETWORK',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** side panel 通过此 transport 复用 SW 的网络能力 */
const swTransport: HttpTransport = async (req) => {
  const res = await proxyHttp(req);
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

function proxyContext(): ApiContext {
  return createContext(swTransport);
}

async function proxyGenerate(
  snapshot: TweetSnapshot,
  ancestors: TweetSnapshot[] = [],
): Promise<Result<{ text: string }>> {
  const settings = await getSettings();
  try {
    const text = await generateComment({
      ctx: proxyContext(),
      snapshot,
      ancestors,
      llm: settings.llm,
      prompt: settings.prompt,
    });
    return { ok: true, data: { text } };
  } catch (err) {
    const e = err as LlmError;
    return { ok: false, error: e.message ?? String(err), code: e.code };
  }
}

/* ------------------------------------------------------------------ */
/* 作者主页关注（侧边栏卡片）                                          */
/* ------------------------------------------------------------------ */

/**
 * 打开目标作者主页并关注。
 *
 * 与自动巡航不同，这里不需要 content script 自驱，SW 直接编排三步：
 *   1) 找到或新建一个指向目标主页的标签页（已在该主页则原地复用）；
 *   2) 等页面就绪 + 确保 content script 已注入；
 *   3) 下发 CS_FOLLOW_PROFILE。
 *
 * 主页是 SPA：`x.com/home` 切到 `x.com/<handle>` 时 URL 会变但 DOM 需要重渲染，
 * 因此对 `unavailable`（多为主页还没渲染完）做有限重试，而不是一次就判失败。
 *
 * 复用点：沿用 ensureContentScript() 的注入兜底与 sendToTab() 的通道封装，
 * 不另起一套标签页/消息逻辑。
 */
async function followProfile(handle: string): Promise<Result<{ outcome: FollowOutcome }>> {
  const clean = handle.replace(/^@/, '').trim();
  if (!clean) return fail('未配置作者 handle');

  const targetUrl = profileUrl(clean);
  const targetPath = `/${clean.toLowerCase()}`;

  try {
    // 1) 优先复用已打开在目标主页的标签页；否则复用任意 X 标签页并导航过去；
    //    都没有则新建一个。
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    let tabId: number | null = null;

    const onTarget = tabs.find((t) => (t.url ?? '').toLowerCase().includes(`x.com${targetPath}`) || (t.url ?? '').toLowerCase().includes(`twitter.com${targetPath}`));
    if (onTarget?.id) {
      tabId = onTarget.id;
      await chrome.tabs.update(tabId, { active: true });
    } else if (tabs[0]?.id) {
      tabId = tabs[0].id;
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
      await waitForTabReady(tabId);
    } else {
      const created = await chrome.tabs.create({ url: targetUrl, active: true });
      tabId = created.id ?? null;
      if (tabId !== null) await waitForTabReady(tabId);
    }

    if (tabId === null) return fail('无法打开作者主页标签页');

    // 2) content script 可能尚未注入（新标签页），复用统一的注入兜底
    const ready = await ensureContentScript(tabId);
    if (!ready) return fail('目标页面脚本未就绪，请稍后重试', 'CS_NOT_READY');

    // 3) 下发关注指令，对「主页尚未渲染」做有限重试
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await sendToTab<{ outcome: FollowOutcome }>(tabId, {
        type: 'CS_FOLLOW_PROFILE',
        handle: clean,
      });
      if (!res.ok) return fail(res.error, res.code);

      const outcome = res.data.outcome;
      if (outcome === 'unavailable') {
        await sleep(900);
        continue;
      }
      await log(
        outcome === 'followed' ? 'ACTION' : 'INFO',
        outcome === 'followed'
          ? `已关注作者 @${clean}`
          : outcome === 'already'
            ? `作者 @${clean} 已关注过`
            : `关注 @${clean} 失败`,
        'SW',
      );
      return ok({ outcome });
    }
    return fail('目标主页未能就绪，请确认已登录 X 后重试', 'PROFILE_NOT_READY');
  } catch (err) {
    return fail((err as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (error: string, code?: string): Result<never> => ({ ok: false, error, code });

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as { type?: string };
  if (!msg?.type) return false;

  // ---- content script -> SW：日志 ----
  if (msg.type === 'SW_LOG') {
    const m = message as Extract<ToBackgroundMessage, { type: 'SW_LOG' }>;
    void log(m.level, m.message, m.scope ?? 'DOM');
    sendResponse(ok({ logged: true }));
    return false;
  }

  // ---- content script -> SW：取当前标签页 ----
  if (msg.type === 'SW_GET_TAB') {
    const tabId = sender.tab?.id ?? state.tabId ?? null;
    if (tabId !== null) state.tabId = tabId;
    sendResponse(tabId === null ? fail('无法确定标签页') : ok({ tabId }));
    return false;
  }

  // ---- content script -> SW：轮次结果 ----
  //
  // 这是一条**独立**消息，作用是让被回收后重新唤起的 SW 实例也能收尾。
  // 只靠 CS_AUTO_ROUND 的 sendResponse 不够：那条通道绑在下发指令的那个实例上，
  // 实例被回收后 sendResponse 就是空操作，收尾续跑随之丢失。
  if (msg.type === 'SW_ROUND_REPORT') {
    const m = message as Extract<ToBackgroundMessage, { type: 'SW_ROUND_REPORT' }>;
    if (state.tabId === null && sender.tab?.id) state.tabId = sender.tab.id;
    void finalizeRound(m.roundStartedAt, m.report);
    sendResponse(ok({ recorded: true }));
    return false;
  }

  // ---- content script -> SW：代理转发 ----
  if (msg.type === 'SW_TO_CONTENT') {
    const m = message as Extract<ToBackgroundMessage, { type: 'SW_TO_CONTENT' }>;
    sendToTab(m.tabId, m.payload).then(sendResponse);
    return true;
  }

  // ---- content script -> SW：生成评论 ----
  if (msg.type === 'SW_GENERATE_FOR') {
    const m = message as Extract<ToBackgroundMessage, { type: 'SW_GENERATE_FOR' }>;
    proxyGenerate(m.snapshot, m.ancestors)
      .then((r) => {
        if (!r.ok) void log('ERROR', `LLM 调用失败：${r.error}`);
        sendResponse(r);
      })
      .catch((err: Error) => sendResponse(fail(err.message)));
    return true;
  }

  // ---- sidepanel -> SW ----
  switch (msg.type) {
    case 'AUTO_START':
      startAutomation().then(sendResponse).catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    case 'AUTO_STOP':
      stopAutomation((message as { reason?: string }).reason)
        .then(sendResponse)
        .catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    case 'AUTO_GET_RUNTIME':
      getRuntime().then((rt) => sendResponse(ok(rt))).catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    case 'AUTO_STATE_SYNC':
      sendResponse(ok({ running: state.running, tabId: state.tabId }));
      return false;
    case 'LLM_GENERATE': {
      const m = message as { snapshot: TweetSnapshot; ancestors?: TweetSnapshot[] };
      proxyGenerate(m.snapshot, m.ancestors)
        .then(sendResponse)
        .catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    }
    case 'LLM_TEST': {
      void (async () => {
        const settings = await getSettings();
        try {
          const r = await testConnection(settings.llm, proxyContext());
          await log('INFO', `连通性测试通过：${r.note}`);
          sendResponse(ok(r));
        } catch (err) {
          const e = err as LlmError;
          await log('ERROR', `连通性测试失败：${e.message}`);
          sendResponse(fail(e.message, e.code));
        }
      })();
      return true;
    }
    case 'LLM_HTTP_FETCH':
      // side panel 的网络出口：绕过其文档级同源策略
      proxyHttp((message as { req: Parameters<typeof proxyHttp>[0] }).req)
        .then(sendResponse)
        .catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    case 'LOGS_CLEAR':
      clearLogs().then(() => sendResponse(ok({ cleared: true }))).catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    case 'PROFILE_FOLLOW':
      followProfile((message as { handle: string }).handle)
        .then(sendResponse)
        .catch((e: Error) => sendResponse(fail(e.message)));
      return true;
    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  // 让点击扩展图标直接打开侧边栏
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  if (details.reason === 'install') {
    await setRuntime(idleRuntime());
    await log('INFO', '安装完成。请先到「设置」里填写 API Key，然后在推文详情页试用「手动模式」。');
  }
  await log('INFO', 'X Autopilot 已启动');
});

chrome.runtime.onStartup?.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

// 用户关闭 X 标签页时，若正在巡航则自动制动，避免空转
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.tabId === tabId && state.running) {
    void stopAutomation('X 标签页已关闭');
  }
});

// 首帧兜底：SW 冷启动时把中断的等待续上
void (async () => {
  const rt = await getRuntime();

  // 轮次还在飞（本实例只是被顺带唤醒的）：确认看门狗在位。armRoundWatchdog
  // 以 roundStartedAt 为起点，重复唤醒不会把时限往后推。
  if (rt.phase === 'navigating' || rt.phase === 'scrolling') {
    state.running = true;
    if (rt.roundStartedAt !== null) armRoundWatchdog(rt.roundStartedAt);
    return;
  }

  if (rt.phase !== 'cooling' && rt.phase !== 'error') return;
  if (!rt.nextRoundAt) return;

  state.running = true;
  if (rt.nextRoundAt > Date.now()) {
    // 本次唤醒由别的事件触发（一条日志、一次面板调用），还没到点：重新挂上 alarm
    scheduleWake(rt.nextRoundAt);
  } else {
    // 到点了却没跑起来 —— 本次唤醒大概率就是 alarm 触发的，续跑
    void resumeAfterWake();
  }
})();

export {};
