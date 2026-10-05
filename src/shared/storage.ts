import { LOG_BUFFER_LIMIT, SCHEMA_VERSION, STORAGE_KEYS, buildDefaultSettings } from './constants';
import type {
  AppSettings,
  AutomationRuntime,
  LogEntry,
  LogLevel,
  Result,
  ThemeMode,
} from './types';

/* ------------------------------------------------------------------ */
/* 低层读写                                                            */
/* ------------------------------------------------------------------ */

async function rawGet<T>(key: string): Promise<T | undefined> {
  const bag = await chrome.storage.local.get(key);
  return bag[key] as T | undefined;
}

async function rawSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/* ------------------------------------------------------------------ */
/* 深合并：保证新增字段在旧配置上被补全                                */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] = isPlainObject(v) && isPlainObject(prev) ? deepMerge(prev, v) : v;
  }
  return out as T;
}

/** 数组形式的配置（personas / 区间）整体替换，不做元素级合并 */
export function mergeSettings(stored: unknown): AppSettings {
  const fallback = buildDefaultSettings();
  if (!isPlainObject(stored)) return fallback;
  const merged = deepMerge(fallback, stored);
  // personas 必须是合法数组，否则回落默认
  if (!Array.isArray(merged.prompt.personas) || merged.prompt.personas.length === 0) {
    merged.prompt.personas = fallback.prompt.personas;
  }
  if (!merged.prompt.personas.some((p) => p.id === merged.prompt.activePersonaId)) {
    merged.prompt.activePersonaId = merged.prompt.personas[0].id;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export async function getSettings(): Promise<AppSettings> {
  const stored = await rawGet<unknown>(STORAGE_KEYS.settings);
  const merged = mergeSettings(stored);
  const version = (await rawGet<number>(STORAGE_KEYS.schema)) ?? 0;
  if (version !== SCHEMA_VERSION) {
    await rawSet(STORAGE_KEYS.settings, merged);
    await rawSet(STORAGE_KEYS.schema, SCHEMA_VERSION);
  }
  return merged;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await rawSet(STORAGE_KEYS.settings, settings);
}

/** 局部更新设置（含深合并），返回更新后的完整设置 */
export async function patchSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = mergeSettings(deepMerge(current, patch));
  await saveSettings(next);
  return next;
}

/** 递归可选：对象递归降级，数组整体替换（元素不做部分化） */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly (infer _E)[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/* ------------------------------------------------------------------ */
/* 配置预检                                                            */
/* ------------------------------------------------------------------ */

export interface PreflightIssue {
  field: string;
  message: string;
  severity: 'error' | 'warn';
}

export function preflight(settings: AppSettings): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const { llm, prompt } = settings;

  if (!llm.apiKey.trim()) {
    issues.push({ field: 'apiKey', message: '未填写 API Key，所有生成功能不可用', severity: 'error' });
  }
  if (!/^https?:\/\//i.test(llm.baseUrl.trim())) {
    issues.push({ field: 'baseUrl', message: 'Base URL 必须以 http:// 或 https:// 开头', severity: 'error' });
  }
  if (!llm.model.trim()) {
    issues.push({ field: 'model', message: '未填写模型名称', severity: 'error' });
  }
  if (prompt.maxChars < 20 || prompt.maxChars > 280) {
    issues.push({ field: 'maxChars', message: '回复字符上限建议在 20 ~ 280 之间', severity: 'warn' });
  }
  /*
   * 模板校验分两层：
   *
   *  1) 各自不能为空 —— 这是硬错误，逐模板检查。
   *  2) {tweet_text} 必须出现至少一次 —— 但**不能逐模板要求**。
   *
   * 默认模板的分工是：systemTemplate 只放规则与约束（{max_chars} / {lang_rule}），
   * {tweet_text} 放在 userTemplate 里。renderTemplate 会把两个模板分别渲染后
   * 一并作为 system / user 消息发给模型 —— 变量只要在**任一模板**中出现，
   * 模型就能看到推文内容。
   *
   * 早先逐模板校验，导致「用默认模板必然误报 systemTemplate 缺少 {tweet_text}」。
   */
  const tplKeys = ['systemTemplate', 'userTemplate'] as const;
  for (const key of tplKeys) {
    if (!prompt[key].trim()) {
      issues.push({ field: key, message: '提示词模板为空', severity: 'error' });
    }
  }
  const mergedTemplate = tplKeys.map((k) => prompt[k]).join('\n');
  if (!mergedTemplate.includes('{tweet_text}')) {
    issues.push({
      field: 'prompt.templates',
      message: '两个提示词模板都没有 {tweet_text} 变量，模型将看不到推文内容',
      severity: 'warn',
    });
  }
  if (settings.automation.enabled) {
    const a = settings.automation;
    if (a.likeQuotaPerRound + a.commentQuotaPerRound + a.followQuotaPerRound === 0) {
      issues.push({ field: 'automation.quotas', message: '所有配额均为 0，自动巡航不会产生任何动作', severity: 'warn' });
    }
    if (a.actionDelaySec[0] < 5) {
      issues.push({ field: 'automation.actionDelaySec', message: '动作间隔低于 5 秒，风控风险显著升高', severity: 'warn' });
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: PreflightIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/* ------------------------------------------------------------------ */
/* 运行态                                                              */
/* ------------------------------------------------------------------ */

export function idleRuntime(): AutomationRuntime {
  return {
    phase: 'idle',
    round: 0,
    roundStartedAt: null,
    nextRoundAt: null,
    counters: { likes: 0, comments: 0, follows: 0, scanned: 0, seen: [] },
    lastError: null,
  };
}

export async function getRuntime(): Promise<AutomationRuntime> {
  const stored = await rawGet<AutomationRuntime>(STORAGE_KEYS.runtime);
  if (!stored) return idleRuntime();
  const base = idleRuntime();
  return { ...base, ...stored, counters: { ...base.counters, ...stored.counters } };
}

export async function setRuntime(runtime: AutomationRuntime): Promise<void> {
  await rawSet(STORAGE_KEYS.runtime, runtime);
}

/* ------------------------------------------------------------------ */
/* 日志环形缓冲                                                        */
/* ------------------------------------------------------------------ */

export async function getLogs(): Promise<LogEntry[]> {
  return (await rawGet<LogEntry[]>(STORAGE_KEYS.logs)) ?? [];
}

export async function appendLog(entry: Omit<LogEntry, 'id' | 'ts'> & { ts?: number }): Promise<LogEntry> {
  const full: LogEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: entry.ts ?? Date.now(),
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
  };
  const logs = await getLogs();
  const next = [...logs, full].slice(-LOG_BUFFER_LIMIT);
  await rawSet(STORAGE_KEYS.logs, next);
  return full;
}

export async function clearLogs(): Promise<void> {
  await rawSet(STORAGE_KEYS.logs, []);
}

/* ------------------------------------------------------------------ */
/* 变更订阅                                                            */
/* ------------------------------------------------------------------ */

type Listener = (settings: AppSettings) => void;

export function subscribeSettings(listener: Listener): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !(STORAGE_KEYS.settings in changes)) return;
    listener(mergeSettings(changes[STORAGE_KEYS.settings].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export function subscribeLogs(listener: (logs: LogEntry[]) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !(STORAGE_KEYS.logs in changes)) return;
    listener((changes[STORAGE_KEYS.logs].newValue as LogEntry[]) ?? []);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export function subscribeRuntime(listener: (rt: AutomationRuntime) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !(STORAGE_KEYS.runtime in changes)) return;
    const v = changes[STORAGE_KEYS.runtime].newValue as AutomationRuntime | undefined;
    listener(v ? { ...idleRuntime(), ...v } : idleRuntime());
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = resolved;
}

/* ------------------------------------------------------------------ */
/* 导入 / 导出                                                         */
/* ------------------------------------------------------------------ */

export function exportSettings(settings: AppSettings): string {
  // 导出时默认剔除密钥，避免明文泄露到剪贴板
  const clone: AppSettings = JSON.parse(JSON.stringify(settings));
  clone.llm.apiKey = '';
  return JSON.stringify(clone, null, 2);
}

export async function importSettings(json: string): Promise<Result<AppSettings>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed)) {
      return { ok: false, error: '配置格式不合法：顶层必须是对象' };
    }
    const current = await getSettings();
    const merged = mergeSettings(parsed);
    // 导入的配置通常不含密钥，保留现有密钥
    if (!merged.llm.apiKey && current.llm.apiKey) merged.llm.apiKey = current.llm.apiKey;
    await saveSettings(merged);
    return { ok: true, data: merged };
  } catch (err) {
    return { ok: false, error: `解析失败：${(err as Error).message}` };
  }
}

export const LOG_LEVEL_ORDER: LogLevel[] = ['INFO', 'ACTION', 'WAIT', 'WARNING', 'ERROR', 'DONE'];
