/**
 * load-smoke.cjs —— 「插件到底能不能加载」的离线冒烟测试
 *
 * 为什么需要它：命令面板空白既可能是"命令被隐藏"，也可能是"onload 抛错整插件没起来"，
 * 两者在界面上表现完全一样。这个脚本用最小桩件把真实的 main.js 跑一遍 onload，
 * 直接把注册到的命令列出来 —— 能不能加载、注册了几条，一跑就知道。
 *
 * 运行：npm run test:load
 */

const Module = require("module");
const path = require("path");
const { JSDOM } = require("jsdom");

/* ── 1. 给 pdf.js 准备 DOM 环境（与 test/run.cjs 一致） ─────────────── */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "app://obsidian.md/",
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.DOMMatrix = dom.window.DOMMatrix;
global.ImageData = dom.window.ImageData;
global.Path2D = dom.window.Path2D;

/* ── 2. 万能桩件：任何 obsidian 导出都返回一个既能 new 又能调的函数 ──── */
const stubCache = new Map();
function stubFn(name) {
  if (stubCache.has(name)) return stubCache.get(name);
  const f = function stub() {
    return undefined;
  };
  f.prototype = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === "constructor") return f;
        if (p === "then") return undefined; // 别让它看起来像 thenable
        return stubFn(String(p));
      },
      set() {
        return true;
      },
    },
  );
  const proxy = new Proxy(f, {
    get(t, p) {
      if (p === "prototype") return t.prototype;
      if (p === "name") return name;
      if (p === "call" || p === "apply" || p === "bind") return t[p].bind(t);
      return stubFn(String(p));
    },
    apply() {
      return undefined;
    },
    construct() {
      return {};
    },
  });
  stubCache.set(name, proxy);
  return proxy;
}

const obsidianStub = new Proxy(
  {},
  {
    get(_t, p) {
      if (typeof p !== "string") return undefined;
      if (p === "__esModule") return false;
      return stubFn(p);
    },
  },
);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

/* ── 3. 造一个假 app：只提供 onload 真正会碰到的几处 ──────────────────── */
const commands = [];
const settingTabs = [];
const ribbonIcons = [];
const views = [];
const domEvents = [];
const workspaceEvents = [];

const fakeWorkspace = {
  on: (evt, cb) => {
    workspaceEvents.push(evt);
    return { evt, cb };
  },
  getActiveViewOfType: () => null,
  getActiveFile: () => null,
  getLeaf: () => stubFn("leaf"),
  getLeavesOfType: () => [],
  setActiveLeaf: () => undefined,
  detachLeavesOfType: () => undefined,
  // 三块工作区根：用不同的空对象，才能验证 isInSidebar 真的在比较引用
  rootSplit: { kind: "root" },
  leftSplit: { kind: "left" },
  rightSplit: { kind: "right" },
  activeLeaf: null,
  onLayoutReady: (cb) => cb(),
};

const fakeApp = {
  workspace: fakeWorkspace,
  vault: { getName: () => "load-smoke-vault" },
  metadataCache: { getFirstLinkpathDest: () => null },
  lastMarkdownPath: null,
};

const fakeThis = {
  app: fakeApp,
  manifest: { id: "pdf-annotator", version: "0.0.0-smoke" },
  settings: {},
  lastMarkdownPath: null,
  addCommand: (c) => commands.push(c),
  addSettingTab: (t) => settingTabs.push(t),
  registerView: (type, factory) => views.push({ type, factory }),
  registerEvent: () => ({ unregister() {} }),
  registerDomEvent: (el, evt) => domEvents.push(evt),
  register: (fn) => fn,
  addRibbonIcon: (icon, title) => {
    ribbonIcons.push({ icon, title });
    return stubFn("ribbon");
  },
  loadData: async () => null,
  saveData: async () => undefined,
};

/* ── 4. 真加载 main.js 并跑 onload ──────────────────────────────────── */
(async () => {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const manifestPath = path.join(__dirname, "..", "manifest.json");
  const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf8"));
  const manifest = JSON.parse(require("fs").readFileSync(manifestPath, "utf8"));

  const problems = [];
  if (pkg.version !== manifest.version) {
    problems.push(`package.json (${pkg.version}) 与 manifest.json (${manifest.version}) 版本不一致`);
  }

  const mod = require(path.join(__dirname, "..", "main.js"));
  const PluginClass = mod.default;
  if (typeof PluginClass !== "function") {
    problems.push("main.js 没有 default 导出插件类（Obsidian 会直接报加载失败）");
  }

  fakeThis.manifest.version = manifest.version;
  /*
   * 先把假宿主的属性抄成**自有属性**，再把原型换成插件类 ——
   * onload 里会调自己的实例方法（比如 closeSidebarPdfLeaves），裸对象上根本没有，
   * 会误报"onload 抛异常"。
   * 注意顺序：不能写成 Object.assign(Object.create(proto), fakeThis)，
   * 因为 obsidian 桩件的原型是 Proxy，set 陷阱直接吞掉赋值，属性一个都抄不进去。
   */
  const pluginThis = { ...fakeThis };
  Object.setPrototypeOf(pluginThis, PluginClass.prototype);
  await PluginClass.prototype.onload.call(pluginThis);

  console.log(`\n=== 加载 ${manifest.name} v${manifest.version} ===`);
  console.log(`视图:        ${views.map((v) => v.type).join(", ") || "(无)"}`);
  console.log(`功能区图标:  ${ribbonIcons.map((r) => r.title).join(", ") || "(无)"}`);
  console.log(`设置页:      ${settingTabs.length} 个`);
  console.log(`命令 (${commands.length} 条):`);
  for (const c of commands) {
    const kind = c.callback ? "callback " : c.checkCallback ? "checkCb  " : "editor?  ";
    const hotkey = c.hotkeys?.length ? `  [${c.hotkeys.map((h) => `${h.modifiers.join("+")}+${h.key}`).join(", ")}]` : "";
    console.log(`  - ${kind}| ${c.id.padEnd(26)} | ${c.name}${hotkey}`);
  }

  /* 断言：命令必须常驻可见（用 callback），否则命令面板搜不到 */
  const hidden = commands.filter((c) => !c.callback);
  if (hidden.length > 0) {
    problems.push(
      `有 ${hidden.length} 条命令不是 callback 而是 checkCallback —— 条件不满足时会从命令面板消失：` +
        hidden.map((c) => c.id).join(", "),
    );
  }
  if (commands.length === 0) problems.push("onload 没有注册任何命令（插件等于没起来）");
  if (views.length === 0) problems.push("onload 没有注册视图");
  if (domEvents.length === 0) problems.push("没有注册链接点击拦截");

  if (problems.length > 0) {
    console.error("\n加载冒烟测试失败：");
    for (const p of problems) console.error("  x " + p);
    process.exit(1);
  }
  console.log("\n加载冒烟测试通过：onload 无异常，命令全部常驻可见。\n");
})().catch((err) => {
  console.error("\n加载冒烟测试失败：onload 抛异常 —— 这正是 Obsidian 里命令全消失的原因。");
  console.error(err);
  process.exit(1);
});
