/**
 * 作者主页推广卡片。
 *
 * 位置（两种用法，共用同一组件）：
 *  - 顶部卡片：顶栏（标题 + Tab）下方、内容区之上的独立卡片，`showDismiss` 为 true，
 *    底部多一行小字；
 *  - 设置页底部卡片：常驻在「设置」页最下方，不带小字（`showDismiss` 为 false）。
 *
 * 行为：
 *  - 展示作者展示名 / @handle / 一行简介，以及一个「关注」快捷按钮；
 *  - 点「关注」→ 交给 service worker 打开作者主页并自动关注；
 *    结果为 followed / already 时即视为「已关注」，卡片立即消失，
 *    并把 profileCard.followed 落盘 —— 这是唯一会「永久」生效的隐藏原因，
 *    之后侧边栏与设置页都不再渲染；
 *    结果为 unavailable / failed 时保留卡片并给出提示，可重试；
 *  - 点底部小字 → 仅**本次会话内**隐藏（纯 UI state，不落盘）。
 *    关闭侧边栏再打开时卡片会重新出现。这是刻意的：小字只是「本次不看」，
 *    不代表用户不想再看到作者。
 *
 * 消失逻辑刻意放在 UI 层（而非仅靠 storage 派生）：点击成功这一刻用户
 * 应该立刻看到反馈，不必等 storage.onChanged 回流。
 */

import { useCallback, useState } from 'react';
import { Check, ExternalLink, UserPlus, X } from 'lucide-react';
import type { AppSettings, FollowOutcome, ProfileCardConfig } from '../../shared/types';
import type { DeepPartial } from '../../shared/storage';
import { cn } from '../../shared/utils';
import { profileUrl } from '../../shared/constants';
import { callBackground } from '../hooks/useStorage';
import { Spinner } from './ui';

interface Props {
  profileCard: ProfileCardConfig;
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  onToast: (msg: string, tone?: 'ok' | 'danger') => void;
  /**
   * 是否在卡片底部渲染「关闭」小字。
   *  - true（默认）：顶部卡片，点击小字仅本次会话内隐藏（不落盘，重开恢复）；
   *  - false：设置页底部卡片，不渲染小字。
   */
  showDismiss?: boolean;
}

type Phase = 'idle' | 'following' | 'done';

export default function ProfileCard({ profileCard, update, onToast, showDismiss = true }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  /** 本次会话内已确认关注：立即隐藏，不等 storage 回流 */
  const [dismissed, setDismissed] = useState(false);
  /** 本次会话内已点小字关闭：仅本地隐藏，不落盘（重开侧边栏即恢复） */
  const [closed, setClosed] = useState(false);

  const handle = profileCard.handle.replace(/^@/, '').trim();
  const url = profileUrl(handle);

  /**
   * 点击底部小字：仅本次会话内隐藏。
   * 刻意**不写 storage** —— 用户要求「下次打开依旧出现」。
   * 真正永久的隐藏只有一条路径：点「关注」成功（下面 follow()）。
   */
  const closeCard = useCallback(() => {
    setClosed(true);
  }, []);

  const follow = useCallback(async () => {
    if (!handle) {
      onToast('未配置作者 handle', 'danger');
      return;
    }
    setPhase('following');
    try {
      const res = await callBackground<{ outcome: FollowOutcome }>({
        type: 'PROFILE_FOLLOW',
        handle,
      });

      switch (res.outcome) {
        case 'followed':
          onToast(`已关注 @${handle}`);
          break;
        case 'already':
          onToast('已经关注过了');
          break;
        case 'unavailable':
          onToast('未找到关注入口，请确认已登录 X', 'danger');
          setPhase('idle');
          return;
        default:
          onToast('关注失败，可能被风控拦截', 'danger');
          setPhase('idle');
          return;
      }

      // followed / already → 视为已关注：立即隐藏 + 落盘
      setPhase('done');
      setDismissed(true);
      await update({ profileCard: { followed: true } }).catch(() => undefined);
    } catch (err) {
      onToast((err as Error).message, 'danger');
      setPhase('idle');
    }
  }, [handle, onToast, update]);

  // 已隐藏（本地即时 / 持久化任一为真）则完全不渲染。
  // 注意：`dismissed` 是纯本地 state，只在本会话内生效；
  // 持久化的隐藏原因只有 `followed`（点关注成功）。
  if (dismissed || closed || profileCard.followed || !profileCard.enabled || !handle) {
    return null;
  }

  const displayName = profileCard.displayName.trim() || `@${handle}`;
  const busy = phase === 'following';

  return (
    <section className="mx-3 mt-3 animate-fade-up xa-card">
      <div className="flex items-center gap-2.5">
        {/* 头像：public/profile-avatar.jpg 经 Vite 拷到产物根，
            用扩展根绝对路径引用 —— 侧边栏 HTML 位于 dist/src/sidepanel/，
            相对路径会解析到错误目录。 */}
        <img
          src="/profile-avatar.jpg"
          alt={displayName}
          className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-ink-600/40"
          draggable={false}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[12.5px] font-semibold leading-tight">{displayName}</span>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-ink-400 transition-colors hover:text-brand"
              title={`打开 ${url}`}
              aria-label={`打开 ${displayName} 的 X 主页`}
            >
              <ExternalLink size={11} />
            </a>
          </div>
          <p className="truncate text-[10.5px] leading-snug text-ink-400">
            {profileCard.tagline || `@${handle}`}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void follow()}
          disabled={busy || phase === 'done'}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold transition-all',
            phase === 'done'
              ? 'bg-ok/15 text-ok'
              : 'bg-brand text-white hover:bg-brand-dim active:scale-[0.97] disabled:opacity-60',
          )}
          title={`关注 @${handle}`}
        >
          {busy ? <Spinner size={12} /> : phase === 'done' ? <Check size={12} /> : <UserPlus size={12} />}
          {busy ? '关注中…' : phase === 'done' ? '已关注' : '关注'}
        </button>
      </div>

      {/* 底部小字：点击仅本次会话内隐藏（不落盘，重开侧边栏恢复） */}
      {showDismiss && (
        <button
          type="button"
          onClick={closeCard}
          className="mt-2 flex w-full items-center justify-center gap-1 border-t border-ink-600/25 pt-1.5 text-[10px] leading-snug text-ink-400 transition-colors hover:text-ink-200"
          title="本次关闭；点右侧「关注」后不再显示"
        >
          <X size={10} />
          点击关闭（点右侧关注作者后不再显示）
        </button>
      )}
    </section>
  );
}
