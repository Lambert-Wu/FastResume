import { describe, expect, it } from "vitest";
import { lineHtml, rowStyle } from "./render";
import { defaultSettings, initialResume, readResume } from "./flow";
import type { Line, Settings } from "./flow";

const threeLine: Line = {
  id: "x",
  kind: "entry",
  text: "东京 - 东京控股股份有限公司 | 研发部 | 2026.04 — 2026.07",
};
const twoLine: Line = { id: "y", kind: "entry", text: "吉林大学 | 2023.09" };

const style = (line: Line, s: Settings) =>
  rowStyle(line, s) as Record<string, unknown>;

describe("entry divider", () => {
  it("三栏之间插两根竖线，两栏插一根", () => {
    const three = lineHtml(threeLine);
    const two = lineHtml(twoLine);
    expect((three.match(/entry-divider/g) || []).length).toBe(2);
    expect((two.match(/entry-divider/g) || []).length).toBe(1);
    expect((three.match(/class="entry-cell"/g) || []).length).toBe(3);
    expect((two.match(/class="entry-cell"/g) || []).length).toBe(2);
  });

  it("竖线在格子外面，不影响文本读写", () => {
    const html = lineHtml(threeLine);
    expect(html).toContain('data-divider="1"');
    expect(html.indexOf("entry-divider")).toBeGreaterThan(
      html.indexOf('data-placeholder="左侧内容"'),
    );
  });

  it("普通行不加竖线", () => {
    expect(lineHtml({ id: "z", kind: "text", text: "随便一段话" })).not.toContain(
      "entry-divider",
    );
  });

  it("三栏与两栏用各自的分栏变量，互不覆盖", () => {
    const s = defaultSettings();
    s.entrySplit = { three: [40, 65], two: [30] };
    const three = style(threeLine, s);
    const two = style(twoLine, s);
    expect(three["--split-a"]).toBe(40);
    expect(three["--split-b"]).toBe(65);
    expect(two["--split-x"]).toBe(30);
    expect(two["--split-a"]).toBe(40);
    expect(three["--entry-columns"]).toBe(3);
    expect(two["--entry-columns"]).toBe(2);
  });

  it("只改三栏时，两栏的分界点不动", () => {
    const s = defaultSettings();
    const before = style(twoLine, s)["--split-x"];
    s.entrySplit = { three: [20, 90], two: s.entrySplit.two };
    expect(style(twoLine, s)["--split-x"]).toBe(before);
    expect(style(threeLine, s)["--split-a"]).toBe(20);
  });

  it("旧数据（数组形式）能读进来，不会崩", () => {
    const base = initialResume("blue");
    const legacy = {
      ...base,
      settings: { ...base.settings, entrySplit: [30, 60] },
    } as unknown;
    const doc = readResume(legacy);
    expect(doc.settings.entrySplit.three).toEqual([30, 60]);
    expect(doc.settings.entrySplit.two).toEqual([58]);
  });

  it("坏数据回退默认值", () => {
    const base = initialResume("blue");
    const bad = {
      ...base,
      settings: { ...base.settings, entrySplit: { three: [999], two: "x" } },
    } as unknown;
    const doc = readResume(bad);
    expect(doc.settings.entrySplit.three).toEqual([50, 72]);
    expect(doc.settings.entrySplit.two).toEqual([58]);
  });
});
