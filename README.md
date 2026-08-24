# DomLingo（原页译）

[![CI](https://github.com/FLF-Gamer/DomLingo/actions/workflows/ci.yml/badge.svg)](https://github.com/FLF-Gamer/DomLingo/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

DomLingo 是一个 Chrome 网页翻译扩展。它使用你自己的大模型 API，把英文网页正文原位翻译成简体中文，同时尽量保持页面的 DOM 结构、样式、链接和交互不变。

无需注册 DomLingo 账号，也没有 DomLingo 中转服务器。你只需要准备一个 OpenAI-compatible 模型服务，或者在本机运行 Ollama。

> 当前项目处于 Alpha 阶段，尚未发布到 Chrome Web Store。M2 静态正文翻译闭环已经完成，动态新增内容和翻译缓存将在后续版本实现。

> **最快使用方式：** 完成一次模型配置后，在普通网页的任意位置点击右键，选择“DomLingo：AI 翻译当前页面”，无需先打开插件弹窗。

## 主要功能

- 用户主动点击后才翻译当前页面；
- 只识别和翻译正文，跳过导航栏、侧边栏、页脚、广告和代码控件；
- 支持 DeepSeek、OpenRouter、OpenAI、硅基流动、Ollama 和自定义 OpenAI-compatible 服务；
- 自动探测 JSON Schema、JSON Mode 或普通 Prompt 兼容模式；
- 并行翻译独立语义块，完成的段落立即原位显示，不被较慢的前置批次阻塞；
- 支持在网页右键菜单中直接选择“DomLingo：AI 翻译当前页面”；
- 支持停止翻译、重试失败内容和精确恢复原文；
- 关闭插件弹窗后继续翻译，刷新、关闭标签页或同标签页导航时停止旧会话；
- API Key 使用本机设备密钥加密保存，模型 API 域名按需授权。

## 安装

### GitHub Releases

从 [GitHub Releases](https://github.com/FLF-Gamer/DomLingo/releases) 下载最新的 `domlingo-chrome-unpacked-<version>.zip`：

1. 解压下载的 ZIP；
2. 打开 `chrome://extensions`；
3. 开启右上角“开发者模式”；
4. 点击“加载已解压的扩展程序”；
5. 选择解压后的扩展目录。

GitHub 开发者版本不会自动更新。Chrome Web Store 版本将在项目稳定后提供。

### 从源码安装最新开发版本

如果希望体验尚未发布的最新代码，可以从源码构建：

环境要求：

- Node.js 22 或更高版本；
- pnpm 11；
- Google Chrome。

```bash
git clone https://github.com/FLF-Gamer/DomLingo.git
cd DomLingo
pnpm install --frozen-lockfile
pnpm build
```

然后打开 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择：

```text
DomLingo/.output/chrome-mv3/
```

更新源码后需要重新运行 `pnpm build`，并在扩展管理页面点击 DomLingo 的“重新加载”。

## 配置模型

1. 点击 Chrome 工具栏中的 DomLingo 图标；
2. 点击“打开设置”；
3. 选择服务预设，或选择“自定义 OpenAI-compatible”；
4. 检查 API 地址，填写 API Key 和模型名称；Ollama 等无需鉴权的本地服务可以不填 API Key；
5. 将并发请求数设为 `2` 或 `3`；`1` 适合兼容性诊断，但长页面会明显变慢；
6. 点击“测试连接并保存”；
7. Chrome 询问模型 API 域名权限时，确认授权。

测试成功后，设置页会显示探测到的结构化输出模式。预设只负责填写常用地址和示例字段，不提供公共 API Key；模型调用费用和数据处理规则由你选择的服务商决定。

远程模型服务必须使用 HTTPS。本机 Ollama 可以使用 `http://localhost` 或 `http://127.0.0.1`。

## 翻译网页

### 方法一：右键翻译（推荐）

1. 打开一个包含英文正文的普通 HTTP/HTTPS 网页；
2. 在网页任意位置点击鼠标右键；
3. 选择“DomLingo：AI 翻译当前页面”；
4. 在页面右下角查看翻译进度。

点击菜单项后会立即开始翻译，不需要先打开插件弹窗。如果尚未完成模型配置，DomLingo 会自动打开设置页；保存配置后，返回网页再次选择右键菜单即可。

### 方法二：插件弹窗

如果习惯使用 Chrome 工具栏，也可以通过插件弹窗开始翻译：

1. 打开一个包含英文正文的普通网页；
2. 点击 Chrome 工具栏中的 DomLingo 图标；
3. 点击“翻译当前页面”；
4. 在弹窗或页面右下角查看进度。

翻译开始后可以关闭弹窗，任务会继续运行。根据当前状态，还可以执行：

- **停止翻译**：停止后续请求，已经成功写入的译文继续保留；
- **重试失败内容**：只重新发送尚未成功翻译的内容；
- **恢复原文**：恢复本次会话修改的文本，不覆盖网站后来主动更新的节点。

点击会打开新标签页的链接时，原标签页仍会继续翻译；在同一个标签页内刷新或跳转到其他网址时，旧翻译会话会停止。在 SPA 路由切换后，需要重新点击“翻译当前页面”。

## 支持范围与已知限制

当前版本适合普通 HTTP/HTTPS 英文文章、文档站和富文本正文。

暂不支持或不保证完整处理：

- Chrome 内部页面、Chrome Web Store 页面和浏览器原生 PDF 阅读器；
- 图片、Canvas、视频字幕、OCR、EPUB 和漫画文字；
- 跨域 iframe、closed Shadow DOM 和尚未创建 DOM 的虚拟列表内容；
- 自动翻译动态新增内容或 SPA 新路由正文；
- 导航栏、全局侧边栏、页脚、广告等非正文区域；
- 绕过登录、订阅、付费墙、DRM 或其他访问控制；
- 整站抓取、完整译文导出、托管或公开分享。

其他已知情况：

- 翻译质量、速度和费用取决于所选模型服务；
- 并发数为 `1` 时长页面会明显变慢，日常使用建议设置为 `2` 或 `3`；
- 部分模型可能返回被截断或不符合格式的结果，可以使用“重试失败内容”继续补齐；
- 停止或关闭标签页只能取消客户端等待和后续批次，已经到达模型服务的请求仍可能被处理和计费。

## 隐私与安全

- DomLingo 没有用户账号、云端后端或请求中转服务；
- 只有你主动点击翻译后，识别出的网页正文才会直接发送到所选模型服务；
- API Key 使用本设备不可导出的密钥加密保存在扩展存储中，明文只在可信扩展会话中使用；
- 普通设置使用 Chrome Sync，API Key 默认不会进入同步存储；
- 安装权限保持为 `activeTab`、`contextMenus`、`scripting` 和 `storage`；`contextMenus` 只用于添加单项右键翻译入口，模型 API 域名在测试连接时单独申请；
- 不读取 Cookie、密码字段、认证令牌或浏览器凭据；
- 不上传正文、API Key、浏览历史或使用统计到 DomLingo 服务。

使用第三方模型前，请同时阅读该服务商的隐私政策和数据保留规则。

## 常见问题

### 为什么“翻译当前页面”不可用？

先打开设置并完成“测试连接并保存”。Chrome 内部页面、扩展商店和其他受保护页面不允许扩展注入脚本。

### 为什么翻译长时间停在某个数字？

模型可能正在处理、拆分或重试某个语义块。其他已经完整翻译的段落会继续显示；同一长段落的所有子段完成前，该段会暂时保持原文。确认并发数不是 `1`，检查模型服务是否限流；如果最终显示失败，可以点击“重试失败内容”。

### 为什么有些内容没有翻译？

DomLingo 只翻译识别出的正文。代码、导航控件、隐藏内容和非正文区域会被主动排除；模型漏回或输出截断的节点会保留原文。

### 网页正文会发送到哪里？

正文只会发送到设置页中显示的模型 API 地址，不经过 DomLingo 服务器。

## 开发与贡献

安装依赖并启动开发构建：

```bash
pnpm install
pnpm dev
```

运行完整质量检查：

```bash
pnpm check
```

项目使用 TypeScript、React、WXT 和 Chrome Manifest V3。提交改动前请阅读 [贡献指南](CONTRIBUTING.md)；Bug 和功能建议可以通过 [GitHub Issues](https://github.com/FLF-Gamer/DomLingo/issues) 提交，安全问题请按照 [安全政策](SECURITY.md) 报告。

## 项目文档

- [产品需求文档（PRD）](docs/product-requirements.md)
- [技术设计文档（TDD）](docs/technical-design.md)
- [项目状态与开发路线图](docs/development-roadmap.md)
- [更新记录](CHANGELOG.md)

## 开源协议

DomLingo 使用 [Apache License 2.0](LICENSE) 开源。
