import { describe, expect, it } from "vitest";
import { lineHtml } from "./render";
import { defaultSettings } from "./flow";
import { rowStyle } from "./render";

describe("entry divider", () => {
  const html = lineHtml({
    id: "x",
    kind: "entry",
    text: "东京 - 东京控股股份有限公司 | 研发部 | 2026.04 — 2026.07",
  });

  it("三栏之间插了两根竖线", () => {
    console.log("\nHTML:", html);
    expect((html.match(/entry-divider/g) || []).length).toBe(2);
    expect((html.match(/entry-cell/g) || []).length).toBe(3);
  });

  it("竖线不在 cell 内部，不影响文本读写", () => {
    expect(html).toContain('data-divider="1"');
    const cellCount = (html.match(/class="entry-cell"/g) || []).length;
    expect(cellCount).toBe(3);
    expect(html.indexOf("entry-divider")).toBeGreaterThan(
      html.indexOf('data-placeholder="左侧内容"'),
    );
  });

  it("两栏时不插竖线（只有 2 个字段）", () => {
    const two = lineHtml({ id: "y", kind: "entry", text: "吉林大学 | 2023.09" });
    expect((two.match(/entry-divider/g) || []).length).toBe(1);
  });

  it("普通行不加竖线", () => {
    const text = lineHtml({ id: "z", kind: "text", text: "随便一段话" });
    expect(text).not.toContain("entry-divider");
  });

  it("rowStyle 输出分栏变量", () => {
    const s = defaultSettings();
    const st = rowStyle({ id: "a", kind: "entry", text: "x" }, s) as Record<
      string,
      unknown
    >;
    console.log("\nrowStyle:", JSON.stringify(st));
    expect(st["--split-a"]).toBe(50);
    expect(st["--split-b"]).toBe(72);
  });
});
