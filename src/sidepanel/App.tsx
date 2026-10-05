import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, MousePointerClick, Power, Settings, Zap } from 'lucide-react';
import type { AppSettings } from '../shared/types';
import { cn } from '../shared/utils';
import { callBackground, useLogs, useRuntime, useSettings } from './hooks/useStorage';
import { Spinner, Toast } from './components/ui';
import ManualMode from './components/ManualMode';
import AutoMode from './components/AutoMode';
import SettingsModal from './components/SettingsModal';
import ProfileCard from './components/ProfileCard';

type Tab = 'manual' | 'auto' | 'settings';

export default function App() {
  const { settings, loading, update, replace } = useSettings();
  const { logs, clear: clearLogs } = useLogs();
  const { runtime } = useRuntime();
  const [tab, setTab] = useState<Tab>('manual');
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'danger' } | null>(null);

  const onToast = useCallback((msg: string, tone: 'ok' | 'danger' = 'ok') => {
    setToast({ msg, tone });
  }, []);

  /* 后台推送的日志（storage.onChanged 有节流，这是实时通道） */
  useEffect(() => {
    const handler = (msg: unknown) => {
      const m = msg as { type?: string; message?: string; level?: string };
      if (m?.type === 'LOG_PUSH' && m.level === 'ERROR' && m.message) {
        setToast({ msg: m.message, tone: 'danger' });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  /* 巡航中禁止误关：给出离开确认 */
  const autoRunning = !!runtime && !['idle', 'stopped', 'error'].includes(runtime.phase);

  const stopAutomation = useCallback(
    async (reason: string) => {
      try {
        await callBackground({ type: 'AUTO_STOP', reason });
      } catch {
        /* 制动失败时也要允许关闭 */
      }
    },
    [],
  );

  useEffect(() => {
    if (!autoRunning) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '自动巡航仍在运行，关闭侧边栏会中断巡航';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [autoRunning]);

  /* 紧急制动浮动按钮（全局可见） */
  const [stopping, setStopping] = useState(false);
  const emergencyStop = useCallback(async () => {
    setStopping(true);
    await stopAutomation('侧边栏紧急制动');
    onToast('已紧急制动，所有注入与循环已终止', 'ok');
    window.setTimeout(() => setStopping(false), 600);
  }, [stopAutomation, onToast]);

  const tabs = useMemo(
    () =>
      [
        { id: 'manual' as Tab, label: '手动', icon: <MousePointerClick size={14} /> },
        { id: 'auto' as Tab, label: '自动', icon: <Zap size={14} /> },
        { id: 'settings' as Tab, label: '设置', icon: <Settings size={14} /> },
      ] satisfies Array<{ id: Tab; label: string; icon: React.ReactNode }>,
    [],
  );

  if (loading || !settings) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-ink-400">
        <Spinner size={16} />
        <span className="text-[12px]">加载配置…</span>
      </div>
    );
  }

  const configBroken = !settings.llm.apiKey.trim();

  return (
    <div className="flex h-full min-h-screen flex-col">
      {/* 顶栏 */}
      <header
        className="sticky top-0 z-20 border-b backdrop-blur"
        style={{ borderColor: 'var(--xa-border)', background: 'color-mix(in srgb, var(--xa-bg) 88%, transparent)' }}
      >
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-white">
              <Activity size={13} />
            </span>
            <div>
              <h1 className="text-[12.5px] font-semibold leading-none">X Autopilot</h1>
              <p className="mt-0.5 text-[10px] leading-none text-ink-400">智能运营助手 · 本地运行</p>
            </div>
          </div>
          {autoRunning && (
            <span className="flex items-center gap-1.5 rounded-full bg-ok/15 px-2 py-1 text-[10px] font-medium text-ok">
              <span className="h-1.5 w-1.5 animate-pulse-ring rounded-full bg-ok" />
              巡航中
            </span>
          )}
        </div>

        {/* Tab 导航 */}
        <nav className="flex px-2 pb-2" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11.5px] font-medium transition-colors',
                tab === t.id ? 'bg-brand/12 text-brand' : 'text-ink-400 hover:text-ink-100',
              )}
            >
              {t.icon}
              {t.label}
              {t.id === 'settings' && configBroken && (
                <span className="absolute right-2 top-1 h-1.5 w-1.5 rounded-full bg-warn" aria-label="配置待完善" />
              )}
            </button>
          ))}
        </nav>
      </header>

      {/* 作者主页卡片：位于标题/Tab 下方，关注后自动隐藏 */}
      <ProfileCard profileCard={settings.profileCard} update={update} onToast={onToast} />

      {/* 首次使用引导 */}
      {configBroken && tab === 'manual' && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
          <div className="text-[11px] leading-snug">
            <p className="font-medium text-warn">尚未配置 API Key</p>
            <p className="mt-0.5 text-ink-300">
              生成评论功能需要模型接口。前往
              <button type="button" className="mx-0.5 font-medium text-brand underline" onClick={() => setTab('settings')}>
                设置 · 模型
              </button>
              填写后即可使用。
            </p>
          </div>
        </div>
      )}

      {/* 内容区 */}
      <main className="flex-1 overflow-y-auto pb-14" role="tabpanel">
        {tab === 'manual' && <ManualMode settings={settings} update={update} logs={logs} onToast={onToast} />}
        {tab === 'auto' && (
          <AutoMode
            settings={settings}
            update={update}
            runtime={runtime}
            logs={logs}
            onClearLogs={clearLogs}
            onToast={onToast}
          />
        )}
        {tab === 'settings' && (
          <SettingsModal settings={settings} update={update} replace={replace} onToast={onToast} />
        )}
      </main>

      {/* 全局紧急制动浮动按钮 */}
      {autoRunning && (
        <button
          type="button"
          onClick={emergencyStop}
          disabled={stopping}
          className={cn(
            'fixed bottom-3 right-3 z-40 flex h-11 w-11 items-center justify-center rounded-full',
            'bg-danger text-white shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:opacity-60',
          )}
          aria-label="紧急制动"
          title="紧急制动：立即终止所有自动化操作"
        >
          {stopping ? <Spinner size={16} /> : <Power size={17} />}
        </button>
      )}

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}

export type { AppSettings };
