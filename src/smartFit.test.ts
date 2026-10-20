import { describe, expect, it } from "vitest";
import { defaultSettings } from "./flow";
import type { Kind, Line, Settings } from "./flow";
import { describeFit, fitOnePage, scaleSettings } from "./smartFit";

/**
 * 假的高度测量：一行的高度 ≈ 字号 × 行距 + 上下间距。
 * 真实排版还有折行，但只要「高度随松紧度单调递增」，二分的正确性就不依赖折行。
 */
const fakeMeasure = (s: Settings, line: Line) => {
  const t = s.types[line.kind === "blank" ? "text" : line.kind];
  return t.size * s.lineHeight + t.before + t.after;
};

const PAGE_HEIGHT = 1123;

const lines = (kind: Kind, count: number): Line[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${kind}-${i}`,
    kind,
    text: `第 ${i + 1} 条要点`,
  }));

const capacity = (s: Settings) => PAGE_HEIGHT - s.top - s.bottom;

describe("智能一页：压紧", () => {
  it("一页多的时候收紧到一页，且不留到第二页", () => {
    const base = defaultSettings();
    const doc = lines("bullet", 60);
    const at = doc.reduce((sum, l) => sum + fakeMeasure(base, l), 0);
    expect(at / capacity(base)).toBeGreaterThan(1); // 前提：确实超过一页

    const fit = fitOnePage(base, doc, PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("shrunk");
    expect(fit.changed).toBe(true);
    const after = doc.reduce((sum, l) => sum + fakeMeasure(fit.settings, l), 0);
    expect(after).toBeLessThanOrEqual(capacity(fit.settings));
    // 又不至于收得太多：至少用到九成八的页面
    expect(after / capacity(fit.settings)).toBeGreaterThan(0.98);
  });

  it("先压空白、再压字：书面的字号不会掉太狠", () => {
    const base = defaultSettings();
    // 只超一成左右，靠挤间距基本就够，字号不该接近下限
    const fit = fitOnePage(base, lines("bullet", 55), PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("shrunk");
    expect(fit.settings.types.text.size).toBeGreaterThan(base.types.text.size * 0.85);
  });

  it("内容多到怎么压都放不下时，如实报 over", () => {
    const base = defaultSettings();
    const fit = fitOnePage(base, lines("bullet", 200), PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("over");
    expect(fit.still).toBeGreaterThan(1);
    // 即使放不下，也要给出已经压到最紧的那套参数
    expect(fit.changed).toBe(true);
    expect(describeFit(fit)).toContain("还是差");
  });
});

describe("智能一页：撑满", () => {
  it("只有半页时放大字号 / 拉开间距", () => {
    const base = defaultSettings();
    const doc = lines("bullet", 30);
    const fit = fitOnePage(base, doc, PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("grown");
    expect(fit.changed).toBe(true);
    // 撑到接近满页但不越界
    const after = doc.reduce((sum, l) => sum + fakeMeasure(fit.settings, l), 0);
    expect(after).toBeLessThanOrEqual(capacity(fit.settings));
    expect(after / capacity(fit.settings)).toBeGreaterThan(0.98);
    expect(fit.settings.types.text.size).toBeGreaterThan(base.types.text.size);
  });

  it("内容太少时最多撑到上限，并如实说「放到最大了」", () => {
    const base = defaultSettings();
    const fit = fitOnePage(base, lines("bullet", 3), PAGE_HEIGHT, fakeMeasure);
    // 三条要点再怎么放大也填不满一页，不能谎称「撑满一页」
    expect(fit.state).toBe("maxed");
    expect(describeFit(fit)).toContain("放到最大");
    expect(fit.settings.types.text.size).toBeLessThanOrEqual(
      base.types.text.size * 1.34,
    );
    expect(fit.settings.lineHeight).toBeLessThanOrEqual(base.lineHeight * 1.12);
    expect(fit.after).toBeLessThan(1);
  });

  it("放到最大之后再点，不会一次比一次大", () => {
    const base = defaultSettings();
    const doc = lines("bullet", 3);
    const first = fitOnePage(base, doc, PAGE_HEIGHT, fakeMeasure);
    // 以前这里按「当前值的 1.34 倍」算上限，于是 13 → 17.4 → 20.1 → 26.9 一路涨
    const second = fitOnePage(first.settings, doc, PAGE_HEIGHT, fakeMeasure);
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it("已经排得很满的一页不动，免得点一下反而变丑", () => {
    const base = defaultSettings();
    // 找一份刚好占 97% 左右的内容
    const count = Math.round((capacity(base) * 0.97) / fakeMeasure(base, lines("bullet", 1)[0]));
    const fit = fitOnePage(base, lines("bullet", count), PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("done");
    expect(fit.changed).toBe(false);
    expect(fit.settings).toBe(base);
  });
});

describe("智能一页：边界", () => {
  it("空简历不报错，也不改参数", () => {
    const base = defaultSettings();
    const fit = fitOnePage(base, [], PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("empty");
    expect(fit.changed).toBe(false);
    expect(describeFit(fit)).toContain("空");
  });

  it("空行不参与计算，不影响结果", () => {
    const base = defaultSettings();
    const doc = lines("bullet", 30);
    const withBlanks: Line[] = [];
    for (const [i, line] of doc.entries()) {
      withBlanks.push(line);
      if (i % 3 === 0)
        withBlanks.push({ id: `blank-${i}`, kind: "blank", text: "" });
    }
    const a = fitOnePage(base, doc, PAGE_HEIGHT, fakeMeasure);
    const b = fitOnePage(base, withBlanks, PAGE_HEIGHT, fakeMeasure);
    expect(b.settings).toEqual(a.settings);
    expect(b.after).toBeCloseTo(a.after, 6);
  });

  it("点第二次不会继续收紧（幂等）", () => {
    const base = defaultSettings();
    const doc = lines("bullet", 60);
    const first = fitOnePage(base, doc, PAGE_HEIGHT, fakeMeasure);
    const second = fitOnePage(first.settings, doc, PAGE_HEIGHT, fakeMeasure);
    expect(second.state).toBe("done");
    expect(second.changed).toBe(false);
    expect(second.settings).toBe(first.settings);
  });

  it("页边距被撑爆时退回 empty，不除零", () => {
    const base = { ...defaultSettings(), top: 600, bottom: 600 };
    const fit = fitOnePage(base, lines("bullet", 3), PAGE_HEIGHT, fakeMeasure);
    expect(fit.state).toBe("empty");
    expect(Number.isFinite(fit.before)).toBe(true);
  });
});

describe("scaleSettings", () => {
  const base = defaultSettings();

  it("s = 1 时原样返回", () => {
    expect(scaleSettings(base, 1)).toEqual(base);
  });

  it("各档参数都夹在可读范围内", () => {
    for (const s of [0, 0.1, 0.28, 0.5, 1, 2, 2.6, 99]) {
      const next = scaleSettings(base, s);
      for (const kind of Object.keys(next.types) as (keyof Settings["types"])[]) {
        expect(next.types[kind].size).toBeGreaterThanOrEqual(
          base.types[kind].size * 0.75 - 0.11,
        );
        expect(next.types[kind].size).toBeLessThanOrEqual(
          base.types[kind].size * 1.34,
        );
        expect(next.types[kind].before).toBeGreaterThanOrEqual(0);
        expect(next.types[kind].after).toBeGreaterThanOrEqual(0);
      }
      expect(next.lineHeight).toBeGreaterThanOrEqual(1.05);
      expect(next.lineHeight).toBeLessThanOrEqual(base.lineHeight * 1.12);
    }
  });

  it("单调：越往上撑，字号和间距都不会变小", () => {
    let prev = scaleSettings(base, 0.4);
    for (const s of [0.5, 0.7, 0.9, 1.1, 1.4, 1.8, 2.2]) {
      const next = scaleSettings(base, s);
      expect(next.types.bullet.size).toBeGreaterThanOrEqual(prev.types.bullet.size);
      expect(next.types.bullet.before).toBeGreaterThanOrEqual(
        prev.types.bullet.before,
      );
      expect(next.lineHeight).toBeGreaterThanOrEqual(prev.lineHeight);
      prev = next;
    }
  });

  it("不动页边距和分栏，只动排版参数", () => {
    const next = scaleSettings(base, 0.5);
    expect(next.top).toBe(base.top);
    expect(next.bottom).toBe(base.bottom);
    expect(next.left).toBe(base.left);
    expect(next.right).toBe(base.right);
    expect(next.entrySplit).toEqual(base.entrySplit);
  });
});

describe("describeFit 文案", () => {
  const base = defaultSettings();

  it("收紧时说清楚原来几页、改了什么", () => {
    const fit = fitOnePage(base, lines("bullet", 60), PAGE_HEIGHT, fakeMeasure);
    const text = describeFit(fit);
    expect(text).toMatch(/原来有 \d\.\d 页/);
    expect(text).toContain("正好一页");
    expect(text).toContain(`${fit.settings.types.text.size}px`);
  });

  it("撑满时说清楚原来占多少、现在满了", () => {
    const fit = fitOnePage(base, lines("bullet", 30), PAGE_HEIGHT, fakeMeasure);
    const text = describeFit(fit);
    expect(text).toMatch(/原来只占一页的 \d+%/);
    expect(text).toContain("撑满一页");
  });
});
