/**
 * 个人主页关注的「纯逻辑」部分：URL 判定与按钮挑选。
 *
 * 单独抽出成模块，便于在无 DOM 环境下做单元验证 ——
 * dom-actions.ts 里真正的点击/等待逻辑仍复用这里，不做平行实现。
 */

import { X_SELECTORS } from '../shared/constants';

/** X 的保留路径段，不能当作「某个用户的主页」 */
const RESERVED_FIRST_SEGMENT = /^(home|explore|notifications|messages|settings|search|compose|i)$/;

/**
 * 给定页面路径是否为 targetHandle 的个人主页。
 *
 * 主页 URL 形如 `x.com/<handle>`。必须排除保留路径段，否则
 * `x.com/home` 会被误判成「名叫 home 的主页」（与 isTweetDetailUrl 同一约束）。
 */
export function isProfilePathForPath(pathname: string, handle: string): boolean {
  const seg = pathname.split('/').filter(Boolean)[0] ?? '';
  if (!seg || RESERVED_FIRST_SEGMENT.test(seg)) return false;
  return seg.toLowerCase() === handle.replace(/^@/, '').trim().toLowerCase();
}

/** 可见性判定最小依赖：宽高 > 0 */
export interface SizedElement {
  getBoundingClientRect(): { width: number; height: number };
}

/**
 * 从候选按钮中挑出「资料区」那个。
 *
 * 主页上关注入口可能不止一个（侧边推荐栏、推文卡片里的迷你按钮），
 * 用启发式收敛：取可见候选中宽度最大的 —— 资料区按钮通常比迷你按钮宽。
 */
export function pickWidestVisible<T extends SizedElement>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.slice().sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
}

/** 收集作用域内可见的 follow / unfollow 按钮 */
export function collectProfileButtons(scope: ParentNode, kind: 'follow' | 'unfollow'): HTMLElement[] {
  const sel = kind === 'follow' ? '[data-testid$="-follow"]' : '[data-testid$="-unfollow"]';
  return Array.from(scope.querySelectorAll<HTMLElement>(sel)).filter((el) => {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  });
}

export function pickProfileButton(scope: ParentNode, kind: 'follow' | 'unfollow'): HTMLElement | null {
  return pickWidestVisible(collectProfileButtons(scope, kind));
}

/** 供 dom-actions 复用的选择器出口，避免两处各自硬编码 */
export { X_SELECTORS };
