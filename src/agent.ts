import {
  groupEnd,
  kindLabels,
  moveGroupToBoundary,
  templates,
  toMarkdown,
  uid,
} from "./flow";
import type { Kind, Line, Resume, Settings, Template } from "./flow";
import { contentToLines } from "./importText";

export const AGENT_CONFIG_KEY = "diyjobresume.agent.v1";
export const AGENT_TURNS_KEY = "diyjobresume.agent.turns.v1";
// 每份简历各存一份对话，切换简历不会串台
export const turnsKey = (docId: string) => `${AGENT_TURNS_KEY}.${docId}`;
const NOTICE_KEY = "diyjobresume.agent.notice.v1";

export interface AgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}
export interface AgentTurn {
  role: "user" | "assistant";
  text: string;
  /** 助手这一轮实际应用的改动，回传给模型当记忆 */
  notes?: string[];
  /** 用户没有接受这一轮方案 */
  rejected?: boolean;
}
export interface AgentReply {
  reply: string;
  actions: AgentAction[];
  /** 「按 JD 优化」第一步返回的匹配度分析；普通对话和改写步骤都是 undefined */
  analysis?: JdAnalysis | null;
}
export type AgentAction = { type?: string } & Record<string, unknown>;

const KINDS: Exclude<Kind, "blank">[] = [
  "name",
  "section",
  "entry",
  "text",
  "bullet",
  "ordered",
  "h4",
  "h5",
  "h6",
];
const FONT_KEYS: Settings["font"][] = ["sans", "serif", "nunito"];
const TEMPLATE_IDS = templates.map((t) => t.id);

export const defaultAgentConfig = (): AgentConfig => ({
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
});

export function loadAgentConfig(): AgentConfig {
  try {
    const raw = localStorage.getItem(AGENT_CONFIG_KEY);
    if (!raw) return defaultAgentConfig();
    const saved = JSON.parse(raw) as Partial<AgentConfig>;
    return {
      baseUrl: String(saved.baseUrl || defaultAgentConfig().baseUrl),
      model: String(saved.model || defaultAgentConfig().model),
      apiKey: String(saved.apiKey || ""),
    };
  } catch {
    return defaultAgentConfig();
  }
}
export function saveAgentConfig(config: AgentConfig) {
  localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(config));
}
export function noticeAccepted() {
  return localStorage.getItem(NOTICE_KEY) === "1";
}
export function acceptNotice() {
  localStorage.setItem(NOTICE_KEY, "1");
}

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n * 100) / 100))
    : fallback;
};
// 行号必须严格落在范围内：不要把 0 / 超界的值“夹”进来，否则会误删第一行
const lineNo = (v: unknown, max: number, allowZero = false) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= (allowZero ? 0 : 1) && n <= max ? n : -1;
};

/** 行号 → 这条指令实际要动的那一行。
 *
 *  为什么需要这一步：空行（kind === "blank"）在分页渲染时会被 filter 掉
 *  （见 flow.ts 的 paginate），所以在界面上根本看不见。
 *  模型如果指到了空行，按原样改就是「改了但界面一点变化都没有」，
 *  用户会觉得按钮坏了。这里统一换算成最近的、界面上看得见的一行。
 *
 *  返回 -1 表示这条指令本来就不合法（行号越界之类），交给调用方报错。 */
function aimedLine(
  lines: Line[],
  raw: unknown,
  opts: { allowZero?: boolean; includeBlank?: boolean } = {},
): number | "same" {
  const at = lineNo(raw, lines.length, opts.allowZero);
  if (at < 0) return -1;
  if (opts.includeBlank || at === 0) return at;
  const visible = (index: number) => !!lines[index] && lines[index].kind !== "blank";
  if (visible(at - 1)) return at;
  // 先往前找（同一段落内部的空行，前一行通常才是那句话）
  for (let i = at - 2; i >= 0; i--) if (visible(i)) return i + 1;
  // 前面全是空行，再往后找
  for (let i = at; i < lines.length; i++) if (visible(i)) return i + 1;
  // 整段都是空行，找不到能改的行——不能硬改一个，那样用户看不到任何变化
  return "same";
}
const hexColor = (v: unknown) =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "";

// 给模型看的当前排版摘要：只放排版参数和板块结构，不放正文，省 token 也少泄露
export function describeDoc(
  doc: Resume,
  pageCount = 1,
  includeContent = false,
) {
  const s = doc.settings,
    types = KINDS.map((k) => {
      const t = s.types[k];
      return `${k} ${t.size}px(${t.before}/${t.after})`;
    }).join("，");
  const sections: string[] = [];
  let index = 0;
  for (let i = 0; i < doc.lines.length; i = groupEnd(doc.lines, i)) {
    const line = doc.lines[i];
    if (line.kind !== "section") continue;
    index++;
    sections.push(
      `${index}. ${line.text}（${groupEnd(doc.lines, i) - i - 1} 行内容）`,
    );
  }
  const head = [
    `模板：${doc.template}（${templates.find((t) => t.id === doc.template)?.name || ""}）`,
    `字体：${s.font}；行高：${s.lineHeight}；表头：${s.headerAlign}`,
    `页边距 上${s.top}/下${s.bottom}/左${s.left}/右${s.right}px`,
    `主题色：${s.accent}；正文色：${s.color}`,
    `字号(段前/段后)：${types}`,
    `板块顺序：${sections.join(" / ") || "（没有板块标题）"}`,
    `总行数：${doc.lines.length}；当前页数：${pageCount}`,
  ];
  if (includeContent)
    head.push(
      "",
      "正文（数字是行号，含 markdown 标记；标了「空行」的那几行在版面上看不见，不要指它们）：",
      ...doc.lines.map((line, index) =>
        line.kind === "blank"
          ? `${index + 1}: （空行）`
          : `${index + 1}: ${toMarkdown([line])}`,
      ),
    );
  return head.join("\n");
}

export const AGENT_CONTENT_PROMPT = `
你还被允许修改文字内容（仅在用户明确要求改写、补充、删除、调整顺序时使用，不要自作主张）：
12 {"type":"setText","line":4,"text":"新的这一行文字"} 改写第 4 行（保留原来的行类型，不要带 markdown 标记里的行前缀）
13 {"type":"setKind","line":4,"kind":"text|bullet|section|entry|h4|h5|h6|ordered"} 改这一行的类型
14 {"type":"insert","after":4,"kind":"bullet","text":"新的要点"} 在第 4 行后面插入一行（after 用 0 表示插到最前面）
15 {"type":"remove","line":4} 删除第 4 行
16 {"type":"replace","find":"原文片段","replace":"新片段"} 全文替换（谨慎使用）
17 {"type":"setContent","text":"# 姓名\n手机 | 邮箱\n## 板块\n### 标题 | 角色 | 时间\n- 要点"} 整份重排：用一条动作把整篇内容替换掉

内容编辑规则：
- 行号以「正文」列表里每行前面的数字为准，一次最多动 8 行；不要整篇重写，除非用户明确要求。
- 「正文」里有些行是空的（段落之间的空行），它们也会占一个行号，但在版面上看不见。
  改字、删行一律指到**有文字的那一行**，不要指到空行——指到空行等于什么都没改。
- 只能润色、精简、补全用户已经给出的信息，绝不能编造学历、公司、时间、数字、奖项；缺少的信息用「待补充」占位。
- 经历行的格式是「左侧 | 中间 | 右侧」，用 " | " 分隔，删除或改写时保持这个结构。
- 保持中文表达自然、简短，每条要点不超过 60 字。
- 用户一次性发来一整份简历（开头是姓名、接着联系方式，再用【板块】或多个小标题分段，经历行带公司/角色/时间，条目以 · • - 开头）时，用**一个** setContent 动作把全文整理成结构化文本，不要逐行 setText/insert：
  · 第一行写成 "# 姓名"；
  · 联系方式那一两行原样保留为普通行（不要画蛇添足加标签）；
  · "【个人总结】"这类标题改成 "## 个人总结"；没有方括号但本身就是板块名的（教育背景 / 实习经历 / 项目经历 / 专业技能 / 证书 等）也改成 "## xx"；
  · "► 公司  职位  2026.05 – 2026.09" 改成 "### 公司 | 职位 | 2026.05 – 2026.09"；"学校  专业  学历  时间" 同样合并成 "### 学校 | 专业 学历 | 时间"；
  · 以 · • ● - 或数字编号开头的条目改成 "- 要点"；数字编号保留成 "1. "；
  · 其余内容原样作为普通行；空行丢掉。
  · 公司名、学校名、专业、日期、数字、证书名称一律照抄，不润色、不合并、不编造；用户明确说“顺便改一下措辞”才动文字。
`;

export const AGENT_SYSTEM_PROMPT = `你是简历助手。用户会用中文描述需求；默认只调整「样式与结构」，不改动用户写下的文字，只有用户明确要求改写内容时才动文字。

只输出一个 JSON 对象，不要输出别的文字、不要用 markdown 代码块：
{"reply":"一句中文说明你做了什么","actions":[动作对象...]}

可用动作（actions 是数组，按顺序执行）：
1 {"type":"template","template":"blue|black|ribbon|academic|teal|violet"} 换模板
2 {"type":"font","font":"sans|serif|nunito"} 换字体
3 {"type":"fontSize","kind":"name|section|entry|text|bullet|ordered|h4|h5|h6|all","size":10到32的数字} 字号
4 {"type":"lineHeight","value":1.15到2.2} 行高
5 {"type":"spacing","kind":"同上","before":0到24,"after":0到24} 段前段后（px）
6 {"type":"margins","top":12到120,"bottom":12到120,"left":12到120,"right":12到120} 页边距（px）
7 {"type":"accent","color":"#rrggbb"} 主题色；{"type":"ink","color":"#rrggbb"} 正文色
8 {"type":"headerAlign","value":"left|center"} 表头对齐
9 {"type":"compact"} 一键紧凑：字号各减、行高 1.35、段距收紧
10 {"type":"moveSection","section":"板块标题原文","to":从1开始的目标位置} 调整板块顺序
11 {"type":"removeEmptyLines"} 清掉文档里的空行（只是让文档更干净：空行不参与排版，
   删掉后版面和左栏都不会有任何变化，别指望它能去掉视觉上的留白）

规则：
- 内容已经很长或页数偏多时，优先用 compact、缩小字号、收紧段距、减少页边距。
- 用户说“学术/简洁/商务/标签风”之类的感觉时，挑最接近的模板并说明选择理由。
- 用户说“删空行 / 去掉空行”时：给 removeEmptyLines，同时在 reply 里如实说明
  「空行在版面上本来就不显示，删掉后外观不会变」。如果用户的真实诉求是
  「看上去空太多 / 太松散 / 间隔太大」，那必须再给 spacing（把各类的 before/after
  调小，例如 section 2/2→1/1、entry 3/2→2/1、bullet 1/1→0/0）或 compact ——
  只给 removeEmptyLines 用户会觉得你没做事，因为他根本看不见变化。
- 一次最多给 6 个动作，不要重复堆叠同一种动作。
- 只要用户的要求能用上面的动作实现，就必须在 actions 里给出动作，不能只在 reply 里描述。
- 你可以看到这段对话的历史，用户说“再紧一点”“刚才那个模板”“回到之前那样”时，按历史里已经应用过的改动为基准继续调整。
- 如果请求和这份简历完全无关（闲聊、写代码等），actions 返回空数组，并在 reply 里说明你只处理这份简历。`;

function turnSuffix(turn: AgentTurn) {
  if (turn.role !== "assistant") return "";
  if (turn.rejected) return "\n（这一版方案用户没有接受，简历保持原样）";
  if (turn.notes?.length)
    return "\n（这一版实际应用到简历的改动：" + turn.notes.join("；") + "）";
  return "";
}

// 把历史对话整理成 messages：整段历史都给模型（不按条数或字符截断），
// 助手的每一轮会带上“实际改了什么”，模型才知道前后文到底发生了什么。
export function buildAgentMessages(
  system: string,
  turns: AgentTurn[],
  input: string,
) {
  const picked = [...turns];
  // 历史必须以 user 开头，避免出现没有对应问题的 assistant
  while (picked.length && picked[0].role === "assistant") picked.shift();
  return [
    { role: "system", content: system },
    ...picked.map((turn) => ({
      role: turn.role,
      content: turn.text + turnSuffix(turn),
    })),
    { role: "user", content: input },
  ];
}

// 供系统提示用的“这次会话已经做过的改动”，超出对话窗口也能记住
export function changesDigest(turns: AgentTurn[]) {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    if (turn.notes?.length) out.push(turn.notes.join("、"));
    else if (turn.rejected) out.push("（有一版方案被拒绝，简历未改）");
  }
  return out;
}

export const AGENT_JD_PROMPT = `
## 当前任务：按 JD（岗位描述）优化这份简历

用户粘了一份招聘 JD，你要让这份简历更贴合这个岗位。分两步走，每次只做一步：

### 第一步：分析匹配度（用户还没选方向时做这一步）
只输出分析，**不要给任何 actions**（actions 返回空数组）：
{"reply":"","analysis":{"role":"岗位名称","musts":["JD 里硬性要求的技能/经验，3-6 条"],"matched":["简历里已经对上 JD 的点，引用原文关键词"],"gaps":["JD 要但简历没写或写得弱的点，2-6 条"],"advice":"一句话说建议怎么改"}}

### 第二步：按用户选的方向改写（用户回复方向之后做这一步）
用下面的动作改，**必须同时返回 analysis 为 null**：
{"reply":"一句说明改了什么","analysis":null,"actions":[...]}

改写硬规则：
- **绝不编造**。学历、公司、学校、职位、时间、数字、奖项、证书，一个都不能虚构。
- 只能做这些事：把已有经历换个说法去贴 JD 的关键词、调整要点顺序（JD 更要紧的放前面）、
  精简啰嗦的句子、把散落的信息合并成一条有力度的要点、调整板块顺序把相关经历提前。
- JD 要求但简历里**确实没有**的，不要编，而是在 reply 里用一句话告诉用户「XX 这块你简历里没有，
  如果确实做过，建议补一条具体的」。
- 改写要点时尽量复用 JD 里的原词（招聘方和筛选系统都在找这些词），但不要生硬堆砌，
  一句话里最多落 2 个关键词。
- 每个要点不超过 60 字，以结果/影响结尾（做了什么 + 达成什么）。
- 一次最多改 8 行。
- 经历行保持「左侧 | 中间 | 右侧」结构，用 " | " 分隔。

### 动作怎么选（很重要）
- 改某一行的文字：**只用 setText**，line 填「正文」列表里那一行前面的数字。
  不要把整行原文放进 find 去 replace——原文里可能有换行、空格对不上，会匹配失败。
- replace 只用于「一个词在全文多处出现、要统一换掉」这种场景。
- **公司名、学校名、专业名、职位名、起止时间，一个字都不能改。**
  即使 JD 要的是别的行业，也只能改描述它们的话，不能改它们本身。
`;

export interface JdAnalysis {
  role: string;
  musts: string[];
  matched: string[];
  gaps: string[];
  advice: string;
}

// ---- 按 JD 改写时的事实保护 ----
// 公司名、学校名、专业名、时间这些是「事实」，改一个字就是编造。
// 模型偶尔会把整行原文塞进 replace 里去换写法，顺手把公司名也改了；
// 这里在执行前拦一道，改到事实字段的一律跳过并告诉用户。

const DATE_RE =
  /\d{4}\s*[.\-/年]\s*\d{1,2}\s*([.\-/月]\s*\d{1,2}\s*)?[日]?\s*(—|-|–|~|至|到)?\s*(\d{4}\s*[.\-/年]\s*\d{1,2}\s*([.\-/月]\s*\d{1,2}\s*)?[日]?|至今|现在|present)?/gi;

/** 从一段经历行里取出「不该被改」的片段：各栏内容 + 时间 */
function factFragments(text: string): string[] {
  return text
    .split(" | ")
    .flatMap((cell) => {
      const times = cell.match(DATE_RE) || [];
      const rest = cell
        .replace(DATE_RE, " ")
        .replace(/\s+/g, " ")
        .trim();
      return [rest, ...times.map((t) => t.trim())];
    })
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * 判断一次改写是否动到了事实字段。
 * 返回被改掉的事实片段（空数组表示没动到，可以放心执行）。
 */
export function pushedFacts(
  before: string,
  after: string,
  kind: Kind,
): string[] {
  if (kind !== "entry" && kind !== "name") return [];
  const kept = factFragments(before);
  const now = after.replace(/\s+/g, " ");
  return kept.filter((frag) => !now.includes(frag));
}

const strList = (value: unknown, cap = 6) =>
  Array.isArray(value)
    ? value
        .filter((v) => typeof v === "string" && v.trim())
        .map((v) => (v as string).trim().slice(0, 120))
        .slice(0, cap)
    : [];

// 把模型返回的 analysis 收拾干净；任何一个字段都没有就当没给
export function readAnalysis(value: unknown): JdAnalysis | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const analysis: JdAnalysis = {
    role: typeof raw.role === "string" ? raw.role.trim().slice(0, 60) : "",
    musts: strList(raw.musts),
    matched: strList(raw.matched),
    gaps: strList(raw.gaps),
    advice: typeof raw.advice === "string" ? raw.advice.trim().slice(0, 300) : "",
  };
  const empty =
    !analysis.role &&
    !analysis.musts.length &&
    !analysis.matched.length &&
    !analysis.gaps.length &&
    !analysis.advice;
  return empty ? null : analysis;
}

// 按 JD 解析简历：第一步分析，第二部改写，共用一套动作协议
export async function matchResumeToJd(
  config: AgentConfig,
  doc: Resume,
  pageCount: number,
  jd: string,
  direction: string,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const system =
    AGENT_SYSTEM_PROMPT +
    AGENT_CONTENT_PROMPT +
    "\n\n" +
    AGENT_JD_PROMPT +
    "\n\n当前简历参数与正文：\n" +
    describeDoc(doc, pageCount, true);
  const input = direction
    ? `目标岗位 JD（原文）：\n<<<\n${jd.slice(0, 60000)}\n>>>\n\n我选的方向：${direction}\n请按这个方向改写简历。`
    : `目标岗位 JD（原文）：\n<<<\n${jd.slice(0, 60000)}\n>>>\n\n先只做匹配度分析，不要改简历。`;
  return requestAgent(config, system, [], input, signal);
}

export const AGENT_REVIEW_PROMPT = `你现在的任务是给一份「已经初排好」的简历调整格式。
可以动的：
- 行类型：setKind（把该是要点的行改成 bullet、该是经历行的改成 entry、该是板块标题的改成 section）
- 板块顺序：moveSection
- 整体版式：template、font、fontSize、lineHeight、spacing、margins、accent、headerAlign、compact
- 清理空行：removeEmptyLines
- 整篇重排：setContent（局部改动理不顺时，用它一次性重写整篇结构；
  必须保留原文全部信息，不许丢句、丢要点、编造内容）

文字以「不改」为默认；用户在对话里明确要求改写、精简、补写时才可以动字，
动字必须保持原意、不许编造公司/学校/时间/数字，并且只能在确实需要时小范围修改。

用户没有特别说明时，优先保证这几件事：
1) 姓名在第一行，联系方式紧跟其后；
2) 每个板块下面有内容，条目一律是 bullet；
3) 经历行是「左侧 | 中间 | 右侧」三栏（公司/学校 | 职位/专业 | 时间）。
只输出一个 JSON 对象，格式与平时一致。`;

// AI 复核只允许这些动作：改类型、调版式、删空行，绝不碰文字内容
const REVIEW_ACTIONS = new Set([
  "setKind",
  "setText",
  "insert",
  "remove",
  "replace",
  "setContent",
  "moveSection",
  "template",
  "font",
  "fontSize",
  "lineHeight",
  "spacing",
  "margins",
  "accent",
  "ink",
  "headerAlign",
  "compact",
  "removeEmptyLines",
]);

export function isReviewAction(type: string) {
  return REVIEW_ACTIONS.has(type);
}

// 和对话里「帮我把格式调好」走同一套动作协议，只是把权限收紧到不改字
export async function reviewLayout(
  config: AgentConfig,
  draft: Resume,
  original: string,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const system =
    AGENT_SYSTEM_PROMPT +
    AGENT_CONTENT_PROMPT +
    "\n\n" +
    AGENT_REVIEW_PROMPT +
    "\n\n当前简历参数与正文：\n" +
    describeDoc(draft, 1, true);
  return requestAgent(
    config,
    system,
    [],
    `下面是我粘贴的原始简历。请只调整格式与结构，不要改字：\n<<<\n${original.slice(0, 120000)}\n>>>`,
    signal,
  );
}

// 校验 AI 复核有没有偷偷改字：只比较正文内容，忽略空白和结构符号
export function stripStructure(markdown: string) {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[\s|｜·•]/g, "");
}

// 单次请求的上下文预算（粗略按 token 计）。超过就把早前的对话压成摘要。
export const AGENT_CONTEXT_LIMIT = 300_000;
// 摘要时至少保留最近这么多条原文，避免刚说过的内容被压掉
const KEEP_RECENT_TURNS = 12;
const SUMMARY_BATCH = 10;

// 中文按 1 字 1 token 估，其它字符按 3.5 字 1 token 估，偏保守
export function estimateTokens(text: string) {
  let wide = 0,
    narrow = 0;
  for (const char of text) {
    if ((char.codePointAt(0) || 0) >= 0x2e80) wide++;
    else narrow++;
  }
  return Math.ceil(wide + narrow / 3.5);
}

export const AGENT_SUMMARY_PROMPT = `你在压缩一段「简历编辑对话」，供后续继续对话时参考。
把「已有摘要」和「新增对话」合并成一段不超过 400 字的中文摘要，必须保留：
1) 用户提过的要求、偏好和禁止事项；
2) 已经应用的改动、被拒绝或被忽略的改动；
3) 还没解决的问题。
不要编造，不要写寒暄。只输出摘要正文。`;

async function summarizeTurns(
  config: AgentConfig,
  previous: string,
  batch: AgentTurn[],
  signal?: AbortSignal,
) {
  const url = config.baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: 0,
      messages: [
        { role: "system", content: AGENT_SUMMARY_PROMPT },
        {
          role: "user",
          content: `已有摘要：\n${previous || "（无）"}\n\n新增对话：\n${batch
            .map((turn) =>
              `${turn.role === "user" ? "用户" : "助手"}：${turn.text}${
                turn.notes?.length ? `（改动：${turn.notes.join("；")}）` : ""
              }`,
            )
            .join("\n")}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`摘要接口返回 ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (data.choices?.[0]?.message?.content || "").trim();
}

export interface AgentSummary {
  text: string;
  count: number;
}

// 超出预算时，把最早的对话分批摘要，留一个可续用的摘要 + 最近若干条原文
export async function compactHistory(
  config: AgentConfig,
  system: string,
  input: string,
  turns: AgentTurn[],
  summary: AgentSummary,
  signal?: AbortSignal,
  budget = AGENT_CONTEXT_LIMIT,
) {
  let text = summary.text,
    count = Math.max(0, Math.min(summary.count, turns.length));
  const size = () =>
    estimateTokens(system) +
    estimateTokens(input) +
    estimateTokens(text) +
    estimateTokens(
      turns
        .slice(count)
        .map((turn) => turn.text + (turn.notes?.join("") || ""))
        .join(""),
    );
  let compacted = false;
  while (size() > budget && turns.length - count > KEEP_RECENT_TURNS) {
    const next = Math.min(turns.length - KEEP_RECENT_TURNS, count + SUMMARY_BATCH);
    text = await summarizeTurns(config, text, turns.slice(count, next), signal);
    count = next;
    compacted = true;
  }
  return { summary: { text, count }, compacted };
}

export async function requestAgent(
  config: AgentConfig,
  system: string,
  turns: AgentTurn[],
  input: string,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const url = config.baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: 0.2,
      messages: buildAgentMessages(system, turns, input),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `接口返回 ${res.status}${detail ? "：" + detail.slice(0, 160) : ""}`,
    );
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content || "";
  return parseAgentReply(text);
}

export function parseAgentReply(text: string): AgentReply {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{"),
    end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { reply: cleaned.slice(0, 500) || "（没有返回内容）", actions: [] };
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      reply?: unknown;
      actions?: unknown;
      analysis?: unknown;
    };
    const actions = Array.isArray(parsed.actions)
      ? (parsed.actions.filter(
          (a) => a && typeof a === "object",
        ) as AgentAction[])
      : [];
    return {
      reply: String(parsed.reply || "已完成调整。"),
      actions: actions.slice(0, 12),
      analysis: readAnalysis(parsed.analysis),
    };
  } catch {
    return { reply: cleaned.slice(0, 500), actions: [] };
  }
}

const withSettings = (doc: Resume, patch: Partial<Settings>): Resume => ({
  ...doc,
  settings: { ...doc.settings, ...patch },
});
const withType = (
  doc: Resume,
  kinds: Exclude<Kind, "blank">[],
  patch: Partial<Settings["types"]["text"]>,
): Resume => {
  const types = { ...doc.settings.types };
  for (const kind of kinds)
    types[kind] = { ...types[kind], ...patch } as Settings["types"][typeof kind];
  return withSettings(doc, { types });
};
const pickKinds = (value: unknown): Exclude<Kind, "blank">[] => {
  const text = String(value ?? "all").toLowerCase();
  if (text === "all" || text === "全部" || text === "") return KINDS;
  return KINDS.filter((k) => k === text);
};
export function sectionTitles(doc: Resume) {
  return doc.lines.filter((l) => l.kind === "section").map((l) => l.text.trim());
}

// 执行一组动作，返回新文档 + 给用户看的中文说明
export function applyAgentActions(
  doc: Resume,
  actions: AgentAction[],
): { doc: Resume; notes: string[]; skipped: string[] } {
  let next = doc;
  const notes: string[] = [],
    skipped: string[] = [];
  for (const action of actions) {
    const type = String(action.type || "");
    if (type === "template") {
      const id = String(action.template || "") as Template;
      if (!TEMPLATE_IDS.includes(id)) {
        skipped.push(`不认识的模板「${id}」`);
        continue;
      }
      next = {
        ...next,
        template: id,
        settings: {
          ...next.settings,
          accent: templates.find((t) => t.id === id)!.color,
        },
      };
      notes.push(`切换模板为「${templates.find((t) => t.id === id)!.name}」`);
    } else if (type === "font") {
      const font = String(action.font || "") as Settings["font"];
      if (!FONT_KEYS.includes(font)) {
        skipped.push("不认识的字体");
        continue;
      }
      next = withSettings(next, { font });
      notes.push(`字体改为 ${font === "sans" ? "黑体" : font === "serif" ? "宋体" : "Nunito"}`);
    } else if (type === "fontSize") {
      const kinds = pickKinds(action.kind);
      const size = num(action.size, 10, 32, 0);
      if (!kinds.length || !size) {
        skipped.push("字号值不合法");
        continue;
      }
      next = withType(next, kinds, { size });
      notes.push(
        `${kinds.length === KINDS.length ? "全部文字" : kinds.join("/")} 字号改为 ${size}px`,
      );
    } else if (type === "lineHeight") {
      const value = num(action.value, 1.15, 2.2, 0);
      if (!value) {
        skipped.push("行高值不合法");
        continue;
      }
      next = withSettings(next, { lineHeight: value });
      notes.push(`行高改为 ${value}`);
    } else if (type === "spacing") {
      const kinds = pickKinds(action.kind);
      const patch: { before?: number; after?: number } = {};
      if (action.before !== undefined)
        patch.before = num(action.before, 0, 24, 0);
      if (action.after !== undefined) patch.after = num(action.after, 0, 24, 0);
      if (!kinds.length || !Object.keys(patch).length) {
        skipped.push("段距参数不完整");
        continue;
      }
      next = withType(next, kinds, patch);
      notes.push(
        `${kinds.length === KINDS.length ? "所有段落" : kinds.join("/")} 段距改为${
          patch.before !== undefined ? ` 前${patch.before}px` : ""
        }${patch.after !== undefined ? ` 后${patch.after}px` : ""}`,
      );
    } else if (type === "margins") {
      const s = next.settings,
        patch: Partial<Settings> = {};
      if (action.top !== undefined) patch.top = num(action.top, 12, 120, s.top);
      if (action.bottom !== undefined)
        patch.bottom = num(action.bottom, 12, 120, s.bottom);
      if (action.left !== undefined) patch.left = num(action.left, 12, 120, s.left);
      if (action.right !== undefined)
        patch.right = num(action.right, 12, 120, s.right);
      if (!Object.keys(patch).length) {
        skipped.push("页边距参数不完整");
        continue;
      }
      next = withSettings(next, patch);
      notes.push(
        `页边距 上${next.settings.top}/下${next.settings.bottom}/左${next.settings.left}/右${next.settings.right}`,
      );
    } else if (type === "accent" || type === "ink") {
      const color = hexColor(action.color);
      if (!color) {
        skipped.push("颜色格式不对（要 #rrggbb）");
        continue;
      }
      next = withSettings(next, type === "accent" ? { accent: color } : { color });
      notes.push(`${type === "accent" ? "主题色" : "正文色"}改为 ${color}`);
    } else if (type === "headerAlign") {
      const value = action.value === "left" ? "left" : "center";
      next = withSettings(next, { headerAlign: value });
      notes.push(`表头${value === "left" ? "左对齐" : "居中"}`);
    } else if (type === "compact") {
      const types = { ...next.settings.types };
      for (const kind of KINDS)
        types[kind] = {
          ...types[kind],
          size: Math.max(10, types[kind].size - 1),
          before: Math.max(0, types[kind].before - 1),
          after: Math.max(0, types[kind].after - 1),
        };
      next = withSettings(next, { types, lineHeight: 1.35 });
      notes.push("一键紧凑：字号与段距各减 1，行高 1.35");
    } else if (type === "moveSection") {
      const wanted = String(action.section || "").trim();
      const lines = next.lines,
        at = lines.findIndex(
          (l) =>
            l.kind === "section" &&
            (l.text.trim() === wanted || l.text.includes(wanted)),
        );
      if (at < 0) {
        skipped.push(`没找到板块「${wanted}」`);
        continue;
      }
      const order = next.lines
        .map((l, i) => (l.kind === "section" ? i : -1))
        .filter((i) => i >= 0);
      const position = Math.round(num(action.to, 1, order.length, 0));
      if (!position) {
        skipped.push("目标位置不合法");
        continue;
      }
      const boundary =
        position <= 1
          ? order[0]
          : position > order.length
            ? lines.length
            : order[position - 1];
      const moved = moveGroupToBoundary(next, lines[at].id, boundary);
      if (moved === next) {
        skipped.push(`「${wanted}」已经在这个位置`);
        continue;
      }
      next = moved;
      notes.push(`把「${wanted}」排到第 ${position} 位`);
    } else if (type === "removeEmptyLines") {
      const lines = next.lines.filter((l) => l.kind !== "blank"),
        removed = next.lines.length - lines.length;
      if (!removed) {
        skipped.push("没有空行可删");
        continue;
      }
      next = { ...next, lines };
      // 空行不参与排版（paginate 会先 filter 掉），所以这个动作永远改变不了观感。
      // notes 会原样念给用户听，必须把这件事写明白，否则用户会以为按钮坏了。
      notes.push(`删掉 ${removed} 个空行（空行不参与排版，版面上看不出变化）`);
    } else if (type === "setText") {
      // 指到空行就换到最近的可见行：空行不渲染，改它等于没改
      const at = aimedLine(next.lines, action.line);
      const text = typeof action.text === "string" ? action.text.slice(0, 2000) : "";
      if (at === "same") {
        skipped.push(`第 ${String(action.line)} 行附近全是空行，没有能改的文字`);
        continue;
      }
      if (at < 0) {
        skipped.push(`行号 ${String(action.line)} 不存在`);
        continue;
      }
      const old = next.lines[at - 1];
      if (old.kind === "blank") {
        skipped.push(`第 ${at} 行是空行，界面上看不见，已跳过`);
        continue;
      }
      // 板块标题和经历行不是「一句话」：往标题里塞正文，会把「实习经历」
      // 整行换成一段工作描述，版式全乱。要改这类内容得用 setKind / insert。
      if (old.kind === "section" || old.kind === "entry" || old.kind === "name") {
        skipped.push(
          `第 ${at} 行是${kindLabels[old.kind]}，不能直接改成正文；要加内容请用 insert 插一行`,
        );
        continue;
      }
      const broken = pushedFacts(old.text, text, old.kind);
      if (broken.length) {
        skipped.push(
          `第 ${at} 行这次改写会动到「${broken[0]}」这类不改该的内容（学校/公司/时间），已跳过`,
        );
        continue;
      }
      // 改了但文字一模一样 = 界面不会变，报「改写」会让用户以为按钮坏了
      if (old.text === text) {
        skipped.push(`第 ${at} 行这次给的文字和原来一样，没有变化`);
        continue;
      }
      next = {
        ...next,
        lines: next.lines.map((line, i) => (i === at - 1 ? { ...line, text } : line)),
      };
      notes.push(`改写第 ${at} 行`);
    } else if (type === "setKind") {
      const at = aimedLine(next.lines, action.line, { includeBlank: true }),
        kind = String(action.kind || "") as Kind;
      const allowed: Kind[] = [...KINDS, "blank"];
      if (at === "same" || at < 0 || !allowed.includes(kind)) {
        skipped.push(`第 ${at} 行的类型改不了`);
        continue;
      }
      next = {
        ...next,
        lines: next.lines.map((line, i) =>
          i === at - 1 ? { ...line, kind, ...(kind !== "ordered" ? {} : { order: 1 }) } : line,
        ),
      };
      notes.push(`第 ${at} 行改成 ${kindLabels[kind]}`);
    } else if (type === "insert") {
      const after = lineNo(action.after, next.lines.length, true),
        kind = String(action.kind || "text") as Kind,
        text = typeof action.text === "string" ? action.text.slice(0, 2000) : "";
      if (after < 0) {
        skipped.push("插入位置不合法");
        continue;
      }
      // 落点修正只做「往后不要往前」：
      // 指到空行时，放到下一个可见行前面（= 紧贴那句话上方），
      // 绝不往前挪到上一句后面 —— 那会和模型的意图差一整行。
      let host = after;
      if (host > 0 && host < next.lines.length && next.lines[host - 1].kind === "blank") {
        // 空行之后的那一行如果可见，就把新行插在它前面
        host -= 1;
        while (host + 1 < next.lines.length && next.lines[host].kind === "blank") host++;
      }
      const line: Line = { id: uid(), kind, text };
      const lines = [...next.lines];
      lines.splice(host, 0, line);
      next = { ...next, lines };
      notes.push(
        host === 0
          ? `在最前面插入一行${kindLabels[kind]}`
          : `在第 ${host} 行后插入一行${kindLabels[kind]}`,
      );
    } else if (type === "remove") {
      // 删行严格按原行号：空行删掉是合法的（用户就是想清空行），
      // 但绝不能因为「第 4 行是空行」就顺手删掉第 3 行的正文。
      const at = lineNo(action.line, next.lines.length);
      if (at < 0) {
        skipped.push(`行号 ${String(action.line)} 不存在`);
        continue;
      }
      const target = next.lines[at - 1];
      next = { ...next, lines: next.lines.filter((_, i) => i !== at - 1) };
      notes.push(
        target.kind === "blank" ? `删掉第 ${at} 行的空行` : `删除第 ${at} 行`,
      );
    } else if (type === "replace") {
      const find = typeof action.find === "string" ? action.find : "",
        to = typeof action.replace === "string" ? action.replace.slice(0, 2000) : "";
      if (!find) {
        skipped.push("替换缺少原文");
        continue;
      }
      // 先算出哪些行会被改到事实字段，改到的整行跳过，其余照常替换
      const safe = (line: Line) => {
        if (!line.text.includes(find)) return true;
        const after = line.text.split(find).join(to);
        const broken = pushedFacts(line.text, after, line.kind);
        if (broken.length) {
          skipped.push(
            `替换「${find}」会动到「${broken[0]}」（学校/公司/时间这类），已跳过这一行`,
          );
          return false;
        }
        return true;
      };
      let count = 0;
      next = {
        ...next,
        lines: next.lines.map((line) => {
          if (!line.text.includes(find) || !safe(line)) return line;
          count += line.text.split(find).length - 1;
          return { ...line, text: line.text.split(find).join(to) };
        }),
      };
      if (!count) skipped.push(`没找到「${find}」`);
      else notes.push(`替换「${find}」共 ${count} 处`);
    } else if (type === "setContent") {
      const text =
          typeof action.text === "string" ? action.text.slice(0, 150000) : "",
        lines = text.trim() ? contentToLines(text) : [];
      if (!lines.length) {
        skipped.push("整篇内容为空或读不出来");
        continue;
      }
      next = { ...next, lines };
      notes.push(`整篇重排（${lines.length} 行）`);
    } else {
      skipped.push(`不支持的动作「${type}」`);
    }
  }
  return { doc: next, notes, skipped };
}
