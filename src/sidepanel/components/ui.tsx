/** 共用 UI 原子组件：保持面板代码聚焦在业务逻辑上 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../../shared/utils';

/* ------------------------------------------------------------------ */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('xa-card', className)}>{children}</section>;
}

export function SectionTitle({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-2.5 flex items-start justify-between gap-2">
      <div className="flex items-start gap-2">
        {icon && <span className="mt-0.5 text-brand">{icon}</span>}
        <div>
          <h2 className="text-[13px] font-semibold leading-tight">{title}</h2>
          {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-300 dark:text-ink-300">{hint}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}

/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="mb-3">
      <label className="xa-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[10.5px] leading-snug text-ink-400">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** 带防抖的文本输入，避免每次按键都写 storage */
export function TextInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  monospace,
  id,
  delay = 400,
  className,
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'number';
  monospace?: boolean;
  id?: string;
  delay?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    // 外部变化（如导入配置）时同步，但不打断正在输入的用户
    if (!focused.current) setLocal(value);
  }, [value]);

  const schedule = (next: string) => {
    setLocal(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(next), delay);
  };

  return (
    <input
      id={id}
      type={type}
      className={cn('xa-input', monospace && 'font-mono text-[11px]', className)}
      value={local}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (timer.current) window.clearTimeout(timer.current);
        if (local !== value) onCommit(local);
      }}
      onChange={(e) => schedule(e.target.value)}
      spellCheck={false}
      autoComplete="off"
    />
  );
}

/* ------------------------------------------------------------------ */

export function TextArea({
  value,
  onCommit,
  rows = 5,
  placeholder,
  monospace,
  delay = 500,
  className,
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  rows?: number;
  placeholder?: string;
  monospace?: boolean;
  delay?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  const schedule = (next: string) => {
    setLocal(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(next), delay);
  };

  return (
    <textarea
      rows={rows}
      className={cn('xa-input resize-y leading-relaxed', monospace && 'font-mono text-[11px]', className)}
      value={local}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (timer.current) window.clearTimeout(timer.current);
        if (local !== value) onCommit(local);
      }}
      onChange={(e) => schedule(e.target.value)}
      spellCheck={false}
    />
  );
}

/* ------------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12px] font-medium leading-tight">{label}</div>
        {hint && <p className="mt-0.5 text-[10.5px] leading-snug text-ink-400">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-45',
          checked ? 'bg-brand' : 'bg-ink-600',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function RangeSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-medium">{label}</span>
        <span className="font-mono text-[11px] text-brand">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-600 accent-brand"
      />
    </div>
  );
}

/** 区间滑块：两个手柄分别控制 [min, max] */
export function RangePair({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  unit,
}: {
  value: [number, number];
  onChange: (v: [number, number]) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  unit?: string;
}) {
  const [lo, hi] = value;
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-medium">{label}</span>
        <span className="font-mono text-[11px] text-brand">
          {lo}–{hi}
          {unit}
        </span>
      </div>
      <div className="space-y-1.5">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          aria-label={`${label} 下限`}
          onChange={(e) => onChange([Math.min(Number(e.target.value), hi), hi])}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-600 accent-brand"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          aria-label={`${label} 上限`}
          onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-600 accent-brand"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  hint,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
  hint?: string;
  id?: string;
}) {
  return (
    <div className="mb-3">
      <label className="xa-label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          className="xa-input cursor-pointer appearance-none pr-7"
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-400" />
      </div>
      {hint && <p className="mt-1 text-[10.5px] leading-snug text-ink-400">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-ink-600/60 text-ink-200',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    brand: 'bg-brand/15 text-brand',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Spinner({ size = 13 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin" />;
}

export function Toast({ message, onDone, tone = 'ok' }: { message: string; onDone: () => void; tone?: 'ok' | 'danger' }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(t);
  }, [message, onDone]);

  return (
    <div
      className={cn(
        'animate-fade-up fixed bottom-3 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-lg px-3 py-2 text-[11.5px] font-medium text-white shadow-lg',
        tone === 'ok' ? 'bg-ink-700' : 'bg-danger',
      )}
      role="status"
    >
      {tone === 'ok' ? <Check size={12} /> : <RefreshCw size={12} />}
      <span className="truncate">{message}</span>
    </div>
  );
}
