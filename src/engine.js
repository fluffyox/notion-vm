/* ============================================================================
 * Notion 公式引擎 · 教学复刻
 * 忠实于逆向材料：值盒子模型、栈类 popValue/popValueOrCode、编译器逆序压栈、
 * if 跳转展开、VM 主循环"先自增后分派"、lambda=compiledCode 子字节码+再入 VM、
 * runLets、可挂起取数协议、add 整数快路径/小数慢路径、各函数 *eval 语义。
 * 纯 JavaScript 解释器（非 WASM）。
 * ==========================================================================*/
const NFE = (function () {
  "use strict";

  /* ---------- 值盒子（带类型标签） {type, value} ；array 用 {type,values} ---- */
  const U = () => ({ type: "undefined" });
  const num = (v) => ({ type: "number", value: v });
  const txt = (s) => ({ type: "text", value: typeof s === "string" ? [[s]] : s });
  const chk = (b) => ({ type: "checkbox", value: !!b });
  const arr = (items) => ({ type: "array", values: items });
  const dat = (d) => ({ type: "date", value: d });

  function plainText(box) {
    if (box && box.type === "text") return box.value.map((seg) => seg[0]).join("");
    return boxToText(box);
  }
  function fmtNum(n) {
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 1e12) / 1e12);
  }
  function boxToText(box) {
    if (!box) return "";
    switch (box.type) {
      case "undefined": return "";
      case "number": return fmtNum(box.value);
      case "text": return box.value.map((s) => s[0]).join("");
      case "checkbox": return box.value ? "Yes" : "No";
      case "array": return box.values.map(boxToText).join(", ");
      case "date": return box.value instanceof Date ? box.value.toISOString().slice(0, 10) : String(box.value);
      case "person": return box.value && box.value.name ? box.value.name : "(person)";
      case "block": return box.value && box.value.id ? "▦ " + box.value.id : "(block)";
      case "compiledCode": return "λ";
      default: return "";
    }
  }
  function shortBox(box) {
    if (!box) return "∅";
    switch (box.type) {
      case "undefined": return "∅";
      case "number": return fmtNum(box.value);
      case "text": return '"' + plainText(box) + '"';
      case "checkbox": return box.value ? "✓" : "✗";
      case "array": return "[" + box.values.map(shortBox).join(" ") + "]";
      case "date": return boxToText(box);
      case "compiledCode": return "λ";
      default: return box.type;
    }
  }

  /* ---------- 真值判断（模块 316003 i().C） ---------------------------------- */
  function truthy(box) {
    if (!box) return false;
    switch (box.type) {
      case "checkbox": return !!box.value;
      case "number": return box.value !== 0;
      case "text": return plainText(box).length > 0;
      case "array": return box.values.length > 0;
      case "undefined": return false;
      default: return true;
    }
  }

  /* ---------- 任意精度算术（整数快路径 + 小数"任意精度"） ------------------- */
  const isInt = (n) => Number.isInteger(n);
  const decimals = (n) => (String(n).split(".")[1] || "").length;
  function decAdd(a, b) { const p = Math.max(decimals(a), decimals(b)); const f = Math.pow(10, p); return (Math.round(a * f) + Math.round(b * f)) / f; }
  function decSub(a, b) { const p = Math.max(decimals(a), decimals(b)); const f = Math.pow(10, p); return (Math.round(a * f) - Math.round(b * f)) / f; }
  function decMul(a, b) { const da = decimals(a), db = decimals(b); const f = Math.pow(10, da + db); return (Math.round(a * Math.pow(10, da)) * Math.round(b * Math.pow(10, db))) / f; }

  /* ---------- 错误模型（结构化异常，携带 node 供 UI 标红） ------------------ */
  class FormulaError extends Error {
    constructor(msg, node, info) { super(msg); this.name = "FormulaError"; this.node = node || null; this.info = info || {}; }
  }
  const typeErr = (node, msg) => new FormulaError(msg || "类型不匹配", node, { type: "TypeMismatch" });
  const depthErr = () => new FormulaError("递归过深（DepthExceeded）", null, { type: "DepthExceeded" });
  function assertNum(box, node, who) {
    if (!box || box.type !== "number") throw typeErr(node, `${who || "运算"} 需要 number，收到 ${box ? box.type : "∅"}`);
  }

  /* ===========================================================================
   * 词法分析（Tokenizer）
   * ==========================================================================*/
  const OPS3 = [];
  const OPS2 = ["==", "!=", "<=", ">=", "&&", "||", "=>"];
  const OPS1 = ["+", "-", "*", "/", "%", "^", "<", ">", "(", ")", "[", "]", ",", "."];
  function tokenize(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    const push = (t, v, s, e) => toks.push({ t, v, s, e });
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      // string
      if (c === '"' || c === "'") {
        const q = c; let j = i + 1; let out = "";
        while (j < n && src[j] !== q) { if (src[j] === "\\" && j + 1 < n) { out += src[j + 1]; j += 2; } else { out += src[j]; j++; } }
        if (j >= n) throw new FormulaError("字符串未闭合", null, { type: "Lex" });
        push("str", out, i, j + 1); i = j + 1; continue;
      }
      // number
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        let j = i; while (j < n && /[0-9.]/.test(src[j])) j++;
        const raw = src.slice(i, j); push("num", parseFloat(raw), i, j); i = j; continue;
      }
      // identifier / keyword
      if (/[A-Za-z_\u4e00-\u9fff]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_\u4e00-\u9fff]/.test(src[j])) j++;
        const w = src.slice(i, j);
        if (w === "and" || w === "or" || w === "not") push("op", w, i, j);
        else if (w === "true" || w === "false") push("bool", w === "true", i, j);
        else push("ident", w, i, j);
        i = j; continue;
      }
      // operators
      let matched = null;
      for (const o of OPS2) if (src.startsWith(o, i)) { matched = o; break; }
      if (!matched) for (const o of OPS1) if (src.startsWith(o, i)) { matched = o; break; }
      if (!matched) throw new FormulaError("无法识别的字符 " + JSON.stringify(c), null, { type: "Lex" });
      push("op", matched, i, i + matched.length); i += matched.length;
    }
    push("eof", null, n, n);
    return toks;
  }

  /* ===========================================================================
   * 语法分析（Recursive-descent + 优先级爬升）→ AST（每个节点带 nid）
   * 运算符优先级（低→高）：or < and < ==/!= < 关系 < +/- < * / % < ^ < 一元 < 后缀 < 原子
   * ==========================================================================*/
  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    let nid = 0;
    const mk = (o) => { o.nid = nid++; return o; };
    const peek = () => toks[p];
    const next = () => toks[p++];
    const isOp = (v) => peek().t === "op" && peek().v === v;
    const eat = (v) => { if (!isOp(v)) throw new FormulaError(`期望 '${v}'，实际 '${peek().v}'`, null, { type: "Parse" }); return next(); };

    function parseExpr() { return parseOrReal(); }
    function parseOrReal() { return chain(parseAndReal, { or: "or", "||": "or" }); }
    function parseAndReal() { return chain(parseEq, { and: "and", "&&": "and" }); }
    function parseEq() { return chain(parseRel, { "==": "==", "!=": "!=" }); }
    function parseRel() { return chain(parseAdd, { "<": "<", "<=": "<=", ">": ">", ">=": ">=" }); }
    function parseAdd() { return chain(parseMul, { "+": "+", "-": "-" }); }
    function parseMul() { return chain(parseUnary, { "*": "*", "/": "/", "%": "%" }); }
    function chain(sub, map) {
      let left = sub();
      while (peek().t === "op" && Object.prototype.hasOwnProperty.call(map, peek().v)) {
        const op = map[next().v]; const right = sub(); left = mk({ kind: "bin", op, lhs: left, rhs: right });
      }
      return left;
    }
    function parseUnary() {
      if (isOp("-")) { next(); return mk({ kind: "un", op: "-", expr: parseUnary() }); }
      if (isOp("not")) { next(); return mk({ kind: "un", op: "not", expr: parseUnary() }); }
      return parsePow();
    }
    function parsePow() {
      const base = parsePostfix();
      if (isOp("^")) { next(); const exp = parseUnary(); return mk({ kind: "bin", op: "^", lhs: base, rhs: exp }); }
      return base;
    }
    function parsePostfix() {
      let e = parseAtom();
      for (;;) {
        if (isOp(".")) {
          next();
          if (peek().t !== "ident") throw new FormulaError("'.' 后应为方法名", null, { type: "Parse" });
          const m = next().v; eat("("); const args = parseArgs(); eat(")");
          e = mk({ kind: "call", name: m, args: [e, ...args] }); // recv.method(a) → method(recv,a)
        } else break;
      }
      return e;
    }
    function parseArgs() {
      const args = [];
      if (isOp(")")) return args;
      args.push(parseExpr());
      while (isOp(",")) { next(); args.push(parseExpr()); }
      return args;
    }
    function parseAtom() {
      const tk = peek();
      if (tk.t === "num") { next(); return mk({ kind: "num", value: tk.v }); }
      if (tk.t === "str") { next(); return mk({ kind: "str", value: tk.v }); }
      if (tk.t === "bool") { next(); return mk({ kind: "bool", value: tk.v }); }
      if (isOp("(")) { next(); const e = parseExpr(); eat(")"); return e; }
      if (isOp("[")) {
        next(); const items = [];
        if (!isOp("]")) { items.push(parseExpr()); while (isOp(",")) { next(); items.push(parseExpr()); } }
        eat("]"); return mk({ kind: "array", items });
      }
      if (tk.t === "ident") {
        next();
        if (isOp("(")) {
          eat("("); const args = parseArgs(); eat(")");
          if (tk.v === "prop") {
            if (args.length === 1 && args[0].kind === "str") return mk({ kind: "prop", name: args[0].value });
            throw new FormulaError('prop 仅支持 prop("列名")', null, { type: "Parse" });
          }
          return mk({ kind: "call", name: tk.v, args });
        }
        return mk({ kind: "ident", name: tk.v });
      }
      throw new FormulaError("意外的 token '" + (tk.v == null ? tk.t : tk.v) + "'", null, { type: "Parse" });
    }

    const ast = parseOrReal();
    if (peek().t !== "eof") throw new FormulaError("多余的输入：'" + peek().v + "'", null, { type: "Parse" });
    return ast;
  }

  /* ===========================================================================
   * 编译器 I：AST → 栈式字节码
   * 关键：二元/数组/调用操作数"逆序压栈"，pop 时恢复书写顺序（逆向出的非直觉点）
   * lambda（惰性参数）→ loadConstant(compiledCode 子字节码)
   * if/ifs → jumpIfTruthy / relativeJump 跳转字节码；let/lets → runLets
   * ==========================================================================*/
  // 库函数声明在 LIB（下方），此处先声明引用
  let LIB = {};

  function compile(ast) { return I(ast); }

  function I(node) {
    switch (node.kind) {
      case "num": return [{ type: "loadConstant", value: num(node.value), node, asm: `loadConstant  number ${node.value}` }];
      case "str": return [{ type: "loadConstant", value: txt(node.value), node, asm: `loadConstant  text "${node.value}"` }];
      case "bool": return [{ type: "loadConstant", value: chk(node.value), node, asm: `loadConstant  checkbox ${node.value}` }];
      case "prop": return [{ type: "loadToken", token: { kind: "property", name: node.name }, node, asm: `loadToken     prop("${node.name}")` }];
      case "ident": return [{ type: "loadName", name: node.name, node, asm: `loadName      ${node.name}` }];
      case "array": {
        let out = [];
        for (let k = node.items.length - 1; k >= 0; k--) out = out.concat(I(node.items[k])); // 逆序
        out.push({ type: "array", count: node.items.length, node, asm: `array         count=${node.items.length}` });
        return out;
      }
      case "un": return I(node.expr).concat([{ type: "unary", op: node.op, node, asm: `unary         ${node.op}` }]);
      case "bin": return compileBin(node);
      case "call": return compileCall(node);
      default: throw new FormulaError("无法编译节点 " + node.kind, node);
    }
  }
  function compileBin(node) {
    const { op } = node;
    if (op === "/") return compileCall({ kind: "call", name: "divide", args: [node.lhs, node.rhs], nid: node.nid });
    if (op === "%") return compileCall({ kind: "call", name: "mod", args: [node.lhs, node.rhs], nid: node.nid });
    if (op === "and") return compileCall({ kind: "call", name: "and", args: [node.lhs, node.rhs], nid: node.nid });
    if (op === "or") return compileCall({ kind: "call", name: "or", args: [node.lhs, node.rhs], nid: node.nid });
    const t = (op === "+" || op === "-") ? "add" : op === "*" ? "multiply" : op === "^" ? "exponentiation" : (op === "==" || op === "!=") ? "equality" : "relational";
    // 逆序压栈：先 rhs 后 lhs，执行时 a=pop()=lhs（栈顶）、b=pop()=rhs
    return I(node.rhs).concat(I(node.lhs)).concat([{ type: t, op, node, asm: `${t}${" ".repeat(Math.max(1, 13 - t.length))}${op}` }]);
  }
  function compileCall(node) {
    const name = node.name;
    if (name === "if" || name === "ifs") return compileIf(node);
    if (name === "let" || name === "lets") return compileLet(node);
    const fn = LIB[name];
    if (!fn) throw new FormulaError(`未知函数 ${name}()`, node, { type: "UnknownFunction" });
    const args = node.args.slice();
    if (args.length < (fn.minArgs || 0)) throw new FormulaError(`${name}() 至少需要 ${fn.minArgs} 个参数（收到 ${args.length}）`, node, { type: "Arity" });
    let out = [];
    for (let k = args.length - 1; k >= 0; k--) { // 逆序压栈
      const an = args[k];
      if (fn.lazy && fn.lazy.has(k)) {
        out.push({ type: "loadConstant", isLambda: true, value: { type: "compiledCode", instructions: I(an), srcNode: an }, node: an, asm: `loadConstant  compiledCode(λ)` });
      } else {
        out = out.concat(I(an));
      }
    }
    out.push({ type: "callLibraryFunction", name, argCount: args.length, fn, node, asm: `callLibraryFunction ${name} (argc=${args.length})` });
    return out;
  }
  function desugarIfs(args) {
    if (args.length === 0) return { kind: "num", value: 0, nid: -1 };
    if (args.length === 1) return args[0];
    const [c, v, ...rest] = args;
    return { kind: "call", name: "if", args: [c, v, desugarIfs(rest)], nid: -1 };
  }
  function compileIf(node) {
    if (node.name === "ifs") return I(desugarIfs(node.args.slice()));
    const undefNode = { kind: "__undef", nid: -1 };
    const condN = node.args[0];
    const thenN = node.args[1] || undefNode;
    const elseN = node.args[2] || undefNode;
    const emit = (nn) => nn.kind === "__undef" ? [{ type: "loadConstant", value: U(), node, asm: "loadConstant  undefined" }] : I(nn);
    const cond = emit(condN), thenBC = emit(thenN), elseBC = emit(elseN);
    return [
      ...cond,
      { type: "jumpIfTruthy", offset: elseBC.length + 1, node, asm: `jumpIfTruthy  → then (+${elseBC.length + 1})` },
      ...elseBC,
      { type: "relativeJump", offset: thenBC.length, node, asm: `relativeJump  → end (+${thenBC.length})` },
      ...thenBC,
    ];
  }
  function compileLet(node) {
    const a = node.args.slice();
    let pairs = [], bodyNode;
    if (node.name === "let") { pairs = [[a[0], a[1]]]; bodyNode = a[2]; }
    else { bodyNode = a[a.length - 1]; for (let i = 0; i + 1 < a.length; i += 2) pairs.push([a[i], a[i + 1]]); }
    const bindings = pairs.map(([idN, vN]) => ({ id: idN.name, instructions: I(vN), srcNode: vN }));
    return [{ type: "runLets", bindings, body: { instructions: I(bodyNode), srcNode: bodyNode }, node, asm: `runLets       [${bindings.map((b) => b.id).join(", ")}]` }];
  }

  /* ===========================================================================
   * 栈类 C：popValue 禁止 compiledCode；popValueOrCode 允许（lambda 机制支柱）
   * ==========================================================================*/
  class Stack {
    constructor() { this.u = []; }
    push(v) { this.u.push(v); }
    popValueOrCode() { return this.u.pop(); }
    popValue() { const v = this.u.pop(); if (v && v.type === "compiledCode") throw new FormulaError("unexpected compiled code", null, { type: "TypeMismatch" }); return v; }
    snapshot() { return this.u.slice(); }
  }

  /* ---------- 运行时（供可视化；单线程逐 .next() 驱动，共享安全） ----------- */
  const RT = { frames: [], events: [], fetchCount: 0 };
  function resetRT() { RT.frames.length = 0; RT.events.length = 0; RT.fetchCount = 0; }

  /* ---------- loadName 绑定查找 -------------------------------------------- */
  function lookupBinding(ctx, name) {
    for (const v of ctx.values) if (v.kind === "Binding" && v.id === name) return v.value;
    throw new FormulaError(`未知标识符 ${name}（无此绑定）`, null, { type: "UnknownName" });
  }

  /* ---------- 求值语义 ------------------------------------------------------ */
  function addOp(node, a, b) {
    const op = node && node.op === "-" ? "-" : "+";
    const aNum = a.type === "number" || a.type === "undefined";
    const bNum = b.type === "number" || b.type === "undefined";
    if (op === "-") {
      if (!aNum || !bNum) throw typeErr(node, "减法需要 number");
      const x = a.type === "undefined" ? 0 : a.value, y = b.type === "undefined" ? 0 : b.value;
      return num(isInt(x) && isInt(y) ? x - y : decSub(x, y));
    }
    if (aNum && bNum) { // 数值上下文：undefined → 0
      const x = a.type === "undefined" ? 0 : a.value, y = b.type === "undefined" ? 0 : b.value;
      return num(isInt(x) && isInt(y) ? x + y : decAdd(x, y)); // 整数快路径，否则任意精度
    }
    return txt(boxToText(a) + boxToText(b)); // 非纯数字 → 文本拼接
  }
  function mulOp(a, b) {
    const x = a.type === "undefined" ? 0 : a.type === "number" ? a.value : NaN;
    const y = b.type === "undefined" ? 0 : b.type === "number" ? b.value : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) throw typeErr(null, "乘法需要 number");
    return num(isInt(x) && isInt(y) ? x * y : decMul(x, y));
  }
  function powOp(a, b) { assertNum(a, null, "幂"); assertNum(b, null, "幂"); return num(Math.pow(a.value, b.value)); }
  function unaryOp(node, a) {
    if (node.op === "-") { if (a.type !== "number") throw typeErr(node, "负号需要 number"); return num(-a.value); }
    return chk(!truthy(a)); // not
  }
  function* eqOp(node, a, b) {
    let eq;
    if (a.type === "undefined" || b.type === "undefined") eq = a.type === "undefined" && b.type === "undefined";
    else if (a.type === "number" && b.type === "number") eq = a.value === b.value;
    else if (a.type === "checkbox" && b.type === "checkbox") eq = a.value === b.value;
    else if (a.type === "text" && b.type === "text") eq = plainText(a) === plainText(b);
    else if (a.type === "date" && b.type === "date") eq = +a.value === +b.value;
    else eq = boxToText(a) === boxToText(b);
    return chk(node.op === "==" ? eq : !eq);
  }
  function* relOp(node, a, b) {
    if (a.type === "undefined" || b.type === "undefined") return chk(false);
    let cmp;
    if (a.type === "date" && b.type === "date") cmp = +a.value - +b.value;
    else if (a.type === "text" && b.type === "text") { const sa = plainText(a), sb = plainText(b); cmp = sa < sb ? -1 : sa > sb ? 1 : 0; }
    else {
      const x = a.type === "checkbox" ? (a.value ? 1 : 0) : a.value;
      const y = b.type === "checkbox" ? (b.value ? 1 : 0) : b.value;
      if (typeof x !== "number" || typeof y !== "number") throw typeErr(node, "比较需要同类可比值");
      cmp = x - y;
    }
    const op = node.op;
    return chk(op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : cmp >= 0);
  }

  /* ---------- 可挂起取数协议：loadToken 处 yield {recordPointers} ---------- */
  function* resolveToken(T, ctx) {
    const tk = T.token;
    if (tk.kind === "property") {
      const data = yield { t: "fetch", pointer: ctx.rowPointer, property: tk.name };
      if (data === undefined || data === null) throw new FormulaError(`找不到属性 prop("${tk.name}")`, T.node, { type: "MissingThisRow" });
      return data;
    }
    return U();
  }

  /* ===========================================================================
   * VM 主体 F：生成器解释循环。先自增 ip 后分派；跳转 offset 相对自增后的 ip。
   * 每条指令前 yield {t:'step'}（教学暂停点）；loadToken/比较/库函数内部可 yield {t:'fetch'}。
   * ==========================================================================*/
  function* F(instrs, ctx) {
    if (RT.frames.length > 180) throw depthErr();
    const frame = { instrs, ip: 0, stack: new Stack(), label: ctx.__label || "main", ctx };
    RT.frames.push(frame);
    RT.events.push({ kind: "enter", label: frame.label, depth: RT.frames.length });
    try {
      while (frame.ip < instrs.length) {
        const T = instrs[frame.ip];
        yield { t: "step", frame, instr: T, ip: frame.ip };
        frame.ip++; // ★ 先自增后分派
        switch (T.type) {
          case "loadConstant": frame.stack.push(T.value); break;
          case "loadName": frame.stack.push(lookupBinding(ctx, T.name)); break;
          case "loadToken": frame.stack.push(yield* resolveToken(T, ctx)); break;
          case "add": { const a = frame.stack.popValue(), b = frame.stack.popValue(); frame.stack.push(addOp(T.node, a, b)); break; }
          case "multiply": { const a = frame.stack.popValue(), b = frame.stack.popValue(); frame.stack.push(mulOp(a, b)); break; }
          case "equality": { const a = frame.stack.popValue(), b = frame.stack.popValue(); frame.stack.push(yield* eqOp(T.node, a, b)); break; }
          case "relational": { const a = frame.stack.popValue(), b = frame.stack.popValue(); frame.stack.push(yield* relOp(T.node, a, b)); break; }
          case "exponentiation": { const a = frame.stack.popValue(), b = frame.stack.popValue(); frame.stack.push(powOp(a, b)); break; }
          case "unary": { const a = frame.stack.popValue(); frame.stack.push(unaryOp(T.node, a)); break; }
          case "array": { const vs = []; for (let i = 0; i < T.count; i++) vs.push(frame.stack.popValue()); frame.stack.push({ type: "array", values: vs }); break; }
          case "relativeJump": frame.ip += T.offset; break;
          case "jumpIfTruthy": { const c = frame.stack.popValue(); if (truthy(c)) frame.ip += T.offset; break; }
          case "callLibraryFunction": { const args = []; for (let i = 0; i < T.argCount; i++) args.push(frame.stack.popValueOrCode()); frame.stack.push(yield* T.fn.eval(args, ctx)); break; }
          case "runLets": frame.stack.push(yield* runLets(T, ctx)); break;
          default: throw new FormulaError("未知指令 " + T.type, T.node);
        }
      }
      const r = frame.stack.popValue();
      RT.events.push({ kind: "exit", label: frame.label, result: r, depth: RT.frames.length });
      return r;
    } finally { RT.frames.pop(); }
  }

  function* runLets(T, ctx) {
    let cctx = { ...ctx, values: ctx.values.slice() };
    for (const b of T.bindings) {
      let val;
      try { val = yield* F(b.instructions, { ...cctx, __label: `let ${b.id} =` }); }
      catch (e) { if (e.info && e.info.type === "DepthExceeded") throw e; val = U(); }
      cctx = { ...cctx, values: [{ kind: "Binding", id: b.id, value: val }, ...cctx.values] };
    }
    return yield* F(T.body.instructions, { ...cctx, __label: "let body" });
  }

  /* ---------- lambda 驱动：g(code,ctx)=yield* F(子字节码)，注入 current/index --- */
  function* runLambda(codeBox, el, idx, ctx) {
    if (!codeBox || codeBox.type !== "compiledCode") throw typeErr(null, "期望 lambda（compiledCode）");
    const cctx = {
      ...ctx,
      values: [{ kind: "Binding", id: "current", value: el }, { kind: "Binding", id: "index", value: num(idx) }, ...ctx.values],
      __label: `λ current=${shortBox(el)} [#${idx}]`,
    };
    try { return yield* F(codeBox.instructions, cctx); }
    catch (e) { if (e.info && e.info.type === "DepthExceeded") throw e; return U(); }
  }

  /* ===========================================================================
   * 函数库 LIB（formula2 语义子集）。每个 eval 是生成器，可 yield 取数 / yield* 跑 lambda。
   * ==========================================================================*/
  function flattenNums(args) {
    const out = [];
    for (const a of args) { if (a.type === "array") { for (const it of a.values) out.push(it); } else out.push(a); }
    return out;
  }
  LIB = {
    // 逻辑
    and: { minArgs: 1, eval: function* (a) { return chk(a.every(truthy)); } },
    or: { minArgs: 1, eval: function* (a) { return chk(a.some(truthy)); } },
    not: { minArgs: 1, eval: function* (a) { return chk(!truthy(a[0])); } },
    empty: { minArgs: 0, eval: function* (a) { if (a.length === 0) return U(); const x = a[0]; if (x.type === "array") return chk(x.values.length === 0); return chk(!truthy(x)); } },
    // 数学
    divide: { minArgs: 2, eval: function* ([a, b]) { assertNum(a, null, "divide"); assertNum(b, null, "divide"); if (b.value === 0) return U(); return num(a.value / b.value); } },
    mod: { minArgs: 2, eval: function* ([a, b]) { assertNum(a, null, "mod"); assertNum(b, null, "mod"); if (b.value === 0) return U(); return num(a.value % b.value); } },
    abs: { minArgs: 1, eval: function* ([x]) { assertNum(x, null, "abs"); return num(Math.abs(x.value)); } },
    sign: { minArgs: 1, eval: function* ([x]) { assertNum(x, null, "sign"); return num(Math.sign(x.value)); } },
    sqrt: { minArgs: 1, eval: function* ([x]) { assertNum(x, null, "sqrt"); return num(Math.sqrt(x.value)); } },
    floor: { minArgs: 1, eval: function* ([x]) { assertNum(x, null, "floor"); return num(Math.floor(x.value)); } },
    ceil: { minArgs: 1, eval: function* ([x]) { assertNum(x, null, "ceil"); return num(Math.ceil(x.value)); } },
    round: {
      minArgs: 1, eval: function* ([n, a]) {
        assertNum(n, null, "round");
        if (a === undefined || (assertNum(a, null, "round"), a.value === 0)) return num(Math.round(n.value));
        if (!Number.isInteger(a.value)) throw new FormulaError("round 精度须为整数", null, { type: "RoundPrecisionNotInteger", precision: a.value });
        if (Math.abs(a.value) > 12) throw new FormulaError("round 精度上限为 12 位", null, { type: "RoundPrecisionTooLarge", precision: a.value });
        const o = Math.pow(10, a.value); return num(Math.round(n.value * o) / o);
      }
    },
    min: { minArgs: 1, eval: function* (args) { const xs = flattenNums(args).filter((b) => b.type === "number"); if (!xs.length) return U(); let best = xs[0]; for (const b of xs) if (b.value < best.value) best = b; return best; } },
    max: { minArgs: 1, eval: function* (args) { const xs = flattenNums(args).filter((b) => b.type === "number"); if (!xs.length) return U(); let best = xs[0]; for (const b of xs) if (b.value > best.value) best = b; return best; } },
    sum: { minArgs: 1, eval: function* (args) { const xs = flattenNums(args); let s = 0; for (const b of xs) if (b.type === "number") s = isInt(s) && isInt(b.value) ? s + b.value : decAdd(s, b.value); return num(s); } },
    mean: { minArgs: 1, eval: function* (args) { const xs = flattenNums(args).filter((b) => b.type === "number"); if (!xs.length) return U(); let s = 0; for (const b of xs) s += b.value; return num(s / xs.length); } },
    count: { minArgs: 1, eval: function* (args) { if (args.length === 1 && args[0].type === "array") return num(args[0].values.length); return num(args.length); } },
    // 字符串
    concat: { minArgs: 1, eval: function* (args) { return txt(args.map(boxToText).join("")); } },
    length: { minArgs: 1, eval: function* ([x]) { if (x.type === "array") return num(x.values.length); return num(plainText(x).length); } },
    contains: { minArgs: 2, eval: function* ([s, sub]) { return chk(plainText(s).includes(plainText(sub))); } },
    upper: { minArgs: 1, eval: function* ([s]) { return txt(plainText(s).toUpperCase()); } },
    lower: { minArgs: 1, eval: function* ([s]) { return txt(plainText(s).toLowerCase()); } },
    trim: { minArgs: 1, eval: function* ([s]) { return txt(plainText(s).trim()); } },
    replace: { minArgs: 3, eval: function* ([s, a, b]) { return txt(plainText(s).split(plainText(a)).join(plainText(b))); } },
    format: { minArgs: 1, eval: function* ([x]) { return txt(boxToText(x)); } },
    // 列表（高阶，基于 lambda 再入 VM）
    map: { minArgs: 2, lazy: new Set([1]), eval: function* (args, ctx) { const [arrB, lam] = args; if (arrB.type !== "array") throw typeErr(null, "map 第 1 参须为 array"); const out = []; for (let i = 0; i < arrB.values.length; i++) out.push(yield* runLambda(lam, arrB.values[i], i, ctx)); return { type: "array", values: out }; } },
    filter: { minArgs: 2, lazy: new Set([1]), eval: function* (args, ctx) { const [arrB, lam] = args; if (arrB.type !== "array") throw typeErr(null, "filter 第 1 参须为 array"); const keep = []; for (let i = 0; i < arrB.values.length; i++) { const v = yield* runLambda(lam, arrB.values[i], i, ctx); if (truthy(v)) keep.push(arrB.values[i]); } return { type: "array", values: keep }; } },
    find: { minArgs: 2, lazy: new Set([1]), eval: function* (args, ctx) { const [arrB, lam] = args; if (arrB.type !== "array") throw typeErr(null, "find 第 1 参须为 array"); for (let i = 0; i < arrB.values.length; i++) { const v = yield* runLambda(lam, arrB.values[i], i, ctx); if (truthy(v)) return arrB.values[i]; } return U(); } },
    some: { minArgs: 2, lazy: new Set([1]), eval: function* (args, ctx) { const [arrB, lam] = args; if (arrB.type !== "array") throw typeErr(null, "some 第 1 参须为 array"); for (let i = 0; i < arrB.values.length; i++) { const v = yield* runLambda(lam, arrB.values[i], i, ctx); if (truthy(v)) return chk(true); } return chk(false); } },
    every: { minArgs: 2, lazy: new Set([1]), eval: function* (args, ctx) { const [arrB, lam] = args; if (arrB.type !== "array") throw typeErr(null, "every 第 1 参须为 array"); for (let i = 0; i < arrB.values.length; i++) { const v = yield* runLambda(lam, arrB.values[i], i, ctx); if (!truthy(v)) return chk(false); } return chk(true); } },
    sort: {
      minArgs: 1, lazy: new Set([1]), eval: function* (args, ctx) {
        const [arrB, lam] = args;
        if (arrB.type !== "array") throw typeErr(null, "sort 第 1 参须为 array");
        const items = arrB.values.filter((b) => b.type !== "undefined");
        if (lam && lam.type === "compiledCode") {
          const keyed = [];
          for (let i = 0; i < items.length; i++) keyed.push({ item: items[i], key: yield* runLambda(lam, items[i], i, ctx) });
          keyed.sort((p, q) => cmpBox(p.key, q.key));
          return { type: "array", values: keyed.map((k) => k.item) };
        }
        return { type: "array", values: items.slice().sort(cmpBox) };
      }
    },
    unique: { minArgs: 1, eval: function* ([arrB]) { if (arrB.type !== "array") throw typeErr(null, "unique 须为 array"); const seen = new Set(); const out = []; for (const b of arrB.values) { const k = b.type + ":" + shortBox(b); if (!seen.has(k)) { seen.add(k); out.push(b); } } return { type: "array", values: out }; } },
    slice: { minArgs: 2, eval: function* ([arrB, s, e]) { if (arrB.type !== "array") throw typeErr(null, "slice 须为 array"); const st = s ? s.value : 0; const en = e ? e.value : arrB.values.length; return { type: "array", values: arrB.values.slice(st, en) }; } },
    first: { minArgs: 1, eval: function* ([arrB]) { if (arrB.type !== "array") throw typeErr(null, "first 须为 array"); return arrB.values[0] || U(); } },
    last: { minArgs: 1, eval: function* ([arrB]) { if (arrB.type !== "array") throw typeErr(null, "last 须为 array"); return arrB.values[arrB.values.length - 1] || U(); } },
    at: { minArgs: 2, eval: function* ([arrB, idx]) { if (arrB.type !== "array") throw typeErr(null, "at 须为 array"); return arrB.values[idx.value] || U(); } },
    includes: { minArgs: 2, eval: function* ([arrB, x]) { if (arrB.type !== "array") throw typeErr(null, "includes 须为 array"); return chk(arrB.values.some((b) => boxToText(b) === boxToText(x))); } },
    flat: { minArgs: 1, eval: function* ([arrB]) { const out = []; const go = (b) => { if (b.type === "array") b.values.forEach(go); else out.push(b); }; go(arrB); return { type: "array", values: out }; } },
    // 日期（最小集；本地化重灾区，仅作教学）
    now: { minArgs: 0, eval: function* () { return dat(new Date()); } },
    today: { minArgs: 0, eval: function* () { const d = new Date(); d.setHours(0, 0, 0, 0); return dat(d); } },
    dateAdd: { minArgs: 3, eval: function* ([d, n, unit]) { const dd = new Date(d.value); const u = plainText(unit); const k = n.value; if (u === "days") dd.setDate(dd.getDate() + k); else if (u === "months") dd.setMonth(dd.getMonth() + k); else if (u === "years") dd.setFullYear(dd.getFullYear() + k); else if (u === "hours") dd.setHours(dd.getHours() + k); else if (u === "minutes") dd.setMinutes(dd.getMinutes() + k); return dat(dd); } },
    dateBetween: { minArgs: 3, eval: function* ([a, b, unit]) { const ms = b.value - a.value; const u = plainText(unit); const div = { days: 864e5, hours: 36e5, minutes: 6e4, seconds: 1e3, milliseconds: 1 }[u] || 864e5; return num(Math.trunc(ms / div)); } },
    year: { minArgs: 1, eval: function* ([d]) { return num(new Date(d.value).getFullYear()); } },
    month: { minArgs: 1, eval: function* ([d]) { return num(new Date(d.value).getMonth() + 1); } },
    day: { minArgs: 1, eval: function* ([d]) { return num(new Date(d.value).getDate()); } },
    formatDate: { minArgs: 1, eval: function* ([d]) { return txt(new Date(d.value).toISOString().slice(0, 10)); } },
    // 实体
    id: { minArgs: 0, eval: function* (a, ctx) { return txt(ctx.rowPointer ? ctx.rowPointer.id : "row"); } },
  };
  function cmpBox(a, b) {
    if (a.type === "number" && b.type === "number") return a.value - b.value;
    const sa = boxToText(a), sb = boxToText(b); return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  /* ---------- 人类可读的指令说明（UI "当前指令"面板） ----------------------- */
  function describeInstr(T) {
    switch (T.type) {
      case "loadConstant": return T.isLambda ? "压入一段已编译的 lambda 子字节码（作为常量值）" : `压入常量 ${T.value.type} ${shortBox(T.value)}`;
      case "loadName": return `压入绑定 ${T.name}（在 ctx.values 里查找）`;
      case "loadToken": return `读取 prop("${T.token.name}") —— 若本地无此记录则挂起取数`;
      case "add": return `弹出 a、b（a 在栈顶），压回 a ${T.op} b`;
      case "multiply": return "弹出 a、b，压回 a × b";
      case "equality": return `弹出 a、b，压回 a ${T.op} b（checkbox）`;
      case "relational": return `弹出 a、b，压回 a ${T.op} b（checkbox）`;
      case "exponentiation": return "弹出底数与指数，压回幂";
      case "unary": return T.op === "-" ? "弹出 a，压回 −a" : "弹出 a，压回 not a";
      case "array": return `弹出 ${T.count} 项，组成 array 压回`;
      case "relativeJump": return `无条件跳转：ip += ${T.offset}（相对自增后的 ip）`;
      case "jumpIfTruthy": return `弹出条件；为真则 ip += ${T.offset}`;
      case "callLibraryFunction": return `弹出 ${T.argCount} 个参数，调用 ${T.name}()，结果压回`;
      case "runLets": return `逐个求值绑定 [${T.bindings.map((b) => b.id).join(", ")}]，注入 ctx.values，再求值 body`;
      default: return T.type;
    }
  }

  /* ---------- 无界面驱动（用于自测；fetch 由 provide 同步喂回） -------------- */
  function runHeadless(bytecode, ctx, provide) {
    resetRT();
    const gen = F(bytecode, { ...ctx, __label: "main" });
    let injected; let guard = 0;
    for (;;) {
      const { value: ev, done } = injected === undefined ? gen.next() : gen.next(injected);
      injected = undefined;
      if (done) return ev;
      if (ev.t === "fetch") { RT.fetchCount++; injected = provide ? provide(ev) : null; }
      if (++guard > 200000) throw new FormulaError("步数超限（疑似死循环）", null);
    }
  }

  return {
    // 数据/工具
    U, num, txt, chk, arr, dat, boxToText, plainText, shortBox, truthy, FormulaError,
    // 流水线
    tokenize, parse, compile, I, F, runLambda, Stack,
    // 运行时与驱动
    RT, resetRT, runHeadless, describeInstr, LIB,
  };
})();
if (typeof globalThis !== "undefined") globalThis.NFE = NFE;
if (typeof module !== "undefined" && module.exports) module.exports = NFE;
