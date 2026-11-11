/**
 * settingsTab.ts —— 设置面板
 *
 * ── 面板设计的三条原则 ──────────────────────────────────────────────
 * ① **一处配置，一处解释**。Provider / Base URL / Key / 模型紧挨着放，
 *    因为它们是"同一个失败"的四个可能原因；把说明散到文档里等于没有说明。
 * ② **能自检的就自检**。「测试连接」发一个 max_tokens=1 的真实请求，
 *    把 401 / 404 / 网络错误翻译成人话 —— 比让用户去控制台看 CORS 报错强得多。
 * ③ **流式的代价写在开关旁边**。开了流式就换成 fetch，就会撞 CORS。
 *    这不是"进阶选项"，而是会让人以为插件坏了的坑，必须当场说清。
 */

import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, Plugin } from "obsidian";
import { AI_PRESETS, presetOf, type AiProvider, type AiSettings } from "./types";
import type { PluginSettings } from "./settings";
import { fetchModels, testConnection } from "./client";

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
}

export class PdfAnnotatorSettingTab extends PluginSettingTab {
  private testResultEl: HTMLElement | null = null;
  private modelListEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly host: Plugin & SettingsHost,
  ) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("pdfa-settings");
    const ai = this.host.settings.ai;

    /* ============================ AI 伴读 ============================ */
    new Setting(containerEl).setName("AI 伴读").setHeading();

    containerEl.createEl("p", {
      cls: "pdfa-settings-lead",
      text:
        "选中文字后，在浮动工具栏点 ✨ 即可翻译 / 解释 / 总结。结果会把「PDF 选区链接 + 原文引用 + AI 解读」一起插进笔记，" +
        "所以笔记里留下的仍然是纯 Markdown。",
    });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("OpenAI 兼容与 Ollama 走的是同一套请求（Ollama 自带 /v1/chat/completions），只是默认值不同。")
      .addDropdown((dd) => {
        for (const p of AI_PRESETS) dd.addOption(p.id, p.label);
        dd.setValue(ai.provider).onChange(async (value) => {
          const prev = presetOf(ai.provider);
          const next = presetOf(value as AiProvider);
          ai.provider = value as AiProvider;
          // 只有当用户没改过默认值时才自动带出，避免手填的地址被覆盖
          if (ai.baseUrl.trim() === prev.baseUrl) ai.baseUrl = next.baseUrl;
          if (ai.model.trim() === prev.model || !ai.model.trim()) ai.model = next.model;
          await this.host.saveSettings();
          this.display();
        });
      });

    containerEl.createEl("p", { cls: "pdfa-settings-hint", text: presetOf(ai.provider).hint });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("写到 /v1 为止，不要带 /chat/completions（写全了也认）。Ollama 默认 http://localhost:11434/v1")
      .addText((t) =>
        t
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(ai.baseUrl)
          .onChange(async (v) => {
            ai.baseUrl = v.trim();
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc(ai.provider === "ollama" ? "Ollama 不需要，留空即可。" : "保存在插件目录的 data.json 里，不会上传。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.setPlaceholder(ai.provider === "ollama" ? "（可留空）" : "sk-…")
          .setValue(ai.apiKey)
          .onChange(async (v) => {
            ai.apiKey = v.trim();
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("Ollama 要带 tag，例如 qwen2.5:7b；OpenAI 兼容服务按对方文档填。")
      .addText((t) =>
        t
          .setPlaceholder("gpt-4o-mini")
          .setValue(ai.model)
          .onChange(async (v) => {
            ai.model = v.trim();
            await this.host.saveSettings();
          }),
      )
      .addButton((b) =>
        b.setButtonText("拉取列表").onClick(async () => {
          b.setDisabled(true).setButtonText("…");
          const { models, error } = await fetchModels(ai);
          b.setDisabled(false).setButtonText("拉取列表");
          this.renderModelList(models, error);
        }),
      );

    this.modelListEl = containerEl.createDiv({ cls: "pdfa-model-list" });

    new Setting(containerEl)
      .setName("温度")
      .setDesc("越低越稳定。翻译/总结建议 0.2~0.4；要发散的解释可以到 0.7。")
      .addSlider((s) =>
        s
          .setLimits(0, 1.5, 0.1)
          .setValue(ai.temperature)
          .setDynamicTooltip()
          .onChange(async (v) => {
            ai.temperature = v;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("输出上限（tokens）")
      .setDesc("0 = 交给服务端默认。选段很长时可调到 1500 以上。")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(ai.maxTokens)).onChange(async (v) => {
          const n = Number(v);
          ai.maxTokens = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("翻译目标语言")
      .setDesc("auto = 中文选段译成英文，其它语言译成中文。")
      .addDropdown((dd) =>
        dd
          .addOption("auto", "自动")
          .addOption("zh", "简体中文")
          .addOption("en", "English")
          .addOption("ja", "日本語")
          .setValue(ai.targetLang)
          .onChange(async (v) => {
            ai.targetLang = v as AiSettings["targetLang"];
            await this.host.saveSettings();
          }),
      );

    /* ---------------- 流式：必须把代价讲清楚 ---------------- */
    new Setting(containerEl)
      .setName("流式输出（打字机效果）")
      .setDesc("开着更爽，但它不是「纯增强」——下面三条是真实代价。")
      .addToggle((t) =>
        t.setValue(ai.stream).onChange(async (v) => {
          ai.stream = v;
          await this.host.saveSettings();
          if (v && ai.provider === "ollama") {
            new Notice("Ollama 记得设置 OLLAMA_ORIGINS=app://obsidian.md 并重启服务", 6000);
          }
        }),
      );

    const streamHint = containerEl.createEl("p", { cls: "pdfa-settings-hint" });
    streamHint.appendText("① 流式只能走 fetch，会受 CORS 限制：Ollama 需设置环境变量 ");
    streamHint.createEl("code", { text: "OLLAMA_ORIGINS=app://obsidian.md" });
    streamHint.appendText(" 后重启 ollama serve；");
    streamHint.createEl("br");
    streamHint.appendText("② 手机上的 localhost 指手机自己，连不到电脑上的 Ollama；");
    streamHint.createEl("br");
    streamHint.appendText("③ 流式失败时插件会自动降级为普通请求，结果照常拿到，只是没有打字机效果。");

    new Setting(containerEl)
      .setName("插入笔记时附带原文引用")
      .setDesc("关掉就只插「链接 + AI 解读」，适合正文已经很清楚的场景。")
      .addToggle((t) =>
        t.setValue(ai.includeQuote).onChange(async (v) => {
          ai.includeQuote = v;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("发一个最小请求，验证地址 / 密钥 / 模型三件事是否都对。")
      .addButton((b) =>
        b
          .setButtonText("测试")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("测试中…");
            const r = await testConnection(ai);
            b.setDisabled(false).setButtonText("测试");
            this.renderTestResult(r.ok, r.message);
          }),
      );

    this.testResultEl = containerEl.createDiv({ cls: "pdfa-test-result" });

    /* ============================ 便签 ============================ */
    new Setting(containerEl).setName("富文本便签").setHeading();

    containerEl.createEl("p", {
      cls: "pdfa-settings-lead",
      text:
        "便签正文不塞进 PDF 链接，而是写进与 PDF 同名的伴生笔记里的一段 Callout，并打上 `^pdfa-note-<id>` 块引用。" +
        "PDF 上的图钉就是指向这个块的锚点链接 —— 卸载插件后，笔记依旧可读、可跳。",
    });

    new Setting(containerEl)
      .setName("伴生笔记位置")
      .setDesc("source = 与 PDF 放在同一目录；folder = 统一放进下面的文件夹。")
      .addDropdown((dd) =>
        dd
          .addOption("source", "与 PDF 同目录")
          .addOption("folder", "统一文件夹")
          .setValue(this.host.settings.noteLocation)
          .onChange(async (v) => {
            this.host.settings.noteLocation = v === "folder" ? "folder" : "source";
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("统一文件夹")
      .setDesc("仅在上一项选「统一文件夹」时生效。")
      .addText((t) =>
        t.setValue(this.host.settings.noteFolder).onChange(async (v) => {
          this.host.settings.noteFolder = v.trim().replace(/^\/+|\/+$/g, "") || "PDF 批注";
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("笔记文件名后缀")
      .setDesc(`默认 ${"pdf-notes"}：论文.pdf → 论文 (${this.host.settings.noteSuffix}).md`)
      .addText((t) =>
        t.setValue(this.host.settings.noteSuffix).onChange(async (v) => {
          this.host.settings.noteSuffix = v.trim() || "pdf-notes";
          await this.host.saveSettings();
        }),
      );

    /* ============================ 打开方式 ============================ */
    new Setting(containerEl).setName("打开方式").setHeading();

    containerEl.createEl("p", {
      cls: "pdfa-settings-lead",
      text:
        "默认不动 Obsidian 自带的 PDF 查看器：本插件是从命令面板或侧边栏按需打开的批注视图。" +
        "如果原生查看器打不开某些 PDF（只有空白页、页码显示 0 / 0），可以在这里让本插件接管。",
    });

    new Setting(containerEl)
      .setName("用本插件打开 .pdf 文件")
      .setDesc(
        "开启后，双击文件列表里的 PDF 会直接进批注视图；关闭则回到原生查看器。" +
          "改动需要重启 Obsidian 才生效（Ctrl+R 或退出重开）。",
      )
      .addToggle((t) =>
        t.setValue(this.host.settings.openPdfInPlugin).onChange(async (v) => {
          this.host.settings.openPdfInPlugin = v;
          await this.host.saveSettings();
          new Notice(
            v
              ? "已开启接管 .pdf。重启 Obsidian 后生效；若原生查看器本来正常，建议关掉这一项。"
              : "已关闭接管 .pdf。重启 Obsidian 后恢复原生查看器。",
            6000,
          );
        }),
      );
  }

  /* ------------------------------------------------------------------ */

  private renderTestResult(ok: boolean, message: string): void {
    const el = this.testResultEl;
    if (!el) return;
    el.empty();
    el.addClass("is-visible");
    el.toggleClass("is-ok", ok);
    el.toggleClass("is-bad", !ok);
    el.createDiv({ cls: "pdfa-test-line", text: `${ok ? "✓" : "✗"} ${message.split("\n")[0]}` });
    const rest = message.split("\n").slice(1).join("\n");
    if (rest) el.createDiv({ cls: "pdfa-test-hint", text: rest });
  }

  private renderModelList(models: string[], error?: string): void {
    const el = this.modelListEl;
    if (!el) return;
    el.empty();
    if (error) {
      el.createDiv({ cls: "pdfa-test-result is-visible is-bad", text: `拉取失败：${error}` });
      return;
    }
    if (models.length === 0) {
      el.createDiv({ cls: "pdfa-test-result is-visible is-bad", text: "该服务没有返回任何模型（可能需要先 pull）" });
      return;
    }
    el.createDiv({ cls: "pdfa-model-list-title", text: `可用模型（${models.length}），点一下填入上方：` });
    const wrap = el.createDiv({ cls: "pdfa-model-chips" });
    for (const name of models.slice(0, 60)) {
      const chip = wrap.createEl("button", { cls: "pdfa-chip", text: name, attr: { type: "button" } });
      chip.onclick = async () => {
        this.host.settings.ai.model = name;
        await this.host.saveSettings();
        this.display();
        new Notice(`已选择模型 ${name}`);
      };
    }
  }
}
