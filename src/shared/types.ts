/**
 * 全局共享类型定义：消息协议、配置、运行态。
 * 所有跨上下文（sidepanel / service worker / content script）通信都必须走这里定义的联合类型。
 */

/* ------------------------------------------------------------------ */
/* 基础领域模型                                                        */
/* ------------------------------------------------------------------ */

/** 推文抓取结果 */
export interface TweetSnapshot {
  /** 推文正文（已做换行与零宽字符清洗） */
  text: string;
  /** 作者显示名，例如 "Elon Musk" */
  authorName: string;
  /** 作者 handle，不含 @，例如 "elonmusk" */
  authorHandle: string;
  /** 是否已关注该作者（若无法判定则为 null） */
  following: boolean | null;
  /** 详情页永久链接；时间线抓取时可能为空 */
  url: string | null;
  /** 抓取时间戳（ms） */
  capturedAt: number;
  /** 是否为转推内容 */
  isRetweet: boolean;
  /** 是否为回复 */
  isReply: boolean;
  /** 判断去重用的稳定指纹 */
  fingerprint: string;
}

/** 详情页整页上下文（详情页抓取时额外带回上文推文） */
export interface TweetDetailContext {
  main: TweetSnapshot;
  /** 详情页中位于主推文上方的上下文推文（一般是被回复的那条） */
  ancestors: TweetSnapshot[];
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

export type LlmProtocol = 'openai' | 'anthropic';

export interface LlmConfig {
  protocol: LlmProtocol;
  /** 例如 https://api.openai.com/v1 或 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 0 ~ 2 */
  temperature: number;
  /** 单次请求超时（ms） */
  timeoutMs: number;
  /** Anthropic 协议的版本头 */
  anthropicVersion: string;
}

export interface Persona {
  id: string;
  /** 展示名，如「犀利洞见」 */
  label: string;
  /** 一句话说明 */
  hint: string;
  /** 注入到 User Prompt 的人设正文 */
  body: string;
}

export interface PromptConfig {
  /** 支持 {tweet_text} {tweet_author} {tweet_handle} {persona} {max_chars} {lang} */
  systemTemplate: string;
  userTemplate: string;
  /** 生成内容的字符上限，作为 prompt 约束与前端校验 */
  maxChars: number;
  /** 输出语言：auto = 跟随推文语言 */
  lang: 'auto' | 'zh' | 'en';
  /** 语气预设集合 */
  personas: Persona[];
  /** 当前选中的 persona id（仅手动模式使用） */
  activePersonaId: string;
  /** 生成后是否自动点击发送 */
  autoSend: boolean;
  /** 自动发送前的人类停留延时（ms） */
  autoSendDelayMs: number;
}

/**
 * 手动模式的自动化开关。
 *
 * 三个开关串成一条可断链的流水线：
 *   autoExtract（进入 status 页即抓取）
 *     → autoGenerate（抓到内容即生成评论）
 *       → autoFollow（对当前博主自动关注）
 *
 * 后两步以前一步成功为前提，但彼此独立开关 —— 例如可以只抓取 + 关注，
 * 不生成评论。
 */
export interface ManualAutoConfig {
  /** 打开推文详情页（/status/）时自动抓取内容 */
  autoExtract: boolean;
  /** 抓取到内容后自动请求 AI 生成评论 */
  autoGenerate: boolean;
  /** 抓取后自动关注该推文作者 */
  autoFollow: boolean;
  /** 自动关注时若已关注则跳过（关闭则不做任何处理） */
  followSkipIfFollowing: boolean;
}

export interface AutomationConfig {
  /** 总开关 */
  enabled: boolean;
  /** 每轮点赞目标数量 */
  likeQuotaPerRound: number;
  /** 每轮评论目标数量 */
  commentQuotaPerRound: number;
  /** 每轮关注目标数量 */
  followQuotaPerRound: number;
  /** 在选中推文上执行点赞的概率 0~1 */
  likeProbability: number;
  /** 关注作者的独立概率 0~1 */
  followProbability: number;
  /** 单轮最多浏览多少条推文后强制结束（防止死循环） */
  maxTweetsPerRound: number;
  /** 单个动作之间的随机静止区间 [min, max] 秒 */
  actionDelaySec: [number, number];
  /** 滚动行为之间的随机区间 [min, max] 秒 */
  scrollDelaySec: [number, number];
  /** 一轮结束后的休眠区间 [min, max] 分钟 */
  roundSleepMin: [number, number];
  /** 是否自动发送生成的评论；false = 只填入草稿等待人工确认 */
  autoSubmitComment: boolean;
  /** 评论前的最短思考停留（ms），模拟阅读 */
  readDwellMs: [number, number];
}

/** 侧边栏主题 */
export type ThemeMode = 'dark' | 'light' | 'system';

/**
 * 作者主页推广卡片。
 *
 * 显示在侧边栏顶栏下方，提供一个「关注」快捷按钮：
 * 点击后打开作者主页并自动关注；一旦确认关注成功（或已关注），
 * 卡片永久隐藏（`followed` 落盘，不再显示）。
 *
 * 卡片底部另有一行小字，点击后仅在**本次会话内**隐藏（纯 UI state，不落盘，
 * 重开侧边栏即恢复）；只有点「关注」成功才会永久隐藏（`followed` 落盘）。
 * 作者信息同时常驻在「设置」页最底部（不带小字），仅在 `followed` 为真时一起消失。
 */
export interface ProfileCardConfig {
  /** 是否启用该卡片 */
  enabled: boolean;
  /** 作者 handle（不含 @），例如 "4ndee" */
  handle: string;
  /** 卡片上展示的显示名；为空时回落为 @handle */
  displayName: string;
  /** 一行简介文案 */
  tagline: string;
  /** 是否已经关注过（成功关注后置为 true，卡片随之永久隐藏） */
  followed: boolean;
}

export interface AppSettings {
  llm: LlmConfig;
  prompt: PromptConfig;
  automation: AutomationConfig;
  manualAuto: ManualAutoConfig;
  profileCard: ProfileCardConfig;
  theme: ThemeMode;
  /** 是否已经通过首次配置预检 */
  onboarded: boolean;
}

/* ------------------------------------------------------------------ */
/* 运行态                                                              */
/* ------------------------------------------------------------------ */

export type AutomationPhase =
  | 'idle'
  | 'navigating'
  | 'scrolling'
  | 'picking'
  | 'liking'
  | 'commenting'
  | 'following'
  | 'cooling'
  | 'stopped'
  | 'error';

export interface RoundCounters {
  likes: number;
  comments: number;
  follows: number;
  /** 已浏览推文数 */
  scanned: number;
  /** 指纹去重集合（保留最近 400 条） */
  seen: string[];
}

export interface AutomationRuntime {
  phase: AutomationPhase;
  round: number;
  roundStartedAt: number | null;
  /** 下一轮唤醒时间戳（ms），用于侧边栏倒计时 */
  nextRoundAt: number | null;
  counters: RoundCounters;
  lastError: string | null;
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

export type LogLevel = 'INFO' | 'ACTION' | 'WAIT' | 'WARNING' | 'ERROR' | 'DONE';

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  /** 来源上下文，便于排查 */
  scope: 'SW' | 'UI' | 'DOM';
  message: string;
}

/* ------------------------------------------------------------------ */
/* 消息协议                                                            */
/* ------------------------------------------------------------------ */

/** UI -> Content Script 的指令 */
export interface CsPingMsg {
  type: 'CS_PING';
}
export interface CsExtractMsg {
  type: 'CS_EXTRACT';
}
export interface CsFillMsg {
  type: 'CS_FILL';
  text: string;
}
export interface CsSubmitMsg {
  type: 'CS_SUBMIT';
}
/** 关注当前页面的推文作者 */
export interface CsFollowMsg {
  type: 'CS_FOLLOW';
}
/**
 * 关注当前页面所属的「作者本人主页」。
 *
 * 与 CS_FOLLOW 的区别：CS_FOLLOW 走的是详情页主推文作者，
 * 而本指令假定当前页面就是目标作者的主页（URL 形如 x.com/handle），
 * 直接定位个人资料区的关注按钮，不依赖推文块。
 */
export interface CsFollowProfileMsg {
  type: 'CS_FOLLOW_PROFILE';
  /** 目标 handle（不含 @），用于校验页面确实是该用户主页 */
  handle: string;
}
export interface CsHumanDelayMsg {
  type: 'CS_HUMAN_DELAY';
  minMs: number;
  maxMs: number;
}
export interface CsSelfTestMsg {
  type: 'CS_SELFTEST';
}

export type ToContentMessage =
  | CsPingMsg
  | CsExtractMsg
  | CsFillMsg
  | CsSubmitMsg
  | CsFollowMsg
  | CsFollowProfileMsg
  | CsHumanDelayMsg
  | CsSelfTestMsg;

/** CS_FOLLOW 的结果 */
export type FollowOutcome = 'followed' | 'already' | 'unavailable' | 'failed';

/* --- CS -> Background：自动化过程中的原子步骤请求 --- */

export interface SwLogMsg {
  type: 'SW_LOG';
  level: LogLevel;
  message: string;
  scope?: LogEntry['scope'];
}

export interface SwNavigateMsg {
  type: 'SW_NAVIGATE';
  url: string;
}
export interface SwGetTabMsg {
  type: 'SW_GET_TAB';
}
export interface SwSleepMsg {
  type: 'SW_SLEEP';
  minMs: number;
  maxMs: number;
}
export interface SwToContentMsg {
  type: 'SW_TO_CONTENT';
  /** 任务型 content script 所在标签页 */
  tabId: number;
  payload: ToContentMessage;
}

export type ToBackgroundMessage = SwLogMsg | SwNavigateMsg | SwGetTabMsg | SwSleepMsg | SwToContentMsg;

/* --- UI <-> Background 控制面 --- */
export interface UiStartAutoMsg {
  type: 'AUTO_START';
}
export interface UiStopAutoMsg {
  type: 'AUTO_STOP';
  reason?: string;
}
export interface UiGetRuntimeMsg {
  type: 'AUTO_GET_RUNTIME';
}
export interface UiTestLlmMsg {
  type: 'LLM_TEST';
}
export interface UiGenerateMsg {
  type: 'LLM_GENERATE';
  snapshot: TweetSnapshot;
}
export interface UiClearLogsMsg {
  type: 'LOGS_CLEAR';
}

/**
 * 侧边栏「作者主页卡片」的关注请求。
 *
 * 逻辑放在 SW 而非 UI：需要「查/建标签页 → 等页面就绪 → 确保 content script 注入
 * → 下发关注指令」这套跨上下文编排，UI 只关心最终结果。
 */
export interface UiProfileFollowMsg {
  type: 'PROFILE_FOLLOW';
  /** 目标 handle（不含 @） */
  handle: string;
}

/** 作者主页关注的结果 */
export type ProfileFollowOutcome = FollowOutcome;

/** side panel 经 SW 出站发 HTTP，规避文档级同源策略 */
export interface UiHttpFetchMsg {
  type: 'LLM_HTTP_FETCH';
  req: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  };
}

export type ToBackgroundControlMessage =
  | UiStartAutoMsg
  | UiStopAutoMsg
  | UiGetRuntimeMsg
  | UiTestLlmMsg
  | UiGenerateMsg
  | UiClearLogsMsg
  | UiHttpFetchMsg
  | UiProfileFollowMsg;

export type AnyMessage = ToContentMessage | ToBackgroundMessage | ToBackgroundControlMessage;

/* ------------------------------------------------------------------ */
/* 统一响应包装                                                        */
/* ------------------------------------------------------------------ */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface SelfTestReport {
  tweetArticle: { found: boolean; count: number; selector: string };
  tweetText: { found: boolean; count: number; selector: string };
  userName: { found: boolean; count: number; selector: string };
  editor: { found: boolean; count: number; selector: string };
  replyButton: { found: boolean; count: number; selector: string };
  likeButton: { found: boolean; count: number; selector: string };
  followButton: { found: boolean; count: number; selector: string };
  url: string;
  checkedAt: number;
}
