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

import { ALARM_AUTO_TICK, HOME_TIMELINE_URL, profileUrl } from '../shared/constants';
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
  setRuntime,
} from '../shared/storage';
import type {
  AutomationRuntime,
  FollowOutcome,
  LogLevel,
  Result,
  RoundCounters,
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
  /** 是否已在等待下一轮 */
  cooling: boolean;
}

const state: SwState = { running: false, tabId: null, cooling: false };

const pendingTimers = new Map<string, (value: void) => void>();

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

const countersSnapshot = (): RoundCounters => ({ likes: 0, comments: 0, follows: 0, scanned: 0, seen: [] });

async function startAutomation(): Promise<Result<{ started: true }>> {
  const settings = await getSettings();
  if (!settings.llm.apiKey && settings.automation.commentQuotaPerRound > 0) {
    await log('WARNING', '未配置 API Key，本轮将只执行点赞/关注，跳过评论');
  }

  state.running = true;
  state.cooling = false;
  await chrome.alarms.clear(ALARM_AUTO_TICK);
  await pushRuntime({
    phase: 'navigating',
    round: 0,
    counters: countersSnapshot(),
    nextRoundAt: null,
    roundStartedAt: null,
    lastError: null,
  });
  await log('INFO', '自动巡航已启动');

  void runRoundCycle(0);
  return { ok: true, data: { started: true } };
}

async function stopAutomation(reason = '用户手动停止'): Promise<Result<{ stopped: true }>> {
  state.running = false;
  state.cooling = false;
  await chrome.alarms.clear(ALARM_AUTO_TICK);

  // 广播制动，令 content script 立刻放弃当前动作
  const tab = state.tabId ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
  const tabId = tab?.id ?? (await findXTab())?.id ?? null;
  if (tabId !== null) {
    await sendToTab(tabId, { type: 'CS_ABORT' });
  }

  await pushRuntime({ phase: 'stopped', nextRoundAt: null });
  await log('WARNING', `紧急制动已触发：${reason}`);
  return { ok: true, data: { stopped: true } };
}

/** 单轮循环：执行 → 冷却 → 下一轮 */
async function runRoundCycle(round: number): Promise<void> {
  if (!state.running) return;

  const settings = await getSettings();
  const a = settings.automation;

  // 每轮开始先把页面拉回首页时间线
  await pushRuntime({ phase: 'navigating', round: round + 1 });
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
  await pushRuntime({
    phase: 'scrolling',
    roundStartedAt: Date.now(),
    counters: { ...countersSnapshot(), seen: runtime.counters.seen },
  });

  await log('INFO', `===== 第 ${round + 1} 轮开始 =====`);

  const res = await sendToTab<{
    likes: number;
    comments: number;
    follows: number;
    scanned: number;
    seen: string[];
    aborted: boolean;
    error: string | null;
  }>(tab.id, {
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
    },
  });

  if (!state.running) return; // 期间被制动

  if (!res.ok) {
    await failRound(`轮次执行失败：${res.error}`);
    return;
  }

  const outcome = res.data;
  await pushRuntime({
    phase: 'cooling',
    counters: {
      likes: outcome.likes,
      comments: outcome.comments,
      follows: outcome.follows,
      scanned: outcome.scanned,
      seen: outcome.seen,
    },
  });

  await log(
    'DONE',
    `第 ${round + 1} 轮结束｜赞 ${outcome.likes}・评 ${outcome.comments}・关注 ${outcome.follows}｜浏览 ${outcome.scanned} 条`,
  );
  if (outcome.error) await log('ERROR', `轮次内异常：${outcome.error}`);

  // 冷却
  const [minM, maxM] = settings.automation.roundSleepMin;
  const sleepMs = Math.round((minM + Math.random() * Math.max(0, maxM - minM)) * 60_000);
  const wakeAt = Date.now() + sleepMs;

  state.cooling = true;
  await pushRuntime({ phase: 'cooling', nextRoundAt: wakeAt });
  await log('WAIT', `进入冷却，将在 ${Math.round(sleepMs / 60000)} 分钟后开始第 ${round + 2} 轮`);

  scheduleWake(wakeAt, () => {
    void runRoundCycle(round + 1);
  });
}

async function failRound(reason: string): Promise<void> {
  await log('ERROR', reason);
  await pushRuntime({ phase: 'error', lastError: reason, nextRoundAt: null });
  if (state.running) {
    // 出错后等 2 分钟再试，而不是直接放弃
    const wakeAt = Date.now() + 120_000;
    await pushRuntime({ nextRoundAt: wakeAt });
    scheduleWake(wakeAt, () => {
      void runRoundCycle((0 as number) + (0 as number));
    });
  }
}

/**
 * 跨轮次定时。chrome.alarms 最小周期为 30s，
 * 用一次性 alarm 承载长等待，同时在内存中保留一个回退 setTimeout
 * （SW 未休眠时精度更高）。
 */
function scheduleWake(at: number, fn: () => void): void {
  const delayMs = Math.max(30_000, at - Date.now());
  const name = ALARM_AUTO_TICK;
  pendingTimers.set(name, fn as () => void);

  chrome.alarms.clear(name).then(() =>
    chrome.alarms.create(name, { when: Date.now() + delayMs }),
  );

  const localDelay = at - Date.now();
  if (localDelay < 60_000) {
    setTimeout(() => {
      if (pendingTimers.has(name) && state.running) {
        pendingTimers.delete(name);
        void chrome.alarms.clear(name);
        fn();
      }
    }, localDelay);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_AUTO_TICK) return;
  const fn = pendingTimers.get(ALARM_AUTO_TICK);
  pendingTimers.delete(ALARM_AUTO_TICK);
  if (fn && state.running) fn();
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

async function proxyGenerate(snapshot: TweetSnapshot): Promise<Result<{ text: string }>> {
  const settings = await getSettings();
  try {
    const text = await generateComment({
      ctx: proxyContext(),
      snapshot,
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

  // ---- content script -> SW：代理转发 ----
  if (msg.type === 'SW_TO_CONTENT') {
    const m = message as Extract<ToBackgroundMessage, { type: 'SW_TO_CONTENT' }>;
    sendToTab(m.tabId, m.payload).then(sendResponse);
    return true;
  }

  // ---- content script -> SW：生成评论 ----
  if (msg.type === 'SW_GENERATE_FOR') {
    const m = message as { snapshot: TweetSnapshot };
    proxyGenerate(m.snapshot)
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
    case 'LLM_GENERATE':
      proxyGenerate((message as { snapshot: TweetSnapshot }).snapshot)
        .then(sendResponse)
        .catch((e: Error) => sendResponse(fail(e.message)));
      return true;
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

// 首帧兜底：SW 冷启动时恢复一次状态
void (async () => {
  const rt = await getRuntime();
  if (rt.phase === 'cooling' && rt.nextRoundAt && rt.nextRoundAt > Date.now()) {
    // 页面刷新导致 SW 重启，续上之前的冷却计时
    state.running = true;
    state.cooling = true;
    scheduleWake(rt.nextRoundAt, () => void runRoundCycle(rt.round));
  }
})();

export {};
