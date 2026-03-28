# AI Daily Digest 🤖

> 每日 AI / LLM 领域资讯速递，自动抓取大牛博客和研究机构的最新文章。

## 数据来源

**🧠 大牛博客**
- Andrej Karpathy (特斯拉前AI总监)
- Simon Willison (独立研究员)
- Lilian Weng (OpenAI研究员)
- Jay Alammar (LLM可视化解释)

**🏢 研究机构**
- Hugging Face
- Google DeepMind
- Anthropic Research
- OpenAI Blog

**📰 中文媒体**
- 机器之心
- 36氪

## 功能

- 自动抓取 + 中英文翻译
- 每天早上 9:00 自动更新
- 深色主题精美 HTML 页面

## 本地运行

```bash
cd ~/ai-digest
node scraper.js
```

生成 `digest.html` 后，用浏览器打开即可预览。

## 部署

本项目适配 GitHub Pages 自动部署：
- 推送后 GitHub Actions 自动运行爬虫
- 访问 `https://Vir-Limerence.github.io/ai-digest`

## 技术栈

- Node.js (无依赖，纯原生实现)
- RSS / Jina Reader 混合抓取
- MyMemory API 翻译
- OpenClaw Cron 定时任务
