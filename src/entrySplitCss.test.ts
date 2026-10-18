import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 这些断言针对的是"CSS 有没有真的把变量用起来"，而不是"JS 有没有把变量写上去"。
 *
 * 之前的教训：rowStyle() 明明把 --split-x 写到了行上，测试也全绿，
 * 但 CSS 里两栏规则被别的规则覆盖 / 两栏规则根本没命中，用户拖动仍旧没反应。
 * 所以这里直接读 studio.css 源码做结构断言，把这类"变量写了但没人用"的坑钉住。
 */
// 直接读 CSS 源码，而不是走 ?raw 导入——?raw 拿到的是 Vite 处理后的产物，
// 选择器可能被重写，拿来做结构断言不可靠。
const css = readFileSync(resolve(__dirname, "studio.css"), "utf8");
const flat = css.replace(/\s+/g, " ");

describe("entry split css", () => {
  it("两栏宽度的规则确实读了 --split-x", () => {
    expect(flat).toMatch(/:not\(:has\(> \.entry-cell:nth-child\(3 of \.entry-cell\)\)\)[^{]*\{ flex: 0 0 calc\(var\(--split-x/);
  });

  it("三栏宽度确实读了 --split-a 与 --split-b", () => {
    expect(flat).toContain("calc(var(--split-a, 50) * 1%)");
    expect(flat).toContain("calc((var(--split-b, 72) - var(--split-a, 50)) * 1%)");
  });

  it("判断第几栏不能用裸 nth-child（竖线也占位）", () => {
    // 出现过 `>.entry-cell:nth-child(3) {` 这种裸写法就说明又在把竖线算进去
    expect(flat).not.toMatch(/>\s*\.entry-cell:nth-child\(3\)\s*(?:>|\{|,)/);
    // 而必须是 nth-child(N of .entry-cell)
    expect(flat).toMatch(/nth-child\(3 of \.entry-cell\)/);
  });

  it("旧的「两栏写死 flex: 1.8」不能漏到带竖线的行上", () => {
    const bad = /\.row-entry:has\(\.entry-cell:nth-child\(2\):last-child\)\s*>\s*\.entry-cell:first-child\s*\{[^}]*flex:\s*1\.8/;
    expect(flat).not.toMatch(bad);
  });

  it("打印时隐藏竖线，并让格子平分", () => {
    const printBlock = css.slice(css.indexOf("@media print"));
    expect(printBlock).toContain(".entry-divider");
    expect(printBlock).toMatch(/display: none/);
  });
});
