// 冒烟测试的运行时外壳：先给 pdf.js 准备一个最小 DOM 环境，再加载测试包。
const { JSDOM } = require("jsdom");

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

// pdf.js 会读 location / devicePixelRatio
if (!global.window.devicePixelRatio) {
  Object.defineProperty(global.window, "devicePixelRatio", { value: 2, configurable: true });
}

require("./_bundle.cjs");
