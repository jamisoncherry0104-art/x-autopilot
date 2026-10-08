import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Sparkles, Terminal, UserPlus } from 'lucide-react';
import type { AppSettings, FollowOutcome, LogEntry, TweetDetailContext } from '../../shared/types';
import type { DeepPartial } from '../../shared/storage';
import { cn, formatClock } from '../../shared/utils';
import { callBackground, callTab, findXTabId, isTweetDetailUrl, useActiveTabUrl } from '../hooks/useStorage';
import { Badge, Card, SectionTitle, Spinner } from './ui';

interface Props {
  settings: AppSettings;
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  logs: LogEntry[];
  onToast: (msg: string, tone?: 'ok' | 'danger') => void;
}

type Stage = 'idle' | 'extracting' | 'generating' | 'filling' | 'submitting' | 'following';

export default function ManualMode({ settings, update, logs, onToast }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const tabUrl = useActiveTabUrl();
  const [snapshot, setSnapshot] = useState<TweetDetailContext | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 已自动处理过的详情页 URL，避免同一页面反复触发自动链 */
  const autoHandledRef = useRef<string | null>(null);
  /** 防止自动链重入（stage 是异步更新的，不能作为唯一门闩） */
  const autoBusyRef = useRef(false);

  const onDetailPage = isTweetDetailUrl(tabUrl);

  /* 页面切换后清空旧快照，避免生成到上一条推文 */
  useEffect(() => {
    setSnapshot(null);
    setDraft('');
    setError(null);
    // URL 变了就允许新一轮自动处理
    autoHandledRef.current = null;
  }, [tabUrl]);

  const activePersona = useMemo(
    () => settings.prompt.personas.find((p) => p.id === settings.prompt.activePersonaId),
    [settings.prompt.personas, settings.prompt.activePersonaId],
  );

  const auto = settings.manualAuto;
  const busy = stage !== 'idle';

  /* ---------------- 抓取 ---------------- */

  const extract = useCallback(async (): Promise<TweetDetailContext | null> => {
    setError(null);
    setStage('extracting');
    try {
      const tabId = await findXTabId();
      if (tabId === null) {
        throw new Error('未找到已打开的 X 页面，请先打开 x.com');
      }
      const res = await callTab<TweetDetailContext>(tabId, { type: 'CS_EXTRACT' });
      if (!res.ok) throw new Error(res.error);
      setSnapshot(res.data);
      onToast(`已抓取 @${res.data.main.authorHandle} 的推文`);
      return res.data;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setStage('idle');
    }
  }, [onToast]);

  /* ---------------- 关注 ---------------- */

  const follow = useCallback(async (): Promise<FollowOutcome | null> => {
    setError(null);
    setStage('following');
    try {
      const tabId = await findXTabId();
      if (tabId === null) throw new Error('未找到 X 页面');
      const res = await callTab<{ outcome: FollowOutcome }>(tabId, { type: 'CS_FOLLOW' });
      if (!res.ok) throw new Error(res.error);

      switch (res.data.outcome) {
        case 'followed':
          onToast('已关注该博主');
          break;
        case 'already':
          onToast('该博主已关注过，跳过');
          break;
        case 'unavailable':
          onToast('当前页面没有关注入口', 'danger');
          break;
        default:
          onToast('关注失败，可能被风控拦截', 'danger');
      }
      return res.data.outcome;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setStage('idle');
    }
  }, [onToast]);

  /* ---------------- 填入 / 发送 ---------------- */

  const fillAndSubmit = useCallback(
    async (text: string, submit: boolean) => {
      const tabId = await findXTabId();
      if (tabId === null) throw new Error('未找到 X 页面');

      const fillRes = await callTab<{ filled: boolean }>(tabId, { type: 'CS_FILL', text });
      if (!fillRes.ok) throw new Error(fillRes.error);

      if (submit) {
        await new Promise((r) => setTimeout(r, 1500));
        const subRes = await callTab<{ submitted: boolean }>(tabId, { type: 'CS_SUBMIT' });
        if (!subRes.ok) throw new Error(`已填入但发送失败：${subRes.error}。请手动点击发送。`);
        onToast('评论已发送');
      } else {
        onToast('已填入评论框，请确认后手动发送');
      }
    },
    [onToast],
  );

  /* ---------------- 生成 ---------------- */

  const generate = useCallback(
    async (ctx: TweetDetailContext | null): Promise<boolean> => {
      const target = ctx ?? snapshot;
      if (!target) return false;
      setError(null);
      setStage('generating');
      try {
        const res = await callBackground<{ text: string }>({
          type: 'LLM_GENERATE',
          snapshot: target.main,
          // 卡片上显示的「上文 N 条（作为生成上下文）」到这里才真的进入 prompt
          ancestors: target.ancestors,
        });
        setDraft(res.text);

        // 生成后自动发送
        if (settings.prompt.autoSend) {
          await new Promise((r) => setTimeout(r, settings.prompt.autoSendDelayMs));
          await fillAndSubmit(res.text, true);
        } else {
          onToast('评论已生成');
        }
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setStage('idle');
      }
    },
    [snapshot, settings.prompt.autoSend, settings.prompt.autoSendDelayMs, onToast, fillAndSubmit],
  );

  /* ---------------- 自动链 ---------------- */
  /*
   * autoExtract → autoGenerate → autoFollow，逐级以前一步成功为前提。
   * 用 URL 作去重键：同一详情页只跑一次，重新进入页面才会再触发。
   *
   * 依赖只取具体布尔值（而非 auto 对象）：settings 每次更新都会重建
   * manualAuto 对象引用，直接依赖对象会让 effect 反复重跑。
   */
  const { autoExtract, autoGenerate, autoFollow } = settings.manualAuto;

  useEffect(() => {
    if (!tabUrl || !isTweetDetailUrl(tabUrl)) return;
    if (autoHandledRef.current === tabUrl) return;
    if (autoBusyRef.current) return;
    // 三个开关全关时不占用"已处理"标记，便于用户之后手动点按钮
    if (!autoExtract && !autoGenerate && !autoFollow) return;

    autoHandledRef.current = tabUrl;
    autoBusyRef.current = true;

    void (async () => {
      try {
        // 1) 抓取：三个动作都依赖它
        const ctx = await extract();
        if (!ctx) return;

        // 2) 关注：独立于评论，先做以免后续步骤改变页面结构
        if (autoFollow) {
          await follow();
        }

        // 3) 生成评论
        if (autoGenerate) {
          await generate(ctx);
        }
      } finally {
        autoBusyRef.current = false;
      }
    })();
  }, [tabUrl, autoExtract, autoGenerate, autoFollow, extract, generate, follow]);

  const handleFill = useCallback(async () => {
    if (!draft.trim()) return;
    setError(null);
    setStage('filling');
    try {
      await fillAndSubmit(draft, false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStage('idle');
    }
  }, [draft, fillAndSubmit]);

  const handleSubmit = useCallback(async () => {
    if (!draft.trim()) return;
    setError(null);
    setStage('submitting');
    try {
      await fillAndSubmit(draft, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStage('idle');
    }
  }, [draft, fillAndSubmit]);

  /* ---------------- 渲染 ---------------- */

  const recentLogs = logs.slice(-6);

  return (
    <div className="space-y-3 p-3">
      {/* 页面状态 */}
      <Card>
        <SectionTitle
          icon={<Sparkles size={14} />}
          title="手动模式"
          hint="在推文详情页抓取内容、生成评论并一键填入"
          action={
            <Badge tone={onDetailPage ? 'ok' : 'warn'}>
              <span
                className={cn('h-1.5 w-1.5 rounded-full', onDetailPage ? 'bg-ok' : 'bg-warn')}
              />
              {onDetailPage ? '详情页' : '非详情页'}
            </Badge>
          }
        />

        {!onDetailPage && (
          <p className="mb-2.5 rounded-lg bg-warn/10 px-2.5 py-2 text-[11px] leading-snug text-warn">
            请先打开任意推文详情页（URL 形如 <span className="font-mono">x.com/用户/status/数字</span>），再点击下方按钮。
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            className="xa-btn-primary flex-1"
            onClick={() => void extract()}
            disabled={busy || !onDetailPage}
          >
            {stage === 'extracting' ? <Spinner /> : null}
            {stage === 'extracting' ? '抓取中…' : '获取内容'}
          </button>
          <button
            type="button"
            className="xa-btn-ghost"
            onClick={() => {
              setSnapshot(null);
              setDraft('');
              setError(null);
            }}
            disabled={busy || (!snapshot && !draft)}
          >
            清空
          </button>
        </div>

        {/* 自动化开关：进入详情页后按勾选项自动执行 */}
        <div className="mt-2.5 space-y-1.5 rounded-lg bg-ink-900/30 p-2.5 dark:bg-black/20">
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold text-ink-400">
            <Sparkles size={11} />
            打开 status 页后自动执行
          </div>

          <AutoToggle
            label="自动获取内容"
            hint="检测到推文详情页时自动抓取"
            checked={auto.autoExtract}
            onToggle={(v) => void update({ manualAuto: { autoExtract: v } })}
          />
          <AutoToggle
            label="自动生成评论"
            hint="抓到内容后自动请求 AI 生成（依赖抓取）"
            checked={auto.autoGenerate}
            onToggle={(v) => void update({ manualAuto: { autoGenerate: v } })}
          />
          <AutoToggle
            label="自动关注博主"
            hint="对当前页面的推文作者自动点关注"
            checked={auto.autoFollow}
            onToggle={(v) => void update({ manualAuto: { autoFollow: v } })}
          />
        </div>
      </Card>

      {/* 抓取结果 */}
      {snapshot && (
        <Card className="animate-fade-up">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold">{snapshot.main.authorName}</div>
              <div className="truncate font-mono text-[10.5px] text-ink-400">@{snapshot.main.authorHandle}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              {snapshot.main.isRetweet && <Badge>转推</Badge>}
              {snapshot.main.isReply && <Badge>回复</Badge>}
              {snapshot.main.following === true && <Badge tone="brand">已关注</Badge>}
            </div>
          </div>

          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-ink-900/40 p-2.5 font-sans text-[11.5px] leading-relaxed dark:bg-black/30">
            {snapshot.main.text || '（未抓到正文）'}
          </pre>

          {snapshot.ancestors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-brand">
                上文 {snapshot.ancestors.length} 条（作为生成上下文）
              </summary>
              <div className="mt-1.5 space-y-1.5">
                {snapshot.ancestors.map((a) => (
                  <p key={a.fingerprint} className="rounded bg-ink-900/30 p-2 text-[11px] text-ink-300 dark:bg-black/20">
                    <span className="font-mono text-[10px] text-ink-400">@{a.authorHandle}：</span>
                    {a.text.slice(0, 120)}
                  </p>
                ))}
              </div>
            </details>
          )}
        </Card>
      )}

      {/* 语气选择 */}
      <Card>
        <SectionTitle title="回复语气" hint={activePersona?.body} />
        <div className="flex flex-wrap gap-1.5">
          {settings.prompt.personas.map((p) => (
            <button
              key={p.id}
              type="button"
              className="xa-chip"
              data-active={p.id === settings.prompt.activePersonaId}
              title={p.body}
              onClick={() => void update({ prompt: { activePersonaId: p.id } })}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="xa-divider" />

        <div className="flex gap-2">
          <button
            type="button"
            className="xa-btn-primary flex-1"
            onClick={() => void generate(null)}
            disabled={busy || !snapshot}
          >
            {stage === 'generating' ? <Spinner /> : <Sparkles size={13} />}
            {stage === 'generating' ? 'AI 正在生成…' : '生成评论'}
          </button>
          <button
            type="button"
            className="xa-btn-ghost"
            onClick={() => void follow()}
            disabled={busy || !onDetailPage}
            title="关注当前页面的推文作者"
          >
            {stage === 'following' ? <Spinner /> : <UserPlus size={13} />}
            关注博主
          </button>
        </div>
      </Card>

      {/* 草稿编辑与发送 */}
      {(draft || stage === 'generating') && (
        <Card className="animate-fade-up">
          <SectionTitle
            title="评论草稿"
            hint="可直接编辑，字符数实时校验"
            action={
              <span
                className={cn(
                  'font-mono text-[11px] tabular-nums',
                  draft.length > settings.prompt.maxChars ? 'text-danger' : 'text-ink-400',
                )}
              >
                {draft.length}/{settings.prompt.maxChars}
              </span>
            }
          />
          <textarea
            rows={4}
            className="xa-input resize-y leading-relaxed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="生成的评论会出现在这里"
          />

          <div className="mt-2.5 flex gap-2">
            <button type="button" className="xa-btn-ghost flex-1" onClick={handleFill} disabled={busy || !draft.trim()}>
              {stage === 'filling' ? <Spinner /> : null}
              {stage === 'filling' ? '填入中…' : '仅填入'}
            </button>
            <button
              type="button"
              className="xa-btn-primary flex-1"
              onClick={handleSubmit}
              disabled={busy || !draft.trim()}
            >
              {stage === 'submitting' ? <Spinner /> : <Send size={13} />}
              {stage === 'submitting' ? '填入中…' : '填入并发送'}
            </button>
          </div>

          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11.5px]">
            <input
              type="checkbox"
              className="accent-brand"
              checked={settings.prompt.autoSend}
              onChange={(e) => void update({ prompt: { autoSend: e.target.checked } })}
            />
            <span>
              生成后自动发送
              <span className="ml-1 text-ink-400">（延时 {settings.prompt.autoSendDelayMs}ms 后点击发送按钮）</span>
            </span>
          </label>
        </Card>
      )}

      {/* 错误 */}
      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-[11.5px] leading-snug text-danger">
          {error}
        </div>
      )}

      {/* 最近日志 */}
      <Card>
        <SectionTitle
          icon={<Terminal size={13} />}
          title="最近动态"
          action={
            <span className="font-mono text-[10px] text-ink-400">{recentLogs.length} 条</span>
          }
        />
        {recentLogs.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-ink-400">暂无日志</p>
        ) : (
          <ul className="space-y-1">
            {recentLogs.map((l) => (
              <li key={l.id} className="flex gap-2 font-mono text-[10.5px] leading-snug">
                <span className="shrink-0 text-ink-500">{formatClock(l.ts)}</span>
                <span className={cn('shrink-0 font-semibold', levelColor(l.level))}>{l.level}</span>
                <span className="min-w-0 break-words text-ink-300">{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** 自动化开关：一行一个复选框 + 说明 */
function AutoToggle({
  label,
  hint,
  checked,
  onToggle,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 transition-colors hover:bg-ink-900/40 dark:hover:bg-white/5">
      <input
        type="checkbox"
        className="mt-0.5 shrink-0 accent-brand"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className="min-w-0 leading-snug">
        <span className={cn('text-[11.5px]', checked ? 'font-semibold text-ink-100' : 'text-ink-300')}>{label}</span>
        <span className="ml-1 text-[10px] text-ink-500">{hint}</span>
      </span>
    </label>
  );
}

function levelColor(level: LogEntry['level']): string {
  switch (level) {
    case 'ERROR':
      return 'text-danger';
    case 'WARNING':
      return 'text-warn';
    case 'ACTION':
      return 'text-brand';
    case 'DONE':
      return 'text-ok';
    case 'WAIT':
      return 'text-ink-400';
    default:
      return 'text-ink-300';
  }
}
