/* global NFE */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { num, txt, chk, shortBox, boxToText, describeInstr } = NFE;

  /* ---------------- 状态 ---------------- */
  let AST = null, BYTECODE = null, gen = null;
  let mode = "teach", autoplay = false, finished = true, busy = false;
  let speed = 420, fetchDelay = 950;
  let pendingResolve = null, autoTimer = null, runId = 0;
  let lastDepth = 0;
  const animState = { frame: null, len: 0 };

  const rowData = {
    Rate: { box: num(50), loaded: false },
    Hours: { box: num(8), loaded: true },
    Score: { box: num(92), loaded: true },
    Done: { box: chk(true), loaded: true },
    Note: { box: txt(""), loaded: true },
  };

  /* ---------------- 例子 ---------------- */
  const EXAMPLES = [
    { t: "小数精度", f: "0.1 + 0.2" },
    { t: "round 精度", f: "round(1 / 3, 2)" },
    { t: "map 求和", f: "sum(map([1, 2, 3, 4], current * current))" },
    { t: "filter 计数", f: "length(filter([5, 12, 8, 3, 20], current > 10))" },
    { t: "lets 绑定", f: "lets(price, 80, qty, 3, price * qty)" },
    { t: "if 短路", f: 'if(empty(prop("Note")), "（空）", prop("Note"))', setup: () => { rowData.Note = { box: txt(""), loaded: true }; } },
    { t: "挂起取数", f: 'prop("Rate") * prop("Hours")', setup: () => { rowData.Rate = { box: num(50), loaded: false }; rowData.Hours = { box: num(8), loaded: true }; } },
    { t: "排序(降序)", f: "sort([3, 1, 4, 1, 5, 9, 2, 6], -current)" },
    { t: "嵌套高阶", f: 'filter(map([1,2,3,4,5], current * current), current > 8)' },
  ];

  /* ---------------- 工具 ---------------- */
  function buildCtx() {
    return { values: [], rowPointer: { table: "block", id: "row_★" }, userTimeZone: "Asia/Tokyo", intl: { locale: "zh-CN" }, __label: "main" };
  }
  function parseCellValue(s) {
    s = s.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return num(parseFloat(s));
    if (s === "true" || s === "✓" || s === "Yes") return chk(true);
    if (s === "false" || s === "✗" || s === "No") return chk(false);
    return txt(s);
  }
  function delay(ms, myId) { return new Promise((res) => setTimeout(() => res(), ms)); }
  function micro() { return new Promise((res) => setTimeout(res, 0)); }
  function collectProps(node, set) {
    set = set || new Set();
    if (!node || typeof node !== "object") return set;
    if (node.kind === "prop") set.add(node.name);
    for (const k of ["lhs", "rhs", "expr"]) if (node[k]) collectProps(node[k], set);
    if (node.items) node.items.forEach((n) => collectProps(n, set));
    if (node.args) node.args.forEach((n) => collectProps(n, set));
    return set;
  }

  /* ================= 编译 ================= */
  function compileNow() {
    cancelRun();
    const src = $("formula").value;
    clearHL();
    try {
      AST = NFE.parse(src);
      BYTECODE = NFE.compile(AST);
    } catch (e) {
      AST = null; BYTECODE = null;
      renderError(e, "编译");
      $("ast").innerHTML = '<span class="res-idle">—</span>';
      $("bc").innerHTML = "";
      $("bc-crumb").innerHTML = "";
      return;
    }
    // 补齐公式引用但 row 里没有的属性
    const used = collectProps(AST);
    let added = [];
    used.forEach((p) => { if (!rowData[p]) { rowData[p] = { box: num(0), loaded: true }; added.push(p); } });
    renderRowData();
    renderUsedProps(used);
    renderAST(AST);
    renderBytecodeStatic();
    resetExec();
    clearTrace();
    logTrace("info", `编译成功 · ${BYTECODE.length} 条顶层指令` + (added.length ? `（已自动加入属性 ${added.join(", ")}=0）` : ""));
    $("result").innerHTML = '<div class="res-idle">已编译。点「单步」或「自动」开始执行。</div>';
    finished = true; gen = null;
    updateButtons();
  }

  /* ================= 执行驱动 ================= */
  function startRun() {
    if (!BYTECODE) { compileNow(); if (!BYTECODE) return; }
    cancelRun();
    NFE.resetRT();
    gen = NFE.F(BYTECODE, buildCtx());
    finished = false; lastDepth = 0; animState.frame = null; animState.len = 0;
    clearTrace();
    logTrace("info", `开始执行 · 模式：${mode === "teach" ? "教学（逐指令）" : "真实（仅取数挂起）"}`);
    $("result").innerHTML = '<div class="res-idle">执行中…</div>';
    const myId = runId;
    loop(myId);
  }

  function cancelRun() {
    runId++;
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); }
  }

  function waitStep() { return new Promise((res) => { pendingResolve = res; }); }

  async function loop(myId) {
    busy = true; updateButtons();
    let injected;
    try {
      for (;;) {
        if (myId !== runId) return;
        const r = injected === undefined ? gen.next() : gen.next(injected);
        injected = undefined;
        if (r.done) { renderResult(r.value); finished = true; logTrace("result", "✓ 求值完成 → " + shortBox(r.value)); break; }
        const ev = r.value;
        if (ev.t === "step") {
          renderStep(ev);
          if (mode === "teach") { await waitStep(); if (myId !== runId) return; }
          else { await micro(); if (myId !== runId) return; }
        } else if (ev.t === "fetch") {
          const slot = rowData[ev.property];
          if (slot && slot.loaded) {
            logTrace("fetch", `prop("${ev.property}") 命中本地缓存 → 立即恢复（不挂起）`);
            injected = slot.box;
          } else if (slot) {
            renderSuspend(ev);
            logTrace("suspend", `⏸ 挂起 · 请求记录 ${ev.pointer.id} 的属性 "${ev.property}"`);
            await delay(fetchDelay, myId); if (myId !== runId) return;
            slot.loaded = true; renderRowData();
            injected = slot.box;
            renderResume(ev, slot.box);
            logTrace("resume", `▶ 恢复 · 取回 ${ev.property} = ${shortBox(slot.box)}，从同一指令继续`);
          } else {
            injected = null;
            logTrace("suspend", `请求属性 "${ev.property}"：本行无此属性 → MissingThisRow`);
          }
        }
      }
    } catch (err) {
      renderError(err, "运行");
      finished = true;
      logTrace("error", "✗ " + (err.info && err.info.type ? err.info.type + " · " : "") + err.message);
    } finally {
      busy = false; updateButtons();
    }
  }

  function doStep() {
    if (mode !== "teach") return;
    if (finished || !gen) { startRun(); return; }
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); }
  }
  function setAutoplay(on) {
    autoplay = on;
    if (on) {
      if (finished || !gen) startRun();
      if (mode === "teach") { if (autoTimer) clearInterval(autoTimer); autoTimer = setInterval(() => { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); } else if (finished) setAutoplay(false); }, speed); }
    } else { if (autoTimer) clearInterval(autoTimer); autoTimer = null; }
    updateButtons();
  }
  function resetRun() { cancelRun(); setAutoplay(false); finished = true; gen = null; if (BYTECODE) renderBytecodeStatic(); resetExec(); clearTrace(); $("result").innerHTML = '<div class="res-idle">已重置。点「单步」或「自动」重新开始。</div>'; clearHL(); updateButtons(); }

  function updateButtons() {
    const stepBtn = $("btn-step"), autoBtn = $("btn-auto");
    stepBtn.disabled = (mode === "real");
    stepBtn.title = mode === "real" ? "真实模式下 VM 仅在取数处挂起；切到教学模式可逐指令单步。" : "";
    autoBtn.textContent = mode === "real" ? (busy ? "运行中…" : "▶ 运行") : (autoplay ? "⏸ 暂停" : "▶▶ 自动");
  }

  /* ================= 渲染：AST ================= */
  function renderAST(ast) {
    const host = $("ast"); host.innerHTML = "";
    host.appendChild(astNode(ast));
  }
  function astNode(n) {
    const wrap = document.createElement("div");
    wrap.className = "astn"; wrap.dataset.nid = n.nid;
    const row = document.createElement("div"); row.className = "nrow";
    let kind = "", val = "", cls = "t-op", kids = [];
    switch (n.kind) {
      case "num": kind = "num"; val = String(n.value); cls = "t-num"; break;
      case "str": kind = "str"; val = '"' + n.value + '"'; cls = "t-str"; break;
      case "bool": kind = "bool"; val = String(n.value); cls = "t-bool"; break;
      case "prop": kind = "token"; val = 'prop("' + n.name + '")'; cls = "t-prop"; break;
      case "ident": kind = "name"; val = n.name; cls = "t-name"; break;
      case "array": kind = "array"; val = "[ " + n.items.length + " 项 ]"; cls = "t-arr"; kids = n.items; break;
      case "bin": kind = "binary"; val = n.op; cls = "t-op"; kids = [n.lhs, n.rhs]; break;
      case "un": kind = "unary"; val = n.op; cls = "t-op"; kids = [n.expr]; break;
      case "call": kind = "call"; val = n.name + "()"; cls = "t-call"; kids = n.args; break;
      default: kind = n.kind; val = "";
    }
    row.innerHTML = `<span class="k">${kind}</span><span class="v ${cls}">${esc(val)}</span>`;
    wrap.appendChild(row);
    if (kids.length) { const kc = document.createElement("div"); kc.className = "kids"; kids.forEach((k) => kc.appendChild(astNode(k))); wrap.appendChild(kc); }
    return wrap;
  }

  /* ================= 渲染：字节码 ================= */
  function insRow(ins, idx, cur, done) {
    const div = document.createElement("div");
    div.className = "ins" + (cur ? " cur" : "") + (done ? " done" : "");
    if (ins.node && ins.node.nid != null) div.dataset.nid = ins.node.nid;
    const m = ins.asm.match(/^(\S+)(.*)$/);
    div.innerHTML = `<span class="ix">${idx}</span><span><span class="op">${esc(m ? m[1] : ins.type)}</span><span class="ar">${esc(m ? m[2] : "")}</span></span>`;
    return div;
  }
  function renderInstrList(host, instrs, curIp, doneUpTo) {
    instrs.forEach((ins, i) => {
      host.appendChild(insRow(ins, i, i === curIp, doneUpTo != null && i < doneUpTo && i !== curIp ? false : false));
      if (ins.isLambda && ins.value && ins.value.instructions) {
        const sub = document.createElement("div"); sub.className = "sub";
        const h = document.createElement("div"); h.className = "subhdr"; h.textContent = "↳ λ 子字节码（compiledCode）"; sub.appendChild(h);
        ins.value.instructions.forEach((si, j) => sub.appendChild(insRow(si, j, false, false)));
        host.appendChild(sub);
      }
    });
  }
  function renderBytecodeStatic() {
    $("bc-crumb").innerHTML = `<b>main</b><span class="seg-l">·</span>${BYTECODE.length} 条指令`;
    const host = $("bc"); host.innerHTML = ""; renderInstrList(host, BYTECODE, -1);
  }
  function renderBytecodeFrame(frame, ip) {
    const frames = NFE.RT.frames;
    const crumb = frames.map((f, i) => i === frames.length - 1 ? `<b>${esc(f.label)}</b>` : esc(f.label)).join('<span class="seg-l">›</span>');
    $("bc-crumb").innerHTML = crumb;
    const host = $("bc"); host.innerHTML = ""; renderInstrList(host, frame.instrs, ip);
    const cur = host.querySelector(".ins.cur"); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }

  /* ================= 渲染：执行一步 ================= */
  function renderStep(ev) {
    const frame = ev.frame, frames = NFE.RT.frames;
    // 进入 / 返回 日志
    if (frames.length > lastDepth) logTrace("enter", "→ 进入 " + frame.label);
    else if (frames.length < lastDepth) logTrace("exit", "← 返回上层");
    lastDepth = frames.length;

    renderBytecodeFrame(frame, ev.ip);
    renderFrames(frames);
    renderStack(frame);
    renderBindings(frame.ctx);
    renderCurIns(ev.instr);
    clearHL();
    if (ev.instr.node && ev.instr.node.nid != null) {
      const a = document.querySelector(`#ast .astn[data-nid="${ev.instr.node.nid}"]`); if (a) a.classList.add("hl");
    }
  }
  function renderFrames(frames) {
    const host = $("frames"); host.innerHTML = "";
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i], top = i === frames.length - 1;
      const div = document.createElement("div"); div.className = "frm" + (top ? " top" : "");
      div.innerHTML = `<span class="depthbadge">#${i}</span><span class="lbl">${esc(f.label)}</span><span class="meta">ip ${f.ip}/${f.instrs.length} · 栈 ${f.stack.u.length}</span>`;
      host.appendChild(div);
    }
  }
  function renderStack(frame) {
    const host = $("stack"); host.innerHTML = "";
    const items = frame.stack.snapshot();
    const grew = (animState.frame === frame && items.length > animState.len);
    if (!items.length) { host.innerHTML = '<div class="stack-empty">（空栈）</div>'; }
    items.forEach((b, i) => {
      const top = i === items.length - 1;
      const div = document.createElement("div");
      div.className = "plate v-" + b.type + (top ? " top" : "") + (top && grew ? " enter" : "");
      div.innerHTML = `<span class="pt">${b.type}</span><span class="pv">${esc(shortBox(b))}</span>${top ? '<span class="toptag">栈顶</span>' : ""}`;
      host.appendChild(div);
    });
    animState.frame = frame; animState.len = items.length;
  }
  function renderBindings(ctx) {
    const host = $("binds"); host.innerHTML = "";
    const vs = (ctx && ctx.values) || [];
    if (!vs.length) { host.innerHTML = '<div class="binds-empty">（无绑定）</div>'; return; }
    vs.forEach((v) => {
      if (v.kind !== "Binding") return;
      const tag = (v.id === "current" || v.id === "index") ? "lambda" : "let";
      const div = document.createElement("div"); div.className = "bind";
      div.innerHTML = `<span class="bid">${esc(v.id)}</span><span class="beq">=</span><span class="bval">${esc(shortBox(v.value))}</span><span class="btag">${tag}</span>`;
      host.appendChild(div);
    });
    if (!host.children.length) host.innerHTML = '<div class="binds-empty">（无绑定）</div>';
  }
  function renderCurIns(ins) {
    const host = $("curins"); host.className = "curins";
    host.innerHTML = `<div class="cop">${esc(ins.type)}</div><div class="cdesc">${esc(describeInstr(ins))}</div>`;
  }

  /* ================= 挂起 / 恢复（signature）================= */
  function renderSuspend(ev) {
    const pane = $("execpane");
    let ovl = pane.querySelector(".frozen-ovl");
    if (!ovl) { ovl = document.createElement("div"); ovl.className = "frozen-ovl"; pane.appendChild(ovl); }
    ovl.innerHTML = `<div class="spinner"></div>
      <div class="fz-t">冻结 · 等待记录</div>
      <div class="fz-p">prop("${esc(ev.property)}") ← ${esc(ev.pointer.id)}</div>
      <div class="fz-s">生成器原样捕获了 ip、操作数栈与整条调用栈。取数返回后，VM 从这条 <b>loadToken</b> 的同一位置继续——这就是"可暂停 / 可恢复求值"。</div>`;
  }
  function renderResume(ev, box) {
    const pane = $("execpane");
    const ovl = pane.querySelector(".frozen-ovl"); if (ovl) ovl.remove();
    pane.classList.remove("thaw"); void pane.offsetWidth; pane.classList.add("thaw");
  }

  /* ================= 结果 / 错误 ================= */
  const TYPE_COLOR = { number: "var(--cyan)", text: "var(--sand)", checkbox: "var(--green)", array: "var(--mint)", date: "var(--sky)", undefined: "var(--faint)" };
  function renderResult(box) {
    clearHL();
    const c = TYPE_COLOR[box.type] || "var(--ink)";
    let valStr = box.type === "text" ? '"' + NFE.plainText(box) + '"' : shortBox(box);
    const json = box.type === "array" ? `{type:"array", values:[${box.values.length}]}` : box.type === "undefined" ? `{type:"undefined"}` : `{type:"${box.type}", value:${JSON.stringify(box.type === "text" ? NFE.plainText(box) : box.value)}}`;
    $("result").innerHTML = `<div class="res-type">${box.type}</div><div class="res-big" style="color:${c}">${esc(valStr)}</div><div class="res-json">${esc(json)}</div>`;
  }
  function renderError(err, where) {
    clearHL();
    const info = (err.info && err.info.type) || (err.name === "FormulaError" ? "FormulaError" : err.name);
    $("result").innerHTML = `<div class="err-type">${esc(where)}错误 · ${esc(info)}</div><div class="err-msg">${esc(err.message)}</div>`;
    if (err.node && err.node.nid != null) {
      const a = document.querySelector(`#ast .astn[data-nid="${err.node.nid}"]`); if (a) a.classList.add("hl");
      const b = document.querySelector(`#bc .ins[data-nid="${err.node.nid}"]`); if (b) b.classList.add("cur");
    }
  }
  function clearHL() { document.querySelectorAll("#ast .astn.hl").forEach((e) => e.classList.remove("hl")); }

  /* ================= trace ================= */
  function clearTrace() { $("trace").innerHTML = ""; }
  function logTrace(kind, text) {
    const host = $("trace");
    const div = document.createElement("div"); div.className = "tl k-" + kind;
    div.innerHTML = `<span class="tdot"></span><span class="ttxt">${esc(text)}</span>`;
    host.appendChild(div); host.scrollTop = host.scrollHeight;
  }

  /* ================= row data 渲染 ================= */
  function resetExec() {
    $("frames").innerHTML = '<div class="binds-empty">（未运行）</div>';
    $("stack").innerHTML = '<div class="stack-empty">（空栈）</div>';
    $("binds").innerHTML = '<div class="binds-empty">（无绑定）</div>';
    $("curins").className = "curins idle"; $("curins").textContent = "尚未运行 · 点「单步」开始";
    const ovl = $("execpane").querySelector(".frozen-ovl"); if (ovl) ovl.remove();
  }
  function renderRowData() {
    const host = $("rowtab"); host.innerHTML = "";
    Object.keys(rowData).forEach((name) => {
      const slot = rowData[name];
      const cell = document.createElement("div"); cell.className = "cell";
      const pname = document.createElement("span"); pname.className = "pname"; pname.textContent = name;
      const pval = document.createElement("input"); pval.className = "pval"; pval.value = displayVal(slot.box); pval.spellcheck = false;
      pval.addEventListener("change", () => { slot.box = parseCellValue(pval.value); pval.value = displayVal(slot.box); });
      const tog = document.createElement("span");
      const setTog = () => { tog.className = "statetog " + (slot.loaded ? "st-loaded" : "st-cold"); tog.textContent = slot.loaded ? "已加载" : "冷 · 需取数"; };
      setTog();
      tog.addEventListener("click", () => { slot.loaded = !slot.loaded; setTog(); });
      cell.appendChild(pname); cell.appendChild(pval); cell.appendChild(tog);
      host.appendChild(cell);
    });
  }
  function displayVal(b) { return b.type === "text" ? NFE.plainText(b) : b.type === "checkbox" ? (b.value ? "true" : "false") : shortBox(b); }
  function renderUsedProps(used) {
    const host = $("usedprops"); host.innerHTML = "";
    if (!used.size) { host.innerHTML = '<span style="color:var(--faint)">本公式未引用任何 prop()。</span>'; return; }
    const lab = document.createElement("span"); lab.textContent = "本公式引用："; host.appendChild(lab);
    used.forEach((p) => { const s = rowData[p]; const span = document.createElement("span"); span.className = "pp"; span.style.color = s && !s.loaded ? "var(--amber)" : "var(--green)"; span.textContent = p + (s && !s.loaded ? " · 冷" : ""); host.appendChild(span); });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  /* ================= 批处理演示 ================= */
  const BROWS = [
    { name: "R1·c500", ids: ["a", "b", "c"] },
    { name: "R2·c499", ids: ["b", "c", "d"] },
    { name: "R3·c501", ids: ["c", "d", "e"] },
    { name: "R4·c498", ids: ["a", "e"] },
  ];
  function renderBCells() {
    const host = $("bcells"); host.innerHTML = "";
    BROWS.forEach((r, ri) => {
      const div = document.createElement("div"); div.className = "bcell"; div.dataset.ri = ri;
      div.innerHTML = `<div class="bc-h">${esc(r.name)}</div><div class="ids">${r.ids.map((id) => `<span class="idtok" data-id="${id}">${id}</span>`).join("")}</div><div class="bc-state" data-state>就绪</div>`;
      host.appendChild(div);
    });
    const naive = BROWS.reduce((s, r) => s + r.ids.length, 0);
    $("t-naive").textContent = naive;
    $("t-batched").textContent = "1";
  }
  function markTokens(cls) { document.querySelectorAll("#bcells .idtok").forEach((t) => { t.classList.remove("susp", "inflight", "done"); if (cls) t.classList.add(cls); }); }
  async function runBatch() {
    const btn = $("btn-batch"); btn.disabled = true;
    renderBCells();
    const setStates = (txt) => document.querySelectorAll("#bcells [data-state]").forEach((e) => e.textContent = txt);
    $("batchphase").textContent = "① 各派生格求值 → 在 loadToken 处挂起（SUSP）";
    markTokens(""); setStates("SUSP · 挂起");
    document.querySelectorAll("#bcells .idtok").forEach((t) => t.classList.add("susp"));
    await delay(900);
    const uniq = [...new Set(BROWS.flatMap((r) => r.ids))];
    $("batchphase").textContent = `② 调度层合并 + 去重 → 批量取数 ${uniq.length} 条唯一记录（INFLIGHT）`;
    setStates("BATCH · 等待批量");
    document.querySelectorAll("#bcells .idtok").forEach((t) => { t.classList.remove("susp"); t.classList.add("inflight"); });
    await delay(1100);
    $("batchphase").textContent = "③ 一次往返返回 → 唤醒全部挂起的生成器（RESUME）";
    setStates("RESUME · 恢复");
    document.querySelectorAll("#bcells .idtok").forEach((t) => { t.classList.remove("inflight"); t.classList.add("done"); });
    await delay(500);
    const naive = BROWS.reduce((s, r) => s + r.ids.length, 0);
    $("batchphase").textContent = `完成 · 朴素 ${naive} 次往返 → 合并后 1 次往返（批量 ${uniq.length} 条）`;
    setStates("DONE");
    btn.disabled = false;
  }

  /* ================= 绑定事件 ================= */
  function initExamples() {
    const host = $("examples"); host.innerHTML = "";
    EXAMPLES.forEach((ex) => {
      const b = document.createElement("button"); b.className = "ex"; b.textContent = ex.t;
      b.addEventListener("click", () => { if (ex.setup) ex.setup(); $("formula").value = ex.f; compileNow(); });
      host.appendChild(b);
    });
  }
  function init() {
    initExamples();
    renderRowData();
    renderBCells();
    $("btn-compile").addEventListener("click", compileNow);
    $("formula").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); compileNow(); } });
    $("btn-step").addEventListener("click", doStep);
    $("btn-auto").addEventListener("click", () => { if (mode === "real") { if (!busy) startRun(); } else setAutoplay(!autoplay); });
    $("btn-reset").addEventListener("click", resetRun);
    $("btn-batch").addEventListener("click", runBatch);
    $("speed").addEventListener("input", (e) => { speed = +e.target.value; if (autoplay && mode === "teach") setAutoplay(true); });
    $("delay").addEventListener("input", (e) => { fetchDelay = +e.target.value; });
    $("modeseg").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]"); if (!btn) return;
      mode = btn.dataset.mode;
      [...$("modeseg").children].forEach((c) => c.classList.toggle("on", c === btn));
      resetRun();
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight") { e.preventDefault(); if (mode === "teach") doStep(); }
    });
    compileNow();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
