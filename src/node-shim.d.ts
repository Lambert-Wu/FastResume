// 只为测试里读源码文件提供最小的 node 类型声明。
// 项目本身是纯浏览器代码，没装 @types/node，也不想为了几条测试把它拉进来。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  export function resolve(...parts: string[]): string;
}
declare const __dirname: string;
