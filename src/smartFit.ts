import { defaultSettings } from "./flow";
import type { Line, Settings } from "./flow";

/**
 * 「智能一页」：把全文的松紧度调成「刚好一页」。
 *
 * 只动排版参数 —— 各类内容的字号、上下间距、行距。不动正文、不动页边距、
 * 不动经历行的分栏比例，所以最坏的结果只是「排得比原来紧/松」，
 * 撤销一下就回去了，不会丢内容。
 *
 * 做法：把「整体松紧度 s」映射成一套具体参数（字号 s^0.55、间距 s^1.6、
 * 行距 s^0.3），s 越大越松。内容高度随 s 单调递增，于是对 s 做二分，
 * 找出「还塞得下一页」的最大 s。压缩和放大是同一套逻辑，不用写两遍。
 *
 * 间距的指数比字号大：收紧时先牺牲空白、尽量保住正文大小；
 * 放大时优先把空白撑开，字不会一味变大。
 */

/** 用真实 DOM 量一行的高度（由调用方注入，测试里换成假的） */
export type Measure = (
  settings: Settings,
  line: Line,
  text: string,
  continued: boolean,
) => number;

/**
 * 参照排版：所有上下限都以「默认排版」为锚，而不是以「当前值」为锚。
 *
 * 一开始我按当前值算 0.75~1.34 倍，结果连点两次：正文字号 13 → 17.4 → 20.1，
 * 越点越大。锚定在默认值上，就永远是 9.75~17.42 这个绝对区间，点几次都一样。
 *
 * 当前值本身超出区间时（用户自己把字调大了），把当前值也算进边界：
 * 绝不会因为「智能一页」反而把用户特意调大的字缩小。
 */
const REFERENCE = defaultSettings();

const range = (current: number, ref: number, loK: number, hiK: number) =>
  [Math.min(current, ref * loK), Math.max(current, ref * hiK)] as const;

/** 已经占到一页的 95%，就算排满了，不再折腾用户 */
export const FULL_ENOUGH = 0.95;

/** 留 0.5% 余量：测量和真实排版之间可能有零点几像素的差 */
const SAFE = 0.995;

/** 松紧度的搜索区间。两端都已经顶到上下限，再往外取没有意义 */
const S_MIN = 0.28;
const S_MAX = 2.6;

/**
 * 参数的取整步长：字号和间距都取到 0.1px，行距 0.01。
 * 步长太粗会白扔版面 —— 一行 0.5px 的差，六十行就是三四十像素。
 */
const STEPS = { size: 0.1, gap: 0.1, line: 0.01 };

/** 二分次数：撑到 0.1% 的分辨率，再多只是白量一遍 DOM */
const ROUNDS = 14;

const TYPES = (s: Settings) =>
  Object.keys(s.types) as (keyof Settings["types"])[];

const clamp = (n: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, n));

/**
 * 向下取整到步长。之所以一律向下，是为了保证取整后的结果不会比搜索时
 * 量过的那套更高 —— 否则最后一行会被挤到第二页。
 */
const snap = (n: number, step: number) => {
  const v = Math.floor(n / step + 1e-9) * step;
  return Math.round(v * 100) / 100;
};

/** 把整体松紧度 s 换算成一套具体排版参数：s > 1 更松，s < 1 更紧 */
export function scaleSettings(base: Settings, s: number): Settings {
  const sizeK = s ** 0.55;
  const gapK = s ** 1.6;
  const lineK = s ** 0.3;
  const types = { ...base.types };
  for (const key of TYPES(base)) {
    const t = base.types[key];
    const ref = REFERENCE.types[key];
    types[key] = {
      size: snap(clamp(t.size * sizeK, range(t.size, ref.size, 0.75, 1.34)), STEPS.size),
      before: snap(
        clamp(t.before * gapK, range(t.before, ref.before, 0.15, 4)),
        STEPS.gap,
      ),
      after: snap(
        clamp(t.after * gapK, range(t.after, ref.after, 0.15, 4)),
        STEPS.gap,
      ),
    };
  }
  const refLine = REFERENCE.lineHeight;
  return {
    ...base,
    lineHeight: Math.max(
      1.05,
      snap(
        clamp(base.lineHeight * lineK, range(base.lineHeight, refLine, 0.86, 1.12)),
        STEPS.line,
      ),
    ),
    types,
  };
}

export type FitState = "empty" | "done" | "shrunk" | "grown" | "maxed" | "over";

export interface SmartFit {
  /** 要应用到文档上的排版参数；state 为 done / empty 时原样返回 */
  settings: Settings;
  state: FitState;
  /** 是否真的改动了参数（false 时调用方不要写回文档，免得白占一格撤销） */
  changed: boolean;
  /** 调整前内容占一页的比例：> 1 表示溢出 */
  before: number;
  /** 调整后内容占一页的比例 */
  after: number;
  /** 压到最紧还占几页，只有 state === "over" 时有意义 */
  still: number;
  sizeChanged: boolean;
  gapChanged: boolean;
  lineChanged: boolean;
}

function diff(base: Settings, next: Settings) {
  const keys = TYPES(base);
  return {
    sizeChanged: keys.some((k) => base.types[k].size !== next.types[k].size),
    gapChanged: keys.some(
      (k) =>
        base.types[k].before !== next.types[k].before ||
        base.types[k].after !== next.types[k].after,
    ),
    lineChanged: Math.abs(base.lineHeight - next.lineHeight) > 1e-6,
  };
}

/**
 * 算出「刚好一页」的排版参数。
 *
 * 判定标准：所有非空行的高度加起来不超过一页的可用高度。这等价于
 * paginate() 只产生一页 —— 一旦总量不超过容量，paginate 里的 next()
 * 就永远不会被触发。
 */
export function fitOnePage(
  base: Settings,
  lines: Line[],
  pageHeight: number,
  measure: Measure,
): SmartFit {
  const live = lines.filter((line) => line.kind !== "blank");
  // 页边距不在调整范围内，所以可用高度是固定的
  const capacity = pageHeight - base.top - base.bottom;

  const report = (
    state: FitState,
    settings: Settings,
    before: number,
    after: number,
    still = 0,
  ): SmartFit => {
    const d = diff(base, settings);
    return {
      settings,
      state,
      changed: d.sizeChanged || d.gapChanged || d.lineChanged,
      before,
      after,
      still,
      ...d,
    };
  };

  if (!live.length || capacity <= 0) return report("empty", base, 0, 0);

  const heightAt = (s: number) => {
    const settings = scaleSettings(base, s);
    let total = 0;
    for (const line of live) total += measure(settings, line, line.text, false);
    return { settings, total };
  };

  const original = heightAt(1);
  const before = original.total / capacity;

  // 已经是一页、而且排得挺满：不动，免得用户点一下反而变丑
  if (before <= 1 && before >= FULL_ENOUGH)
    return report("done", base, before, before);

  // 压到最紧还是一页放不下 —— 这是内容真的太多，不是排版问题
  const tightest = heightAt(S_MIN);
  if (tightest.total > capacity * SAFE) {
    const ratio = tightest.total / capacity;
    return report("over", tightest.settings, before, ratio, ratio);
  }

  let best = heightAt(S_MAX);
  // 撑到上限都塞不满一页：说明内容太少，不是排版问题
  const atCeiling = best.total <= capacity * SAFE;
  if (!atCeiling) {
    let lo = S_MIN,
      hi = S_MAX;
    for (let i = 0; i < ROUNDS; i++) {
      // 按几何中值切分：s 是乘性参数，等比二分收敛更均匀
      const mid = Math.sqrt(lo * hi);
      if (heightAt(mid).total <= capacity * SAFE) lo = mid;
      else hi = mid;
    }
    best = heightAt(lo);
  }

  const after = best.total / capacity;
  // 走到这里 before 必然 < FULL_ENOUGH：要么本来就不到一页（放大），
  // 要么超过一页（收紧）。撑到顶还没填满时单独报 maxed，不能谎称「撑满一页」
  const state: FitState =
    before > 1 ? "shrunk" : atCeiling && after < FULL_ENOUGH ? "maxed" : "grown";
  const result = report(state, best.settings, before, after);
  // 参数取整后跟原来一模一样：如实说不用调，不装作改过
  if (result.changed) return result;
  return report(state === "maxed" ? "maxed" : "done", base, before, before);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** 把结果翻成一句人话，给界面上的提示条用 */
export function describeFit(fit: SmartFit): string {
  const to = fit.settings.types.text.size;
  const grow = fit.state === "grown";
  const parts: string[] = [];
  if (fit.sizeChanged)
    parts.push(`正文字号${grow ? "放大到" : "收到"} ${to}px`);
  if (fit.lineChanged)
    parts.push(`行距${grow ? "放到" : "收到"} ${fit.settings.lineHeight}`);
  if (fit.gapChanged) parts.push(grow ? "段落间距拉开" : "段落间距收紧");

  switch (fit.state) {
    case "empty":
      return "简历还是空的，先写点内容再点。";
    case "done":
      return fit.before > 1
        ? `已经压到最紧了，现在还有 ${fit.before.toFixed(1)} 页，建议删掉一些内容。`
        : `内容已经排到一页的 ${pct(fit.before)}，不用再调。`;
    case "grown":
      return `内容原来只占一页的 ${pct(fit.before)}，已把${parts.join("、")}，现在撑满一页。`;
    case "maxed":
      return `内容太少，已经放到最大（正文 ${to}px、行距 ${fit.settings.lineHeight}），也只占一页的 ${pct(
        fit.after,
      )}。再加点内容就能填满。`;
    case "shrunk":
      return `内容原来有 ${fit.before.toFixed(1)} 页，已把${parts.join("、")}，现在正好一页。`;
    case "over":
      return `内容实在太多：已经压到正文 ${to}px、行距 ${fit.settings.lineHeight}，还是差 ${pct(
        Math.max(0, fit.still - 1),
      )} 页。建议删掉几条要点，或把长句改短。`;
  }
}
