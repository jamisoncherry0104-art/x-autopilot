/**
 * 响应式 chrome.storage 状态 Hook。
 * 所有面板通过它读写配置，保证「一处修改、全局同步」（storage.onChanged 天然跨上下文）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyTheme,
  clearLogs as clearLogsStorage,
  getLogs,
  getRuntime,
  getSettings,
  patchSettings as patchSettingsStorage,
  subscribeLogs,
  subscribeRuntime,
  subscribeSettings,
  type DeepPartial,
} from '../../shared/storage';
import { LOG_BUFFER_LIMIT } from '../../shared/constants';
import { createContext, type ApiContext, type HttpResponse, type HttpTransport } from '../../shared/api';
import type { AppSettings, AutomationRuntime, LogEntry, Result, UiHttpFetchMsg } from '../../shared/types';

export interface SettingsStore {
  settings: AppSettings | null;
  loading: boolean;
  /** 已保存指示（用于顶部闪现"已保存"） */
  saving: boolean;
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  replace: (next: AppSettings) => Promise<void>;
  reload: () => Promise<void>;
}

export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setLoading(false);
      applyTheme(s.theme);
    });
    const off = subscribeSettings((next) => {
      if (!alive) return;
      setSettings(next);
      applyTheme(next.theme);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const flashSaving = useCallback(() => {
    setSaving(true);
    if (savingTimer.current) window.clearTimeout(savingTimer.current);
    savingTimer.current = window.setTimeout(() => setSaving(false), 700);
  }, []);

  const update = useCallback(
    async (patch: DeepPartial<AppSettings>) => {
      const next = await patchSettingsStorage(patch);
      setSettings(next);
      flashSaving();
      return next;
    },
    [flashSaving],
  );

  const replace = useCallback(
    async (next: AppSettings) => {
      const { saveSettings } = await import('../../shared/storage');
      await saveSettings(next);
      setSettings(next);
      flashSaving();
    },
    [flashSaving],
  );

  const reload = useCallback(async () => {
    setSettings(await getSettings());
  }, []);

  // 跟随系统主题变化
  useEffect(() => {
    if (settings?.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings?.theme]);

  useEffect(() => {
    if (!settings) return;
    applyTheme(settings.theme);
  }, [settings]);

  // 卸载时清掉"已保存"闪现的定时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (savingTimer.current) window.clearTimeout(savingTimer.current);
    };
  }, []);

  return { settings, loading, saving, update, replace, reload };
}

/* ------------------------------------------------------------------ */

export interface LogStore {
  logs: LogEntry[];
  clear: () => Promise<void>;
}

export function useLogs(): LogStore {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let alive = true;
    void getLogs().then((l) => alive && setLogs(l));
    const off = subscribeLogs((l) => alive && setLogs(l.slice(-LOG_BUFFER_LIMIT)));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const clear = useCallback(async () => {
    await clearLogsStorage();
    setLogs([]);
  }, []);

  return { logs, clear };
}

/* ------------------------------------------------------------------ */

export interface RuntimeStore {
  runtime: AutomationRuntime | null;
  refresh: () => Promise<void>;
}

export function useRuntime(): RuntimeStore {
  const [runtime, setRuntime] = useState<AutomationRuntime | null>(null);

  useEffect(() => {
    let alive = true;
    void getRuntime().then((r) => alive && setRuntime(r));
    const off = subscribeRuntime((r) => alive && setRuntime(r));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const refresh = useCallback(async () => {
    setRuntime(await getRuntime());
  }, []);

  return { runtime, refresh };
}

/* ------------------------------------------------------------------ */

/** 当前激活标签页的 URL，用于判断是否处于推文详情页 */
export function useActiveTabUrl(pollMs = 1200): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const probe = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (alive) setUrl(tab?.url ?? null);
      } catch {
        if (alive) setUrl(null);
      }
    };

    void probe();
    const timer = window.setInterval(probe, pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pollMs]);

  return url;
}

/* ------------------------------------------------------------------ */

/** 倒计时：给定目标时间戳，返回剩余毫秒 */
export function useCountdown(target: number | null): number {
  const [left, setLeft] = useState(() => (target ? Math.max(0, target - Date.now()) : 0));

  useEffect(() => {
    if (!target) {
      setLeft(0);
      return;
    }
    const tick = () => setLeft(Math.max(0, target - Date.now()));
    tick();
    const t = window.setInterval(tick, 500);
    return () => window.clearInterval(t);
  }, [target]);

  return left;
}

/* ------------------------------------------------------------------ */

/** 统一的 SW 调用封装，把 Result 解包成 throw / return */
export async function callBackground<T>(message: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage(message)) as Result<T> | undefined;
  if (!res) throw new Error('后台无响应');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/**
 * side panel 专用的 HTTP transport：把请求转发给 service worker 执行。
 *
 * side panel 是普通文档，其 fetch 受同源策略约束。若模型网关未开放跨域
 * （无 Access-Control-Allow-Origin、OPTIONS 预检被拒），请求会在浏览器
 * 网络层被拦截并抛 "Failed to fetch"。service worker 的请求受
 * host_permissions 保护，不受此限制，因此所有出站请求都经它中转。
 */
export const swProxyTransport: HttpTransport = async (req) => {
  const res = (await chrome.runtime.sendMessage({
    type: 'LLM_HTTP_FETCH',
    req,
  } satisfies UiHttpFetchMsg)) as Result<HttpResponse> | undefined;

  if (!res) throw new Error('后台无响应，请尝试重新加载扩展');
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

/** 构造一个使用 SW 网络出口的 API 上下文 */
export function uiApiContext(): ApiContext {
  return createContext(swProxyTransport);
}

/** 向 content script 发消息（可能失败，返回 Result 而非抛异常） */
export async function callTab<T>(tabId: number, message: unknown): Promise<Result<T>> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, message)) as Result<T> | undefined;
    return res ?? { ok: false, error: '页面脚本无响应，请刷新 X 页面' };
  } catch (err) {
    return { ok: false, error: `无法连接到页面：${(err as Error).message}` };
  }
}

/** 取得当前 X 标签页 id（不存在则返回 null） */
export async function findXTabId(): Promise<number | null> {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id && isXUrl(active.url)) return active.id;
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    return tabs.find((t) => t.id)?.id ?? null;
  } catch {
    return null;
  }
}

export function isXUrl(url: string | null | undefined): boolean {
  return !!url && /^https:\/\/(x|twitter)\.com\//.test(url);
}

/**
 * 是否为推文详情页。
 *
 * 必须排除 X 的保留路径段（home / explore / i / search …）：
 * 原先写成 `[^/]+\/status\/\d+`，会让 `x.com/home` 这类页面也被判定为
 * 详情页（"home" 恰好充当了用户名字段），导致自动抓取在首页被误触发。
 */
const RESERVED_FIRST_SEGMENT = /^(home|explore|notifications|messages|settings|search|compose|i)$/;

export function isTweetDetailUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const m = /^https:\/\/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/.exec(url);
  if (!m) return false;
  return !RESERVED_FIRST_SEGMENT.test(m[1]);
}

export function isHomeUrl(url: string | null | undefined): boolean {
  return !!url && /^https:\/\/(x|twitter)\.com\/(home|i\/timeline)?/.test(url);
}
