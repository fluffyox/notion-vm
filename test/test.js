const NFE = require("../src/engine.js");

function row(map) {
  // map: name -> box
  return {
    values: [],
    rowPointer: { table: "block", id: "row_500" },
    userTimeZone: "Asia/Tokyo",
    intl: { locale: "zh-CN" },
    __row: map,
  };
}
function run(src, rowMap) {
  const ctx = row(rowMap || {});
  const ast = NFE.parse(src);
  const bc = NFE.compile(ast);
  const provide = (ev) => {
    const slot = ctx.__row[ev.property];
    return slot === undefined ? null : slot;
  };
  const r = NFE.runHeadless(bc, ctx, provide);
  return r;
}
function show(box) { return box.type + " " + NFE.shortBox(box); }

const cases = [
  ["1 + 2", {}, "number 3"],
  ["0.1 + 0.2", {}, "number 0.3"],
  ["10 - 3", {}, "number 7"],
  ["2 * 3 * 4", {}, "number 24"],
  ["2 ^ 10", {}, "number 1024"],
  ["round(1 / 3, 2)", {}, "number 0.33"],
  ["1 / 0", {}, "undefined ∅"],
  ['"a" + "b"', {}, 'text "ab"'],
  ['1 + "x"', {}, 'text "1x"'],
  ["sum(map([1,2,3], current * 2))", {}, "number 12"],
  ["length(filter([1,2,3,4], current > 2))", {}, "number 2"],
  ["[1,2,3].map(current + index)", {}, "array [1 3 5]"],
  ["max([3,1,2])", {}, "number 3"],
  ["min(5, 2, 8)", {}, "number 2"],
  ["let(x, 10, x * x)", {}, "number 100"],
  ["lets(a, 2, b, 3, a + b)", {}, "number 5"],
  ['if(true, "Y", "N")', {}, 'text "Y"'],
  ['if(false, "Y", "N")', {}, 'text "N"'],
  ['ifs(false, "a", true, "b", "c")', {}, 'text "b"'],
  ["sort([3,1,2])", {}, "array [1 2 3]"],
  ["sort([3,1,2], -current)", {}, "array [3 2 1]"],
  ["unique([1,1,2,3,3])", {}, "array [1 2 3]"],
  ["every([2,4,6], mod(current,2) == 0)", {}, "checkbox ✓"],
  ["some([1,2,3], current > 5)", {}, "checkbox ✗"],
  ['concat("a","-","b")', {}, 'text "a-b"'],
  ['upper("abc")', {}, 'text "ABC"'],
  ['contains("hello world", "world")', {}, "checkbox ✓"],
  ["not(true)", {}, "checkbox ✗"],
  ["empty([])", {}, "checkbox ✓"],
  ["-5 + 3", {}, "number -2"],
];

let pass = 0, fail = 0;
for (const [src, rowMap, expect] of cases) {
  let got;
  try { got = show(run(src, rowMap)); } catch (e) { got = "ERROR: " + e.message; }
  const ok = got === expect;
  if (ok) pass++; else fail++;
  console.log((ok ? "✓" : "✗") + "  " + src.padEnd(42) + " => " + got + (ok ? "" : "   (期望 " + expect + ")"));
}

// 错误用例
console.log("\n-- 错误/边界 --");
const errCases = [
  ["round(1, 13)", "RoundPrecisionTooLarge"],
  ["round(1, 0.5)", "RoundPrecisionNotInteger"],
  ["nope(1)", "UnknownFunction"],
  ["1 + ", "Parse"],
  ["map(5, current)", "TypeMismatch"],
];
for (const [src, expectInfo] of errCases) {
  let info = "(no error)";
  try { run(src, {}); } catch (e) { info = (e.info && e.info.type) || e.name; }
  const ok = info === expectInfo;
  if (ok) pass++; else fail++;
  console.log((ok ? "✓" : "✗") + "  " + src.padEnd(42) + " => " + info + (ok ? "" : "   (期望 " + expectInfo + ")"));
}

// 挂起取数用例
console.log("\n-- 挂起取数（prop 触发 fetch）--");
const ctx = row({ Rate: NFE.num(50), Hours: NFE.num(8), Done: NFE.chk(true), Name: NFE.txt("报告") });
{
  const bc = NFE.compile(NFE.parse('prop("Rate") * prop("Hours")'));
  const provide = (ev) => ctx.__row[ev.property] ?? null;
  const r = NFE.runHeadless(bc, ctx, provide);
  const ok = NFE.shortBox(r) === "400" && NFE.RT.fetchCount === 2;
  if (ok) pass++; else fail++;
  console.log((ok ? "✓" : "✗") + '  prop("Rate")*prop("Hours")'.padEnd(42) + " => " + show(r) + "  fetchCount=" + NFE.RT.fetchCount);
}
{
  const bc = NFE.compile(NFE.parse('if(prop("Done"), "完成", "进行中")'));
  const provide = (ev) => ctx.__row[ev.property] ?? null;
  const r = NFE.runHeadless(bc, ctx, provide);
  const ok = NFE.plainText(r) === "完成";
  if (ok) pass++; else fail++;
  console.log((ok ? "✓" : "✗") + '  if(prop("Done"),完成,进行中)'.padEnd(42) + " => " + show(r));
}

console.log("\n==== " + pass + " passed, " + fail + " failed ====");
process.exit(fail ? 1 : 0);
