import { JSDOM } from "jsdom";
import fs from "fs";
const html = fs.readFileSync(new URL("../dist/notion-vm.html", import.meta.url), "utf8");
const errors = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    window.addEventListener("error", (e) => errors.push("window error: " + (e.error ? e.error.stack : e.message)));
  },
});
const { window } = dom;
const { document } = window;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const txt = (id) => (document.getElementById(id) || {}).textContent || "";
const html_ = (id) => (document.getElementById(id) || {}).innerHTML || "";

await tick(40); // let DOMContentLoaded/init run

function check(name, cond) { console.log((cond ? "✓" : "✗") + "  " + name); if (!cond) process.exitCode = 1; }

// 1) 初始编译（默认公式 sum(map(...))）应填充 AST/字节码
check("AST 已渲染", html_("ast").includes("call") && html_("ast").includes("array"));
check("字节码已渲染（含 callLibraryFunction）", html_("bc").includes("callLibraryFunction"));
check("字节码含 λ 子字节码展开", html_("bc").includes("λ 子字节码"));
check("引用属性区渲染", html_("usedprops").length > 0);
check("trace 有编译日志", html_("trace").includes("编译成功"));

// 2) 教学模式单步：点击 btn-step 多次，驱动到结束
const stepBtn = document.getElementById("btn-step");
let guard = 0, sawStack = false, sawFrameLambda = false;
function clickStep() { stepBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }
clickStep(); await tick(5); // 首步：startRun → 渲染第0步并等待
for (; guard < 200; guard++) {
  // 观察执行面板
  if (html_("stack").includes("plate")) sawStack = true;
  if (html_("frames").includes("λ current")) sawFrameLambda = true;
  const res = html_("result");
  if (res.includes("res-big") || res.includes("err-type")) break;
  clickStep();
  await tick(3);
}
check("单步推进未死循环", guard < 200);
check("执行中出现操作数栈盘片", sawStack);
check("调用栈出现 lambda 帧（map 再入 VM）", sawFrameLambda);
check("最终显示结果盒子", html_("result").includes("res-big"));
check("结果值为 30（1+4+9+16）", txt("result").includes("30"));

// 3) 编译错误处理
document.getElementById("formula").value = "1 + ";
document.getElementById("btn-compile").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick(10);
check("编译错误显示 err-type", html_("result").includes("err-type"));

// 4) 挂起取数：设公式 prop("Rate")*prop("Hours")，Rate 冷 → 应出现冻结覆盖层
document.getElementById("formula").value = 'prop("Rate") * prop("Hours")';
document.getElementById("btn-compile").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick(10);
// 确保 Rate 冷：找到 Rate 的 toggle，若显示已加载则点一下
// （example 没触发，这里默认 rowData.Rate.loaded=false 初始为冷）
let sawFrozen = false;
clickStep(); await tick(5);
for (guard = 0; guard < 120; guard++) {
  if (html_("execpane").includes("frozen-ovl")) sawFrozen = true;
  const res = html_("result");
  if (res.includes("res-big") || res.includes("err-type")) break;
  clickStep();
  await tick(8); // 给挂起延迟一点时间（fetchDelay 默认较大，但 example 未改；这里 reset 后默认 950ms，单步会触发 delay）
}
// 因为 fetchDelay 默认 950ms，循环 tick 太短可能没走完取数；放宽：再等久一点
await tick(1200);
for (guard = 0; guard < 60; guard++) { const res = html_("result"); if (res.includes("res-big") || res.includes("err-type")) break; clickStep(); await tick(20); }
await tick(1200);
check("挂起出现冻结覆盖层（frozen-ovl）", sawFrozen);
check("trace 记录了挂起", html_("trace").includes("挂起"));

console.log("\n--- collected window errors:", errors.length);
errors.forEach((e) => console.log("  !", e));
if (errors.length) process.exitCode = 1;
