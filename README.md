# Notion Formula VM

> Notion 公式引擎 · 编译器 + 栈式虚拟机（教学复刻）

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-37%20passed-brightgreen.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/runtime%20deps-0-green.svg)]()

把一行 Notion 公式**编译成字节码**，再喂给一台**可挂起的栈式虚拟机**，并把语法树、字节码、调用栈、操作数栈、绑定、每一次取数挂起全部可视化、可单步。纯前端单文件 HTML，无任何运行时依赖（无框架、无 CDN、无 localStorage）。

实现忠于对 Notion 前端两个 rspack 模块的逆向：**448187**（VM + 编译器）与 **947152 / 942007**（函数目录 `formula2`）。是一台**纯 JavaScript 解释器**（非 WASM）。

<p align="center">
  <img src="https://github.com/user-attachments/assets/placeholder" alt="screenshot" width="800">
</p>

> **上方截图占位** — 首次推送后可截图替换，或直接删除此段。

---

## Quick Start

```bash
# 直接用：浏览器打开构建产物即可
open dist/notion-vm.html        # macOS（Windows 直接双击该文件）

# 从源码重建
npm run build                   # 等价于 bash build.sh，输出 dist/notion-vm.html

# 跑引擎测试（纯 Node，无需安装依赖）
npm test                        # 37 个公式 / 错误 / 挂起用例
npm run smoke                   # 单步驱动冒烟：打印每一步的栈 / 调用栈快照

# 端到端测试（需要 jsdom）
npm install                     # 安装 devDependency: jsdom
npm run e2e                     # 用无头 DOM 跑整页：编译→单步→挂起冻结→结果
```

`npm test` / `npm run smoke` 只依赖 `src/engine.js`，开箱即跑；`npm run e2e` 需要先 `npm install`。

---

## Project Structure

```
notion-vm/
├── README.md
├── LICENSE
├── package.json
├── build.sh                 # 组装 src/* → dist/notion-vm.html
├── src/
│   ├── engine.js            # 引擎：词法 / 语法 / 编译器 / 栈式 VM / lambda / runLets / 函数库（~590 行）
│   ├── ui.js                # UI 驱动 + 渲染：单步驱动、挂起冻结动画、各面板渲染
│   ├── style.css            # 样式：示波器 / 精密仪器风
│   └── body.html            # 页面结构
├── test/
│   ├── test.js              # 引擎单测（37 例：算术 / 精度 / lambda / let / if / 错误 / 挂起）
│   ├── step_smoke.js        # 单步驱动冒烟（验证 frame / stack 快照）
│   └── dom_smoke.mjs        # jsdom 端到端（验证 UI 渲染与挂起冻结）
└── dist/
    └── notion-vm.html       # 构建产物（自包含单文件）
```

**源码在 `src/`，`dist/notion-vm.html` 是构建产物。** 改逻辑请改 `src/`，再 `npm run build`。直接改 `dist` 会在下次构建时被覆盖。

---

## Architecture

一行公式如何被求值：

```
源码字符串
   │  tokenize()                词法：数字 / 字符串 / 标识符 / 中文 / 运算符 / and·or·not
   ▼
Token 流
   │  parse()                   递归下降 + 优先级爬升 → AST（每节点带 nid）
   ▼
AST
   │  compile() = I(node)       编译器：AST → 栈式字节码
   ▼
字节码（指令数组）
   │  F(instrs, ctx)            VM：生成器解释循环，逐条分派
   ▼
结果盒子 {type, value}
```

### Key Design Decisions（忠实复刻）

| 特性 | 说明 |
|------|------|
| **值盒子** | 栈元素一律 `{type, value}`；类型有 `number / text / checkbox / date / person / block / array / undefined / compiledCode` |
| **栈类** | `popValue()` 遇 `compiledCode` 抛错；`popValueOrCode()` 允许——lambda 机制的支柱 |
| **逆序压栈** | 二元运算 / 函数参数 / 数组项一律逆序发射，执行时 `pop` 重建书写顺序 |
| **VM 主循环** | `ip` 先自增后分派；跳转 `offset` 相对自增后的 `ip` |
| **if / ifs** | 编译期展开为 `jumpIfTruthy` / `relativeJump` 跳转字节码（短路求值的唯一来源） |
| **lambda** | 不是闭包，而是"字节码即数据"——惰性参数编成 `loadConstant(compiledCode)`；库函数内 `yield* F(子字节码)` 再入 VM |
| **let / lets** | 编成 `runLets` 指令，逐个绑定求值后压入 `ctx.values` 头部 |
| **算术语义** | 整数走原生快路径，小数走任意精度（`0.1 + 0.2 = 0.3`）；除零 → `undefined` |
| **可挂起取数** | `prop("X")` 编成 `loadToken`，求值时 `yield {recordPointers}` 挂起；调度器取回后 `.next(model)` 从同一点恢复 |

### Teaching Enhancements

VM 在每条指令前额外 `yield {t:'step'}` 作为教学暂停点，便于逐指令单步；真正的挂起点是 `loadToken` 处的 `yield {t:'fetch'}`。UI 的"教学 / 真实"两种模式正是据此区分。

---

## Supported Functions

真实目录是 **31 算子 + 65 函数**（`formula2`）。本复刻实现了覆盖全部机制的代表子集：

| 分类 | 函数 |
|------|------|
| **逻辑** | `and` `or` `not` `empty` |
| **数学** | `divide` `mod` `abs` `sign` `sqrt` `floor` `ceil` `round` `min` `max` `sum` `mean` `count` |
| **字符串** | `concat` `length` `contains` `upper` `lower` `trim` `replace` `format` |
| **列表（高阶）** | `map` `filter` `find` `some` `every` `sort` `unique` `slice` `first` `last` `at` `includes` `flat` |
| **日期** | `now` `today` `dateAdd` `dateBetween` `year` `month` `day` `formatDate` |
| **实体** | `id` |
| **运算符** | `+` `-` `*` `/` `%` `^` `==` `!=` `<` `<=` `>` `>=` `and` `or` |
| **控制结构** | `if` `ifs` `let` `lets` |

日期与本地化（时区换算、`formatNumber` 语法等）做了教学简化。

---

## Formula Syntax

```
42                           # 数字字面量
3.14                         # 浮点数
"文本"                       # 字符串
true / false                 # 布尔
[1, 2, 3]                    # 数组

prop("列名")                 # 读当前行属性（触发挂起取数）
name(a, b, ...)              # 函数调用
[1,2,3].map(current * 2)     # 方法链语法
filter(xs, current > 10)     # lambda：隐式绑定 current（当前元素）与 index（下标）
let(x, 10, x * x)           # 绑定
lets(a, 1, b, 2, a + b)     # 多绑定
```

---

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`npm test`)
4. Commit your changes
5. Push and open a Pull Request

---

## License

[MIT](LICENSE)

逆向资料与语义来自对公开前端产物的静态分析，仅供学习与复刻参考。
