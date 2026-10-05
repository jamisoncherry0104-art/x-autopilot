import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Database,
  Download,
  Eye,
  EyeOff,
  Plug,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  Wand2,
} from 'lucide-react';
import type { AppSettings, LlmProtocol, SelfTestReport } from '../../shared/types';
import type { DeepPartial } from '../../shared/storage';
import { LLM_PRESETS, X_SELECTORS } from '../../shared/constants';
import { KNOWN_TEMPLATE_VARS, discoverModelsUrl, listTemplateVars } from '../../shared/api';
import { exportSettings, importSettings, preflight } from '../../shared/storage';
import { cn } from '../../shared/utils';
import { callBackground, callTab, findXTabId } from '../hooks/useStorage';
import { Badge, Card, Field, SectionTitle, Select, Spinner, Switch, TextArea, TextInput, Toast } from './ui';
import ProfileCard from './ProfileCard';

interface Props {
  settings: AppSettings;
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  replace: (next: AppSettings) => Promise<void>;
  onToast: (msg: string, tone?: 'ok' | 'danger') => void;
}

type Tab = 'llm' | 'prompt' | 'data';

/* ------------------------------------------------------------------ */
/* 网关域名授权                                                        */
/* ------------------------------------------------------------------ */

/**
 * manifest 的 host_permissions 只硬编码了 x.com / twitter.com。
 * 用户自填的模型网关走 optional_host_permissions，需要运行时通过
 * chrome.permissions.request 显式授予，否则 service worker 的 fetch 会被拒。
 */
function GatewayPermission({ baseUrl, onGranted }: { baseUrl: string; onGranted: () => void }) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const origin = useMemo(() => {
    try {
      const raw = /^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`;
      return new URL(raw).origin + '/*';
    } catch {
      return null;
    }
  }, [baseUrl]);

  useEffect(() => {
    let alive = true;
    if (!origin) {
      setGranted(null);
      return;
    }
    void chrome.permissions
      .contains({ origins: [origin] })
      .then((v) => alive && setGranted(v))
      .catch(() => alive && setGranted(false));
    return () => {
      alive = false;
    };
  }, [origin]);

  const grant = useCallback(async () => {
    if (!origin) return;
    setBusy(true);
    try {
      const ok = await chrome.permissions.request({ origins: [origin] });
      setGranted(ok);
      if (ok) onGranted();
    } catch {
      setGranted(false);
    } finally {
      setBusy(false);
    }
  }, [origin, onGranted]);

  if (!origin) {
    return (
      <div className="mb-3 rounded-lg bg-danger/10 px-2.5 py-2 text-[11px] leading-snug text-danger">
        Base URL 格式不合法，无法解析出网关域名
      </div>
    );
  }

  if (granted) {
    return (
      <div className="mb-3 flex items-center gap-1.5 rounded-lg bg-ok/10 px-2.5 py-2 text-[11px] leading-snug text-ok">
        <CheckCircle2 size={12} className="shrink-0" />
        <span>
          已授权访问 <span className="font-mono">{new URL(origin.replace('/*', '')).host}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 p-2.5">
      <p className="mb-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-warn">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>
          尚未授权访问 <span className="font-mono">{new URL(origin.replace('/*', '')).host}</span>。
          浏览器扩展必须显式获得域名授权才能发起跨域请求，否则会报「无法连接到模型」。
        </span>
      </p>
      <button type="button" className="xa-btn-primary w-full !py-1.5" onClick={grant} disabled={busy}>
        {busy ? <Spinner size={11} /> : <ShieldCheck size={12} />}
        {busy ? '等待授权…' : '授权访问该网关'}
      </button>
    </div>
  );
}


export default function SettingsModal({ settings, update, replace, onToast }: Props) {
  const [tab, setTab] = useState<Tab>('llm');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [selftest, setSelftest] = useState<SelfTestReport | null>(null);
  const [selftestBusy, setSelftestBusy] = useState(false);
  const [modelList, setModelList] = useState<string[] | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'danger' } | null>(null);

  const issues = useMemo(() => preflight(settings), [settings]);

  /* ---------------- LLM 配置 ---------------- */

  const applyPreset = useCallback(
    (label: string) => {
      const p = LLM_PRESETS.find((x) => x.label === label);
      if (!p) return;
      void update({
        llm: { protocol: p.protocol, baseUrl: p.baseUrl, model: p.model },
      });
      setToast({ msg: `已切换到 ${p.label} 预设`, tone: 'ok' });
    },
    [update],
  );

  const test = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await callBackground<{ models: string[] | null; modelsProbe: string; note: string }>({
        type: 'LLM_TEST',
      });
      setTestResult({ ok: true, msg: r.note });
      if (r.models && r.models.length > 0) setModelList(r.models);
    } catch (err) {
      setTestResult({ ok: false, msg: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, []);

  /** 从 side panel 直接探测，用于验证网关是否开放跨域 */
  const diagCors = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await callBackground<{ ok: boolean; status: number; text: string }>({
        type: 'LLM_HTTP_FETCH',
        req: {
          url: discoverModelsUrl(settings.llm.baseUrl),
          method: 'GET',
          headers: { Authorization: `Bearer ${settings.llm.apiKey}` },
          timeoutMs: 15_000,
        },
      });
      setTestResult({
        ok: r.ok,
        msg: `经后台出站成功：HTTP ${r.status}，响应 ${r.text.length} 字节。说明网络与鉴权链路正常。`,
      });
    } catch (err) {
      setTestResult({ ok: false, msg: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [settings.llm.baseUrl, settings.llm.apiKey]);

  /* ---------------- DOM 自检 ---------------- */

  const runSelftest = useCallback(async () => {
    setSelftestBusy(true);
    try {
      const tabId = await findXTabId();
      if (tabId === null) throw new Error('未找到已打开的 X 页面');
      const res = await callTab<SelfTestReport>(tabId, { type: 'CS_SELFTEST' });
      if (!res.ok) throw new Error(res.error);
      setSelftest(res.data);
    } catch (err) {
      setToast({ msg: (err as Error).message, tone: 'danger' });
    } finally {
      setSelftestBusy(false);
    }
  }, []);

  /* ---------------- 导入导出 ---------------- */

  const doExport = useCallback(async () => {
    const json = exportSettings(settings);
    try {
      await navigator.clipboard.writeText(json);
      setToast({ msg: '配置已复制到剪贴板（不含 API Key）', tone: 'ok' });
    } catch {
      setImportText(json);
      setShowImport(true);
      setToast({ msg: '剪贴板不可用，已填入下方文本框', tone: 'ok' });
    }
  }, [settings]);

  const doImport = useCallback(async () => {
    const res = await importSettings(importText);
    if (!res.ok) {
      setToast({ msg: res.error, tone: 'danger' });
      return;
    }
    await replace(res.data);
    setShowImport(false);
    setImportText('');
    setToast({ msg: '配置已导入', tone: 'ok' });
  }, [importText, replace]);

  const resetAll = useCallback(async () => {
    const { buildDefaultSettings } = await import('../../shared/constants');
    const fresh = buildDefaultSettings();
    fresh.llm.apiKey = settings.llm.apiKey; // 保留密钥
    await replace(fresh);
    setToast({ msg: '已恢复默认（保留 API Key）', tone: 'ok' });
  }, [replace, settings.llm.apiKey]);

  /* ---------------- 渲染 ---------------- */

  const tplVars = listTemplateVars(settings.prompt.systemTemplate + settings.prompt.userTemplate);
  const unknownVars = tplVars.filter((v) => !(KNOWN_TEMPLATE_VARS as readonly string[]).includes(v));

  return (
    <div className="space-y-3 p-3">
      {/* 顶部 Tab */}
      <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--xa-surface)' }}>
        {(
          [
            { id: 'llm', label: '模型', icon: <Plug size={12} /> },
            { id: 'prompt', label: '提示词', icon: <Wand2 size={12} /> },
            { id: 'data', label: '数据与诊断', icon: <Database size={12} /> },
          ] as Array<{ id: Tab; label: string; icon: React.ReactNode }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] font-medium transition-colors',
              tab === t.id ? 'bg-brand text-white' : 'text-ink-300 hover:text-ink-100',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 预检告警 */}
      {issues.length > 0 && tab !== 'data' && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-warn">
            <AlertTriangle size={12} />
            配置预检发现 {issues.length} 项问题
          </div>
          <ul className="space-y-0.5">
            {issues.map((i, idx) => (
              <li key={idx} className={cn('text-[11px] leading-snug', i.severity === 'error' ? 'text-danger' : 'text-warn')}>
                • {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------- 模型 Tab ---------------- */}
      {tab === 'llm' && (
        <>
          <Card>
            <SectionTitle title="快速预设" hint="选择厂商后自动填好 Base URL 与模型名" />
            <div className="flex flex-wrap gap-1.5">
              {LLM_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="xa-chip"
                  data-active={settings.llm.baseUrl === p.baseUrl}
                  onClick={() => applyPreset(p.label)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="接口配置" hint="兼容 OpenAI /v1/chat/completions 与 Anthropic /v1/messages" />

            <Select<LlmProtocol>
              id="protocol"
              label="协议"
              value={settings.llm.protocol}
              onChange={(v) => void update({ llm: { protocol: v } })}
              options={[
                { value: 'openai', label: 'OpenAI 兼容（/v1/chat/completions）' },
                { value: 'anthropic', label: 'Anthropic（/v1/messages）' },
              ]}
              hint="绝大多数国产模型（DeepSeek / Moonshot / 智谱 / 通义）都走 OpenAI 兼容协议"
            />

            <Field label="Base URL" hint="会自动补全端点路径；也可直接填完整的 chat/completions 地址" htmlFor="baseUrl">
              <TextInput
                id="baseUrl"
                value={settings.llm.baseUrl}
                onCommit={(v) => void update({ llm: { baseUrl: v } })}
                placeholder="https://api.deepseek.com/v1"
                monospace
              />
            </Field>

            <Field label="API Key" hint="仅存储在本机 chrome.storage.local，不会上传到任何服务器" htmlFor="apiKey">
              <div className="flex gap-1.5">
                <TextInput
                  id="apiKey"
                  type={showKey ? 'text' : 'password'}
                  value={settings.llm.apiKey}
                  onCommit={(v) => void update({ llm: { apiKey: v.trim() } })}
                  placeholder="sk-..."
                  monospace
                />
                <button
                  type="button"
                  className="xa-btn-ghost shrink-0 !px-2"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </Field>

            {/* 网关域名必须授予 host 权限，否则 SW 无法出站 */}
            <GatewayPermission
              baseUrl={settings.llm.baseUrl}
              onGranted={() => {
                setToast({ msg: '已授予网关访问权限', tone: 'ok' });
                setTestResult(null);
              }}
            />

            <Field label="模型名称" htmlFor="model">
              <TextInput
                id="model"
                value={settings.llm.model}
                onCommit={(v) => void update({ llm: { model: v } })}
                placeholder="deepseek-chat"
                monospace
              />
            </Field>

            <Field label="温度" hint="评论场景建议 0.8 ~ 1.2，过低会千篇一律，过高容易跑题">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settings.llm.temperature}
                  aria-label="温度"
                  onChange={(e) => void update({ llm: { temperature: Number(e.target.value) } })}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-ink-600 accent-brand"
                />
                <span className="w-9 shrink-0 text-right font-mono text-[11px] text-brand">
                  {settings.llm.temperature.toFixed(1)}
                </span>
              </div>
            </Field>

            <div className="flex gap-2">
              <button type="button" className="xa-btn-ghost flex-1" onClick={test} disabled={testing}>
                {testing ? <Spinner /> : <Plug size={13} />}
                {testing ? '测试中…' : '测试连通性'}
              </button>
              <button
                type="button"
                className="xa-btn-ghost"
                onClick={diagCors}
                disabled={testing}
                title="经后台出站请求 /models，用于确认网络链路是否可用"
              >
                链路诊断
              </button>
            </div>

            {testResult && (
              <p
                className={cn(
                  'mt-2 flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-[11px] leading-snug',
                  testResult.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger',
                )}
              >
                {testResult.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                <span className="break-all">{testResult.msg}</span>
              </p>
            )}

            {modelList && modelList.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-brand">
                  该网关共 {modelList.length} 个模型（点击查看，可核对模型名）
                </summary>
                <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto rounded-lg p-2" style={{ background: 'var(--xa-bg)' }}>
                  {modelList.map((m) => (
                    <li key={m}>
                      <button
                        type="button"
                        className={cn(
                          'w-full rounded px-1.5 py-1 text-left font-mono text-[10.5px] transition-colors hover:bg-brand/10',
                          m === settings.llm.model ? 'font-medium text-brand' : 'text-ink-300',
                        )}
                        onClick={() => {
                          void update({ llm: { model: m } });
                          setToast({ msg: `已选用 ${m}`, tone: 'ok' });
                        }}
                      >
                        {m}
                        {m === settings.llm.model && ' ← 当前'}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        </>
      )}

      {/* ---------------- 提示词 Tab ---------------- */}
      {tab === 'prompt' && (
        <>
          <Card>
            <SectionTitle
              title="模板变量"
              hint="可用变量：{tweet_text} {tweet_author} {tweet_handle} {persona} {max_chars} {lang_rule}"
            />
            {unknownVars.length > 0 && (
              <p className="rounded-lg bg-warn/10 px-2.5 py-2 text-[11px] leading-snug text-warn">
                检测到未识别的变量：
                <span className="font-mono"> {unknownVars.join(', ')}</span>。这些占位符会原样发送给模型。
              </p>
            )}
          </Card>

          <Card>
            <SectionTitle title="System Prompt" hint="定义角色与硬性约束" />
            <TextArea
              value={settings.prompt.systemTemplate}
              onCommit={(v) => void update({ prompt: { systemTemplate: v } })}
              rows={10}
              monospace
              placeholder="你是一名…"
            />
          </Card>

          <Card>
            <SectionTitle title="User Prompt" hint="每次请求填入的推文内容与风格" />
            <TextArea
              value={settings.prompt.userTemplate}
              onCommit={(v) => void update({ prompt: { userTemplate: v } })}
              rows={8}
              monospace
            />
          </Card>

          <Card>
            <SectionTitle title="输出约束" />
            <Field label="回复字符上限" hint="会同时作为模型约束与前端截断依据">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={20}
                  max={280}
                  step={10}
                  value={settings.prompt.maxChars}
                  aria-label="字符上限"
                  onChange={(e) => void update({ prompt: { maxChars: Number(e.target.value) } })}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-ink-600 accent-brand"
                />
                <span className="w-10 shrink-0 text-right font-mono text-[11px] text-brand">{settings.prompt.maxChars}</span>
              </div>
            </Field>

            <Select
              id="lang"
              label="输出语言"
              value={settings.prompt.lang}
              onChange={(v) => void update({ prompt: { lang: v } })}
              options={[
                { value: 'auto', label: '跟随推文语言' },
                { value: 'zh', label: '强制简体中文' },
                { value: 'en', label: '强制英文' },
              ]}
            />

            <Field label="生成后自动发送延时（毫秒）" hint="给页面留出渲染时间，建议不低于 1200ms">
              <TextInput
                type="number"
                value={String(settings.prompt.autoSendDelayMs)}
                onCommit={(v) => void update({ prompt: { autoSendDelayMs: Math.max(300, Number(v) || 1500) } })}
              />
            </Field>
          </Card>

          <Card>
            <SectionTitle
              title="语气预设"
              hint="手动模式中可切换；自动模式使用「当前选中」的这一条"
              action={
                <button
                  type="button"
                  className="xa-btn-ghost !px-2 !py-1 text-[11px]"
                  onClick={() => {
                    const id = `custom-${Date.now().toString(36)}`;
                    const personas = [
                      ...settings.prompt.personas,
                      { id, label: '自定义语气', hint: '点击编辑', body: '在此填写该语气的具体描述…' },
                    ];
                    void update({ prompt: { personas, activePersonaId: id } });
                  }}
                >
                  + 新增
                </button>
              }
            />

            <div className="space-y-2">
              {settings.prompt.personas.map((p, idx) => (
                <div
                  key={p.id}
                  className={cn(
                    'rounded-lg border p-2.5 transition-colors',
                    p.id === settings.prompt.activePersonaId && 'border-brand/60 bg-brand/[0.06]',
                  )}
                  style={{
                    borderColor: p.id === settings.prompt.activePersonaId ? undefined : 'var(--xa-border)',
                  }}
                >
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <input
                      className="xa-input !py-1 !text-[11.5px]"
                      defaultValue={p.label}
                      onBlur={(e) => {
                        const personas = settings.prompt.personas.map((x, i) =>
                          i === idx ? { ...x, label: e.target.value || x.label } : x,
                        );
                        void update({ prompt: { personas } });
                      }}
                      aria-label={`语气 ${idx + 1} 名称`}
                    />
                    {p.id === settings.prompt.activePersonaId ? (
                      <Badge tone="brand">使用中</Badge>
                    ) : (
                      <button
                        type="button"
                        className="xa-btn-ghost shrink-0 !px-2 !py-1 text-[10.5px]"
                        onClick={() => void update({ prompt: { activePersonaId: p.id } })}
                      >
                        选用
                      </button>
                    )}
                    <button
                      type="button"
                      className="xa-btn-ghost shrink-0 !px-2 !py-1 text-[10.5px] text-danger"
                      disabled={settings.prompt.personas.length <= 1}
                      onClick={() => {
                        const personas = settings.prompt.personas.filter((_, i) => i !== idx);
                        const activePersonaId =
                          p.id === settings.prompt.activePersonaId ? personas[0]?.id ?? '' : settings.prompt.activePersonaId;
                        void update({ prompt: { personas, activePersonaId } });
                      }}
                    >
                      删除
                    </button>
                  </div>
                  <textarea
                    rows={2}
                    className="xa-input resize-y !text-[11px] leading-relaxed"
                    defaultValue={p.body}
                    aria-label={`${p.label} 描述`}
                    onBlur={(e) => {
                      const personas = settings.prompt.personas.map((x, i) =>
                        i === idx ? { ...x, body: e.target.value } : x,
                      );
                      void update({ prompt: { personas } });
                    }}
                  />
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {/* ---------------- 数据与诊断 Tab ---------------- */}
      {tab === 'data' && (
        <>
          <Card>
            <SectionTitle title="外观" />
            <Select
              id="theme"
              label="主题"
              value={settings.theme}
              onChange={(v) => void update({ theme: v })}
              options={[
                { value: 'dark', label: '深色' },
                { value: 'light', label: '浅色' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          </Card>

          <Card>
            <SectionTitle
              icon={<Bug size={13} />}
              title="DOM 选择器自检"
              hint="X 改版后选择器可能失效，用它在真实页面上验证"
              action={
                <button type="button" className="xa-btn-ghost !px-2 !py-1 text-[11px]" onClick={runSelftest} disabled={selftestBusy}>
                  {selftestBusy ? <Spinner size={11} /> : <RefreshCw size={11} />}
                  运行
                </button>
              }
            />

            {!selftest ? (
              <p className="py-3 text-center text-[11px] text-ink-400">
                在已打开 X 页面的情况下点击「运行」，会读取当前页面各关键选择器的命中数量。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {(
                  [
                    ['推文容器', selftest.tweetArticle, X_SELECTORS.tweet],
                    ['推文正文', selftest.tweetText, X_SELECTORS.tweetText],
                    ['作者信息', selftest.userName, X_SELECTORS.userName],
                    ['编辑器', selftest.editor, X_SELECTORS.editor],
                    ['回复按钮', selftest.replyButton, X_SELECTORS.replyButton],
                    ['点赞按钮', selftest.likeButton, X_SELECTORS.like],
                    ['关注按钮', selftest.followButton, X_SELECTORS.follow],
                  ] as const
                ).map(([name, row, sel]) => (
                  <li key={name} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--xa-bg)' }}>
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-medium">{name}</div>
                      <div className="truncate font-mono text-[10px] text-ink-400" title={sel}>
                        {sel}
                      </div>
                    </div>
                    <Badge tone={row.count > 0 ? 'ok' : 'warn'}>
                      {row.count > 0 ? `${row.count} 个` : '未命中'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {selftest && (
              <p className="mt-2 font-mono text-[10px] text-ink-400">检测页面：{selftest.url}</p>
            )}
          </Card>

          <Card>
            <SectionTitle title="配置导入 / 导出" hint="导出内容会剔除 API Key" />
            <div className="flex gap-2">
              <button type="button" className="xa-btn-ghost flex-1" onClick={doExport}>
                <Download size={13} />
                导出
              </button>
              <button type="button" className="xa-btn-ghost flex-1" onClick={() => setShowImport((v) => !v)}>
                <Upload size={13} />
                导入
              </button>
            </div>

            {showImport && (
              <div className="mt-2.5">
                <TextArea value={importText} onCommit={setImportText} rows={6} monospace placeholder="粘贴配置 JSON" />
                <button type="button" className="xa-btn-primary mt-2 w-full" onClick={doImport} disabled={!importText.trim()}>
                  确认导入
                </button>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle title="危险操作" />
            <Switch
              label="恢复出厂设置"
              hint="清空全部提示词与自动化配置，保留 API Key"
              checked={false}
              onChange={(v) => {
                if (v) void resetAll();
              }}
            />
            <p className="mt-1 flex items-start gap-1.5 text-[10.5px] leading-snug text-ink-400">
              <RotateCcw size={11} className="mt-0.5 shrink-0" />
              <span>操作不可撤销。如需完整备份，请先点上方「导出」。</span>
            </p>
          </Card>
        </>
      )}

      {/* 作者卡片：常驻在设置页最底部，仅「已关注」时隐藏 */}
      {!settings.profileCard.followed && (
        <ProfileCard profileCard={settings.profileCard} update={update} onToast={onToast} showDismiss={false} />
      )}

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
