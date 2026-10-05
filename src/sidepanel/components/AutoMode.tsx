import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleDot,
  Heart,
  MessageSquare,
  Moon,
  Play,
  Power,
  Trash2,
  UserPlus,
} from 'lucide-react';
import type { AppSettings, AutomationRuntime, LogEntry } from '../../shared/types';
import type { DeepPartial } from '../../shared/storage';
import { cn, formatClock, humanDuration } from '../../shared/utils';
import { callBackground, useCountdown } from '../hooks/useStorage';
import { Badge, Card, RangePair, RangeSlider, SectionTitle, Spinner, Switch } from './ui';

interface Props {
  settings: AppSettings;
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  runtime: AutomationRuntime | null;
  logs: LogEntry[];
  onClearLogs: () => Promise<void>;
  onToast: (msg: string, tone?: 'ok' | 'danger') => void;
}

const PHASE_LABEL: Record<AutomationRuntime['phase'], string> = {
  idle: '待机',
  navigating: '导航中',
  scrolling: '浏览中',
  picking: '筛选推文',
  liking: '点赞中',
  commenting: '评论中',
  following: '关注中',
  cooling: '冷却中',
  stopped: '已停止',
  error: '异常',
};

export default function AutoMode({ settings, update, runtime, logs, onClearLogs, onToast }: Props) {
  const [busy, setBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  const a = settings.automation;
  const running = !!runtime && runtime.phase !== 'idle' && runtime.phase !== 'stopped';
  const cooling = runtime?.phase === 'cooling';
  const countdown = useCountdown(cooling ? runtime?.nextRoundAt ?? null : null);

  /* 日志自动滚到底部 */
  useEffect(() => {
    if (!autoScroll) return;
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      await callBackground({ type: 'AUTO_START' });
      onToast('自动巡航已启动');
    } catch (err) {
      onToast((err as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  }, [onToast]);

  const stop = useCallback(
    async (reason?: string) => {
      setBusy(true);
      try {
        await callBackground({ type: 'AUTO_STOP', reason });
        onToast('已紧急制动');
      } catch (err) {
        onToast((err as Error).message, 'danger');
      } finally {
        setBusy(false);
      }
    },
    [onToast],
  );

  /** 配额进度条数据 */
  const quotas = useMemo(
    () => [
      { key: 'likes', label: '点赞', icon: <Heart size={11} />, done: runtime?.counters.likes ?? 0, total: a.likeQuotaPerRound, tone: 'text-danger' },
      { key: 'comments', label: '评论', icon: <MessageSquare size={11} />, done: runtime?.counters.comments ?? 0, total: a.commentQuotaPerRound, tone: 'text-brand' },
      { key: 'follows', label: '关注', icon: <UserPlus size={11} />, done: runtime?.counters.follows ?? 0, total: a.followQuotaPerRound, tone: 'text-ok' },
    ],
    [runtime?.counters, a.likeQuotaPerRound, a.commentQuotaPerRound, a.followQuotaPerRound],
  );

  const set = (patch: DeepPartial<AppSettings['automation']>) => void update({ automation: patch });

  return (
    <div className="space-y-3 p-3">
      {/* 控制台头部 */}
      <Card>
        <SectionTitle
          icon={<Activity size={14} />}
          title="自动巡航"
          hint="按配额自动浏览、点赞、评论与关注"
          action={
            <Badge tone={running ? 'ok' : 'neutral'}>
              <span className={cn('h-1.5 w-1.5 rounded-full', running ? 'animate-pulse-ring bg-ok' : 'bg-ink-500')} />
              {runtime ? PHASE_LABEL[runtime.phase] : '待机'}
            </Badge>
          }
        />

        <div className="mb-2.5 grid grid-cols-3 gap-1.5">
          {quotas.map((q) => (
            <div key={q.key} className="rounded-lg border p-2" style={{ borderColor: 'var(--xa-border)' }}>
              <div className={cn('mb-1 flex items-center gap-1 text-[10.5px]', q.tone)}>
                {q.icon}
                <span className="text-ink-300">{q.label}</span>
              </div>
              <div className="font-mono text-[13px] font-semibold tabular-nums">
                {q.done}
                <span className="text-[10px] text-ink-400">/{q.total}</span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-ink-600/50">
                <div
                  className="h-full rounded-full bg-brand transition-all duration-500"
                  style={{ width: `${q.total > 0 ? Math.min(100, (q.done / q.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        {runtime && runtime.round > 0 && (
          <p className="mb-2 text-[11px] text-ink-400">
            第 <span className="font-mono text-ink-200">{runtime.round}</span> 轮
            {cooling && countdown > 0 && (
              <>
                {' · '}下次启动倒计时 <span className="font-mono text-brand">{humanDuration(countdown)}</span>
              </>
            )}
            {runtime.counters.scanned > 0 && (
              <>
                {' · '}已浏览 <span className="font-mono text-ink-200">{runtime.counters.scanned}</span> 条
              </>
            )}
          </p>
        )}

        {runtime?.lastError && (
          <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-danger/10 px-2.5 py-2 text-[11px] leading-snug text-danger">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{runtime.lastError}</span>
          </p>
        )}

        {running ? (
          <button type="button" className="xa-btn-danger w-full" onClick={() => void stop('用户手动停止')} disabled={busy}>
            {busy ? <Spinner /> : <Power size={14} />}
            紧急制动
          </button>
        ) : (
          <button type="button" className="xa-btn-primary w-full" onClick={start} disabled={busy}>
            {busy ? <Spinner /> : <Play size={14} />}
            启动自动巡航
          </button>
        )}

        <p className="mt-2 text-[10.5px] leading-snug text-ink-400">
          启动后会打开/切换到 x.com 首页时间线。请确保浏览器窗口可见——X 对后台标签页的渲染与滚动会做限制。
        </p>
      </Card>

      {/* 配额配置 */}
      <Card>
        <SectionTitle title="每轮配额" hint="达到配额后自动进入冷却" />
        <RangeSlider
          label="点赞"
          min={0}
          max={30}
          value={a.likeQuotaPerRound}
          onChange={(v) => set({ likeQuotaPerRound: v })}
          format={(v) => `${v} 条`}
        />
        <RangeSlider
          label="评论"
          min={0}
          max={15}
          value={a.commentQuotaPerRound}
          onChange={(v) => set({ commentQuotaPerRound: v })}
          format={(v) => `${v} 条`}
        />
        <RangeSlider
          label="关注"
          min={0}
          max={10}
          value={a.followQuotaPerRound}
          onChange={(v) => set({ followQuotaPerRound: v })}
          format={(v) => `${v} 人`}
        />
        <RangeSlider
          label="单轮浏览上限"
          min={3}
          max={40}
          value={a.maxTweetsPerRound}
          onChange={(v) => set({ maxTweetsPerRound: v })}
          format={(v) => `${v} 条`}
        />
      </Card>

      {/* 概率与节奏 */}
      <Card>
        <SectionTitle title="行为节奏" hint="数值越保守，触发风控的概率越低" />
        <RangeSlider
          label="点赞概率"
          min={0}
          max={100}
          step={5}
          value={Math.round(a.likeProbability * 100)}
          onChange={(v) => set({ likeProbability: v / 100 })}
          format={(v) => `${v}%`}
        />
        <RangeSlider
          label="关注概率"
          min={0}
          max={100}
          step={5}
          value={Math.round(a.followProbability * 100)}
          onChange={(v) => set({ followProbability: v / 100 })}
          format={(v) => `${v}%`}
        />
        <RangePair
          label="动作间隔"
          min={5}
          max={120}
          unit=" 秒"
          value={a.actionDelaySec}
          onChange={(v) => set({ actionDelaySec: v })}
        />
        <RangePair
          label="滚动间隔"
          min={2}
          max={60}
          unit=" 秒"
          value={a.scrollDelaySec}
          onChange={(v) => set({ scrollDelaySec: v })}
        />
        <RangePair
          label="冷却时长"
          min={1}
          max={180}
          unit=" 分钟"
          value={a.roundSleepMin}
          onChange={(v) => set({ roundSleepMin: v })}
        />
        <RangePair
          label="评论前阅读停留"
          min={1}
          max={60}
          unit=" 秒"
          value={[Math.round(a.readDwellMs[0] / 1000), Math.round(a.readDwellMs[1] / 1000)]}
          onChange={(v) => set({ readDwellMs: [v[0] * 1000, v[1] * 1000] })}
        />
        <div className="xa-divider" />
        <Switch
          label="自动提交评论"
          hint="关闭时只把评论填入草稿框，由你人工确认后发送（推荐首次使用时关闭）"
          checked={a.autoSubmitComment}
          onChange={(v) => set({ autoSubmitComment: v, enabled: v || a.enabled })}
        />
      </Card>

      {/* 实时日志终端 */}
      <Card className="!p-0">
        <div className="flex items-center justify-between px-3 pt-3">
          <SectionTitle icon={<CircleDot size={13} />} title="实时日志" hint={`${logs.length} 条`} />
        </div>

        <div className="flex items-center gap-1.5 px-3 pb-2">
          <button
            type="button"
            className="xa-chip"
            data-active={autoScroll}
            onClick={() => setAutoScroll((v) => !v)}
          >
            自动滚动
          </button>
          <button type="button" className="xa-chip" onClick={() => void onClearLogs()}>
            <Trash2 size={10} className="mr-1 inline" />
            清空
          </button>
        </div>

        <div
          ref={consoleRef}
          className="max-h-[340px] min-h-[160px] overflow-y-auto rounded-b-xl border-t px-3 py-2"
          style={{ borderColor: 'var(--xa-border)', background: 'rgba(0,0,0,0.22)' }}
        >
          {logs.length === 0 ? (
            <p className="py-8 text-center text-[11px] text-ink-400">等待运行…</p>
          ) : (
            <ul className="space-y-[3px]">
              {logs.map((l) => (
                <li key={l.id} className="flex gap-2 font-mono text-[10.5px] leading-snug">
                  <span className="shrink-0 text-ink-500">{formatClock(l.ts)}</span>
                  <span className={cn('shrink-0 w-[52px] font-semibold', levelColor(l.level))}>[{l.level}]</span>
                  <span className="min-w-0 break-words text-ink-200">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <p className="flex items-start gap-1.5 px-1 text-[10.5px] leading-snug text-ink-400">
        <Moon size={11} className="mt-0.5 shrink-0" />
        <span>
          自动化操作存在账号风险。建议先用保守参数（低配额 + 长间隔 + 关闭自动提交）观察若干轮，确认行为稳定后再逐步放开。
        </span>
      </p>
    </div>
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
