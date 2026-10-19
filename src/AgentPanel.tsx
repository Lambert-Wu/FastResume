import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  Bot,
  Eraser,
  Send,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import {
  AGENT_CONTENT_PROMPT,
  AGENT_SYSTEM_PROMPT,
  acceptNotice,
  applyAgentActions,
  changesDigest,
  compactHistory,
  describeDoc,
  isReviewAction,
  matchResumeToJd,
  reviewLayout,
  turnsKey,
  loadAgentConfig,
  noticeAccepted,
  requestAgent,
  saveAgentConfig,
} from "./agent";
import type {
  AgentAction,
  AgentConfig,
  AgentSummary,
  AgentTurn,
  JdAnalysis,
} from "./agent";
import { layoutSteps, textToLines } from "./importText";

import type { Resume } from "./flow";

const EXAMPLES = [
  "内容有点挤，帮我排得清爽一点",
  "换成学术风，表头左对齐",
  "把专业技能排到最前面",
  "行距松一点，看着更透气",
];
const summaryKey = (docId: string) => `diyjobresume.agent.summary.v1.${docId}`;
// JD 按简历分开存：每份简历通常投不同岗位，不该串台
const jdKey = (docId: string) => `diyjobresume.agent.jd.v1.${docId}`;
const JD_MAX = 20000;

function loadJd(docId: string): string {
  try {
    return localStorage.getItem(jdKey(docId)) || "";
  } catch {
    return "";
  }
}

function loadSummary(docId: string): AgentSummary {
  try {
    const raw = localStorage.getItem(summaryKey(docId));
    if (!raw) return { text: "", count: 0 };
    const saved = JSON.parse(raw) as Partial<AgentSummary>;
    return {
      text: typeof saved.text === "string" ? saved.text : "",
      count: Number(saved.count) || 0,
    };
  } catch {
    return { text: "", count: 0 };
  }
}

function loadTurns(docId: string): AgentTurn[] {
  try {
    const raw = localStorage.getItem(turnsKey(docId));
    if (!raw) return [];
    const list = JSON.parse(raw) as AgentTurn[];
    return Array.isArray(list)
      ? list
          .filter(
            (t) =>
              t &&
              (t.role === "user" || t.role === "assistant") &&
              typeof t.text === "string",
          )
          .map((t) => ({
            role: t.role,
            text: t.text,
            notes: Array.isArray(t.notes)
              ? t.notes.filter((n) => typeof n === "string")
              : undefined,
            rejected: t.rejected === true || undefined,
          }))
      : [];
  } catch {
    return [];
  }
}
function errorText(e: unknown) {
  const name = e instanceof Error ? e.name : "",
    message = String(e instanceof Error ? e.message : e);
  if (name === "AbortError") return "请求超时（90 秒），检查接口地址和网络。";
  if (/fetch/i.test(message))
    return "请求失败：地址可能不对，或对方接口不允许浏览器直连（CORS）。";
  return message;
}

export function AgentPanel({
  doc,
  docId,
  pageCount,
  docked = false,
  onApply,
  onPreview,
  onClearPreview,
  registerPreviewApi,
  onClose,
}: {
  doc: Resume;
  docId: string;
  pageCount: number;
  docked?: boolean;
  onApply: (next: Resume) => void;
  onPreview: (next: Resume) => void;
  onClearPreview: () => void;
  registerPreviewApi: (
    api: { accept: () => void; reject: () => void } | null,
  ) => void;
  onClose: () => void;
}) {
  const [config, setConfig] = useState(loadAgentConfig),
    [draft, setDraft] = useState(loadAgentConfig),
    [setupOpen, setSetupOpen] = useState(() => !loadAgentConfig().apiKey),
    [agreed, setAgreed] = useState(noticeAccepted),
    [input, setInput] = useState(""),
    [tab, setTab] = useState<"chat" | "jd" | "paste">("chat"),
    [pasteText, setPasteText] = useState(""),
    // 「按 JD 优化」的独立状态：和对话互不干扰，关掉面板也不会丢
    [jdText, setJdText] = useState(() => loadJd(docId)),
    [jdStage, setJdStage] = useState<"idle" | "analyzing" | "choosing" | "writing">(
      "idle",
    ),
    [analysis, setAnalysis] = useState<JdAnalysis | null>(null),
    [direction, setDirection] = useState(""),
    [jdDone, setJdDone] = useState<{
      before: Resume;
      summary: string;
      gaps: string[];
    } | null>(null),
    [running, setRunning] = useState(false),
    [percent, setPercent] = useState(0),
    [layoutResult, setLayoutResult] = useState<{
      before: Resume;
      after: Resume;
      total: number;
    } | null>(null),
    [turns, setTurns] = useState<AgentTurn[]>(() => loadTurns(docId)),
    [summary, setSummary] = useState<AgentSummary>(() => loadSummary(docId)),
    [pending, setPending] = useState<{
      actions: AgentAction[];
      notes: string[];
      skipped: string[];
      turnAt: number;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false),
    [testResult, setTestResult] = useState(""),
    [error, setError] = useState("");
  const [pos, setPos] = useState(() => ({
    x: Math.max(12, window.innerWidth - 400),
    y: 96,
  }));
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, pending, busy, error]);

  useEffect(() => {
    try {
      localStorage.setItem(turnsKey(docId), JSON.stringify(turns));
    } catch {
      /* 存不下也不影响使用 */
    }
  }, [turns, docId]);

  useEffect(() => {
    try {
      if (summary.text || summary.count)
        localStorage.setItem(summaryKey(docId), JSON.stringify(summary));
      else localStorage.removeItem(summaryKey(docId));
    } catch {
      /* 存不下不影响使用 */
    }
  }, [summary, docId]);

  useEffect(() => {
    try {
      if (jdText.trim()) localStorage.setItem(jdKey(docId), jdText);
      else localStorage.removeItem(jdKey(docId));
    } catch {
      /* 存不下不影响使用 */
    }
  }, [jdText, docId]);

  const drag = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement,
      base = pos,
      startX = e.clientX,
      startY = e.clientY;
    handle.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) =>
      setPos({
        x: Math.max(
          8,
          Math.min(window.innerWidth - 140, base.x + event.clientX - startX),
        ),
        y: Math.max(
          8,
          Math.min(window.innerHeight - 80, base.y + event.clientY - startY),
        ),
      });
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const save = () => {
    const next: AgentConfig = {
      baseUrl: draft.baseUrl.trim() || "https://api.openai.com/v1",
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    };
    saveAgentConfig(next);
    setConfig(next);
    if (agreed) acceptNotice();
    setSetupOpen(false);
    setError("");
  };

  const test = async () => {
    setTesting(true);
    setTestResult("");
    try {
      const reply = await requestAgent(
        {
          baseUrl: draft.baseUrl.trim() || "https://api.openai.com/v1",
          model: draft.model.trim(),
          apiKey: draft.apiKey.trim(),
        },
        "你是连通性测试，只回复 ok。",
        [],
        "ping",
      );
      setTestResult(`连接正常（模型回复：${reply.reply.slice(0, 20)}）`);
    } catch (e) {
      setTestResult(`连接失败：${errorText(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const askModel = async (
    system: string,
    history: AgentTurn[],
    question: string,
    signal: AbortSignal,
  ) => {
    const first = await requestAgent(config, system, history, question, signal);
    if (first.actions.length) return first;
    const retry = await requestAgent(
      config,
      system + "\n\n重要：必须只输出一个 JSON 对象，并在 actions 里给出动作数组。",
      history,
      question +
        "\n（只输出 JSON；如果确实不需要任何排版改动，actions 返回空数组，并在 reply 里说明原因。）",
      signal,
    );
    return retry.actions.length ? retry : first;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!config.apiKey.trim() || !config.model.trim()) {
      setSetupOpen(true);
      setError("先填好接口地址、模型名和 Key，再点保存。");
      return;
    }
    setBusy(true);
    setError("");
    // 上一版方案还没被接受就又问新问题 → 记成“没接受”，方便模型理解上下文
    if (pending) markRejected(pending.turnAt);
    setPending(null);
    onClearPreview();
    // 先把用户这句话和“正在生成”放上去，再去请求
    setInput("");
    setTurns((all) => [...all, { role: "user", text }]);
    const history = turns;
    const digest = changesDigest(history);
    const assistantAt = history.length + 1;
    const system =
      AGENT_SYSTEM_PROMPT +
      AGENT_CONTENT_PROMPT +
      (digest.length
        ? "\n\n本次会话里你已经应用过的改动（从旧到新，可作为“再紧一点”这类相对要求的基准）：\n" +
          digest.map((d, i) => `${i + 1}. ${d}`).join("\n")
        : "") +
      "\n\n当前简历参数与正文：\n" +
      describeDoc(doc, pageCount, true);
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 90000);
    try {
      // 超过上下文预算就把最早的对话压成摘要，只带摘要 + 最近几条继续聊
      let active = summary,
        recent = history;
      if (config.apiKey.trim() && config.model.trim()) {
        try {
          const packed = await compactHistory(
            config,
            system,
            text,
            history,
            summary,
            controller.signal,
          );
          if (packed.compacted) {
            active = packed.summary;
            setSummary(active);
          }
          recent = history.slice(active.count);
        } catch {
          /* 摘要失败就按原样发送 */
        }
      }
      const withMemory = active.text
        ? `${system}\n\n早前对话摘要：\n${active.text}`
        : system;
      const reply = await askModel(withMemory, recent, text, controller.signal);
      setTurns((all) => [
        ...all,
        { role: "assistant", text: reply.reply },
      ]);
      if (reply.actions.length) {
        const applied = applyAgentActions(doc, reply.actions);
        setPending({
          actions: reply.actions,
          notes: applied.notes,
          skipped: applied.skipped,
          turnAt: assistantAt,
        });
        if (applied.notes.length) onPreview(applied.doc);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
    }
  };

  const markApplied = (at: number, notes: string[]) => {
    if (at < 0) return;
    setTurns((all) =>
      all.map((turn, index) =>
        index === at ? { ...turn, notes, rejected: undefined } : turn,
      ),
    );
  };
  const markRejected = (at: number) => {
    if (at < 0) return;
    setTurns((all) =>
      all.map((turn, index) =>
        index === at ? { ...turn, rejected: true, notes: undefined } : turn,
      ),
    );
  };

  const accept = () => {
    if (!pending) return;
    // 按当前文档重算，避免中途改过内容被旧快照覆盖
    const fresh = applyAgentActions(doc, pending.actions);
    onApply(fresh.doc);
    markApplied(pending.turnAt, fresh.notes);
    onClearPreview();
    registerPreviewApi(null);
    setPending(null);
  };
  const reject = () => {
    if (!pending) return;
    markRejected(pending.turnAt);
    onClearPreview();
    registerPreviewApi(null);
    setPending(null);
  };

  const apiRef = useRef({ accept, reject });
  apiRef.current = { accept, reject };
  useEffect(() => {
    registerPreviewApi(
      pending
        ? {
            accept: () => apiRef.current.accept(),
            reject: () => apiRef.current.reject(),
          }
        : null,
    );
  }, [pending, registerPreviewApi]);

  const pasteInfo = useMemo(() => {
    if (!pasteText.trim()) return { count: 0, error: "" };
    try {
      return { count: textToLines(pasteText).length, error: "" };
    } catch (e) {
      return {
        count: 0,
        error: e instanceof Error ? e.message : "这段内容读不出来",
      };
    }
  }, [pasteText]);
  const wait = (ms: number) =>
    new Promise((resolve) => window.setTimeout(resolve, ms));
  // 一键排版：分几步跑给用户看，最后直接写进简历（不再问接受与否）
  const runLayout = async () => {
    const text = pasteText.trim();
    if (!text || running) return;
    setError("");
    setLayoutResult(null);
    setRunning(true);
    setPercent(6);
    const before = doc;
    try {
      const stages = Array.from(layoutSteps(text));
      let last = doc;
      for (let index = 0; index < stages.length; index++) {
        await wait(260);
        last = { ...doc, lines: stages[index].lines };
        // 本地几步走到 66%，剩下的留给 AI 复核
        setPercent(8 + Math.round(((index + 1) / stages.length) * 58));
      }

      if (config.apiKey.trim() && config.model.trim()) {
        setPercent(70);
        const controller = new AbortController(),
          timeout = window.setTimeout(() => controller.abort(), 60000),
          // 等接口的时候让进度慢慢爬，不要卡死在 70%
          ticker = window.setInterval(
            () => setPercent((value) => (value < 92 ? value + 1 : value)),
            320,
          );
        try {
          // 和对话里「帮我把格式调好」完全同一套动作：排版和文字都能改
          const reply = await reviewLayout(
            config,
            last,
            text,
            controller.signal,
          );
          const actions = reply.actions.filter((action) =>
            isReviewAction(String(action.type)),
          );
          if (actions.length) {
            const applied = applyAgentActions(last, actions);
            if (applied.notes.length) last = applied.doc;
          }
        } catch {
          /* 复核失败就用本地结果 */
        } finally {
          window.clearInterval(ticker);
          window.clearTimeout(timeout);
        }
      }

      setPercent(96);
      await wait(220);
      onApply(last);
      setPercent(100);
      setLayoutResult({ before, after: last, total: last.lines.length });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };
  const undoLayout = () => {
    if (!layoutResult) return;
    onApply(layoutResult.before);
    setLayoutResult(null);
  };

  const clear = () => {
    setTurns([]);
    setSummary({ text: "", count: 0 });
    setPending(null);
    setError("");
    setTestResult("");
  };

  // ---- 按 JD 优化 ----
  const jdReady = Boolean(config.apiKey.trim() && config.model.trim());

  const runJd = async (wanted: string) => {
    const jd = jdText.trim();
    if (!jd || jdStage === "analyzing" || jdStage === "writing") return;
    if (!jdReady) {
      setSetupOpen(true);
      setError("先填好接口地址、模型名和 Key，再点保存。");
      return;
    }
    setError("");
    setJdStage(wanted ? "writing" : "analyzing");
    // 上一版还没接受就开始新的一轮 → 先清掉待确认状态，避免串台
    if (pending) {
      markRejected(pending.turnAt);
      setPending(null);
      onClearPreview();
    }
    const before = doc;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 120000);
    try {
      const reply = await matchResumeToJd(
        config,
        doc,
        pageCount,
        jd,
        wanted,
        controller.signal,
      );
      if (!wanted) {
        setAnalysis(reply.analysis ?? null);
        setDirection("");
        setJdStage("choosing");
        if (!reply.analysis)
          setError("模型没有返回岗位分析，可以再点一次「分析这个岗位」。");
        return;
      }
      // 模型有时只写一句「我改好了」却不给动作，和对话一样补一次提醒
      let result = reply;
      if (!result.actions.length) {
        try {
          result = await matchResumeToJd(
            config,
            doc,
            pageCount,
            jd,
            `${wanted}\n（上一次你只回了文字，没有给 actions。这次必须给出 setText 等动作，line 用正文列表里的行号。）`,
            controller.signal,
          );
        } catch {
          /* 补试失败就用第一次的结果 */
        }
      }
      if (result.actions.length) {
        const applied = applyAgentActions(doc, result.actions);
        // 走和对话一样的「先预览、再接受」流程，不直接改简历
        setPending({
          actions: result.actions,
          notes: applied.notes,
          skipped: applied.skipped,
          turnAt: -1,
        });
        if (applied.notes.length) onPreview(applied.doc);
        setJdDone({
          before,
          // 以「实际执行结果」为准，不能直接信模型的自述：
          // 模型常常说「改了 3 处」，实际动作一条都没落地
          summary: applied.notes.length
            ? result.reply || `按 JD 调整了 ${applied.notes.length} 处`
            : "这次没能落地任何改动，原因见下方。可以换个说法再说一次，或直接在左边手动改。",
          gaps: (result.analysis ?? analysis)?.gaps ?? [],
        });
      } else {
        setJdDone({
          before,
          summary:
            result.reply || "按当前简历内容，已经没有可以进一步贴合的地方了。",
          gaps: (result.analysis ?? analysis)?.gaps ?? [],
        });
      }
      setJdStage("choosing");
    } catch (e) {
      setError(errorText(e));
      setJdStage(analysis ? "choosing" : "idle");
    } finally {
      window.clearTimeout(timer);
    }
  };

  const undoJd = () => {
    if (!jdDone) return;
    onApply(jdDone.before);
    setJdDone(null);
    onClearPreview();
    registerPreviewApi(null);
    setPending(null);
  };

  const resetJd = () => {
    setAnalysis(null);
    setDirection("");
    setJdStage("idle");
    setJdDone(null);
    setError("");
  };

  return (
    <div
      className={`agent-panel${docked ? " agent-docked" : ""}`}
      style={docked ? undefined : { left: pos.x, top: pos.y }}
      aria-label="排版助手"
    >
      <header
        className="agent-head"
        onPointerDown={docked ? undefined : drag}
        style={docked ? { cursor: "default" } : undefined}
      >
        <Sparkles size={16} />
        <b>排版助手</b>
        <span className="agent-sub">
          {docked ? "占用样式面板，改完自动切回" : "能改排版，也能改文字"}
        </span>
        <div className="agent-tools">
          <button aria-label="清空对话" title="清空对话" onClick={clear}>
            <Eraser size={15} />
          </button>
          <button
            aria-label="接口设置"
            title="接口设置"
            onClick={() => setSetupOpen(!setupOpen)}
          >
            <Settings2 size={15} />
          </button>
          <button aria-label="关闭排版助手" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>

      {setupOpen && (
        <section className="agent-setup">
          <label>
            <span>接口地址</span>
            <input
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
          </label>
          <label>
            <span>模型名</span>
            <input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="agent-agree">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              我了解：点发送时，<b>排版参数、板块标题和简历正文</b>
              会发送到上面的地址，以便它改写内容。Key 只存在本机浏览器。
            </span>
          </label>
          <div className="agent-setup-actions">
            <button disabled={testing || !draft.model} onClick={() => void test()}>
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button className="primary" disabled={!agreed} onClick={save}>
              保存并启用
            </button>
          </div>
          {testResult && <p className="agent-skip">{testResult}</p>}
        </section>
      )}

      <div className="agent-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "chat"}
          className={tab === "chat" ? "active" : ""}
          onClick={() => setTab("chat")}
        >
          对话
        </button>
        <button
          role="tab"
          aria-selected={tab === "jd"}
          className={tab === "jd" ? "active" : ""}
          onClick={() => setTab("jd")}
        >
          按 JD 优化
        </button>
        <button
          role="tab"
          aria-selected={tab === "paste"}
          className={tab === "paste" ? "active" : ""}
          onClick={() => setTab("paste")}
        >
          一键排版
        </button>
      </div>

      {tab === "chat" ? (
        <div className="agent-log" ref={logRef}>
          {!turns.length && (
            <div className="agent-empty">
              <Bot size={18} />
              <p>
                用一句话说清楚你想怎么排，我会先给出改动清单，你确认后才生效。
              </p>
              <div className="agent-chips">
                {EXAMPLES.map((example) => (
                  <button key={example} onClick={() => setInput(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, index) => (
            <div key={index} className={`agent-msg ${turn.role}`}>
              {turn.text}
            </div>
          ))}
          {busy && (
            <div className="agent-msg assistant agent-thinking">
              正在生成排版方案…
            </div>
          )}
        </div>
      ) : tab === "jd" ? (
        <div className="agent-jd">
          <label className="agent-jd-label">
            <span>把招聘 JD 粘贴到这里</span>
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value.slice(0, JD_MAX))}
              disabled={jdStage === "analyzing" || jdStage === "writing"}
              spellCheck={false}
              placeholder={"岗位名称、职责、任职要求都可以整段贴进来，贴多点分析更准"}
              aria-label="粘贴招聘 JD"
              rows={6}
            />
          </label>
          <div className="agent-paste-actions">
            <span className="agent-paste-count">
              {jdText.trim()
                ? `${jdText.trim().length} 字`
                : "等待粘贴"}
            </span>
            <button
              className="primary"
              disabled={
                !jdText.trim() ||
                jdStage === "analyzing" ||
                jdStage === "writing"
              }
              onClick={() => void runJd("")}
            >
              {jdStage === "analyzing" ? "分析中…" : "分析这个岗位"}
            </button>
          </div>

          {analysis && (
            <section className="agent-jd-card">
              <strong>{analysis.role || "目标岗位"}</strong>
              {analysis.musts.length > 0 && (
                <>
                  <p className="agent-jd-sub">岗位要什么</p>
                  <ul className="agent-jd-list">
                    {analysis.musts.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {analysis.matched.length > 0 && (
                <>
                  <p className="agent-jd-sub good">你简历里已经对上的</p>
                  <ul className="agent-jd-list good">
                    {analysis.matched.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {analysis.gaps.length > 0 && (
                <>
                  <p className="agent-jd-sub gap">还差一些 / 写得不够</p>
                  <ul className="agent-jd-list gap">
                    {analysis.gaps.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {analysis.advice && (
                <p className="agent-skip">建议：{analysis.advice}</p>
              )}
            </section>
          )}

          {analysis && (
            <div className="agent-jd-actions">
              <button
                className="primary"
                disabled={jdStage === "writing" || jdStage === "analyzing"}
                onClick={() =>
                  void runJd(
                    direction.trim() ||
                      "按上面的分析，把简历改得更贴合这个岗位",
                  )
                }
              >
                {jdStage === "writing" ? "改写中…" : "按这个方向改写"}
              </button>
              <button
                disabled={jdStage === "writing" || jdStage === "analyzing"}
                onClick={() => void runJd("")}
              >
                重新分析
              </button>
            </div>
          )}

          {analysis && (
            <label className="agent-jd-label">
              <span>想怎么改？可以补充一句（不填就按上面的建议改）</span>
              <input
                value={direction}
                onChange={(e) => setDirection(e.target.value.slice(0, 200))}
                placeholder="例如：重点突出数据成果，别动教育背景"
                spellCheck={false}
              />
            </label>
          )}

          {jdDone && (
            <div className="agent-done">
              <div className="agent-jd-done">
                <span>{jdDone.summary}</span>
                {jdDone.gaps.length > 0 && (
                  <span className="agent-jd-gaps">
                    简历里还缺：{jdDone.gaps.join("；")}
                    （这些不会编，确实做过就自己补一条）
                  </span>
                )}
              </div>
              <div className="agent-done-actions">
                <button onClick={resetJd} title="重新贴 JD">
                  换 JD
                </button>
                <button onClick={undoJd} title="回到改写前的样子">
                  撤销
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="agent-paste">
          <p className="agent-paste-hint">将简历文字内容粘贴即可一键排版</p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            disabled={running}
            spellCheck={false}
            aria-label="粘贴整份简历"
          />
          <div className="agent-paste-actions">
            <span className="agent-paste-count">
              {pasteInfo.error
                ? pasteInfo.error
                : pasteInfo.count
                  ? `识别到 ${pasteInfo.count} 行`
                  : pasteText.trim()
                    ? "还没识别出内容"
                    : "等待粘贴"}
            </span>
            <button
              className="primary"
              disabled={!pasteInfo.count || running}
              onClick={() => void runLayout()}
            >
              {running ? "排版中…" : "开始排版"}
            </button>
          </div>
          {running && (
            <div
              className="agent-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span className="agent-progress-track">
                <i style={{ width: `${percent}%` }} />
              </span>
              <span className="agent-progress-text">正在排版… {percent}%</span>
            </div>
          )}
          {layoutResult && !running && (
            <div className="agent-done">
              <span>
                已排好 {layoutResult.total} 行
                {doc === layoutResult.after ? "" : "（内容已改动，撤销会一起还原）"}
              </span>
              <button
                onClick={undoLayout}
                title="回到排版前的样子"
              >
                撤销排版
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="agent-error agent-error-outside">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {pending && (
        <div className="agent-plan">
          {pending.notes.length ? (
            <>
              <strong>将要改动 {pending.notes.length} 项</strong>
              <ul>
                {pending.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              {pending.actions.filter((a) => a.type === "remove").length >
                0 && (
                <p className="agent-warn">
                  注意：这次会删掉{" "}
                  {pending.actions.filter((a) => a.type === "remove").length}{" "}
                  行内容，看清楚再接受。
                </p>
              )}
              {pending.actions.some((a) => a.type === "setContent") && (
                <p className="agent-warn">
                  注意：这次会整篇替换内容，原来的文字会全部换掉（接受后仍可按
                  Ctrl+Z 撤销）。
                </p>
              )}
              {pending.skipped.length > 0 && (
                <p className="agent-skip">
                  已跳过：{pending.skipped.join("；")}
                </p>
              )}
              <div className="agent-plan-actions">
                <button className="primary" onClick={accept}>
                  接受
                </button>
                <button onClick={reject}>不接受</button>
              </div>
            </>
          ) : (
            <p className="agent-skip">
              这次没有可执行的排版改动
              {pending.skipped.length ? "：" + pending.skipped.join("；") : "。"}
            </p>
          )}
        </div>
      )}

      {tab === "chat" && (
        <form
          className="agent-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="例如：内容太挤了，帮我排得清爽一点"
            rows={Math.min(6, Math.max(2, input.split("\n").length))}
            aria-label="告诉助手你想怎么排"
          />
          <button type="submit" disabled={busy || !input.trim()} aria-label="发送">
            <Send size={15} />
          </button>
        </form>
      )}
    </div>
  );
}
