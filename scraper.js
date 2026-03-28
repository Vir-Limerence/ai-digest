#!/usr/bin/env node
/**
 * AI Daily Digest Scraper v4
 * RSS (fast) + Jina Reader (reliable)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_HTML = join(__dirname, 'digest.html');
const OUTPUT_JSON = join(__dirname, 'digest.json');
const JINA_BASE = 'https://r.jina.ai';
const TRANSLATE_BATCH_SIZE = 10;

const httpsGet = async (url, timeout = 15000) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,zh-CN;q=0.5',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok && res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  }
};

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function cleanTranslation(text) {
  if (!text) return '';
  if (text.includes('MYMEMORY') || text.includes('translated.net')) return '';
  if (text.includes('error') && text.length < 100) return '';
  return text;
}

async function translateToChinese(text) {
  if (!text || hasChinese(text) || text.trim().length < 3) return text;
  const clean = text.trim();
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|zh-CN`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    const t = json?.responseData?.translatedText;
    if (t && t !== clean && !t.includes('MYMEMORY') && t.length > 3) return cleanTranslation(t);
  } catch (e) {}
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh&dt=t&q=${encodeURIComponent(clean)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    if (json && json[0] && json[0][0] && json[0][0][0]) return cleanTranslation(json[0][0][0]);
  } catch (e) {}
  return text;
}

async function translateItems(items) {
  let translated = 0;
  const total = items.length;
  for (let i = 0; i < items.length; i += TRANSLATE_BATCH_SIZE) {
    const batch = items.slice(i, i + TRANSLATE_BATCH_SIZE);
    const promises = batch.map(async (item) => {
      if (!hasChinese(item.title)) {
        const newTitle = await translateToChinese(item.title);
        if (newTitle !== item.title) { item.title = newTitle; translated++; }
      }
      if (item.description && !hasChinese(item.description)) {
        const newDesc = await translateToChinese(item.description.slice(0, 200));
        if (newDesc !== item.description) { item.description = newDesc; }
      }
    });
    await Promise.all(promises);
    if (i + TRANSLATE_BATCH_SIZE < total) await new Promise(r => setTimeout(r, 500));
    process.stdout.write(`\n🌏 翻译中 ${Math.min(i + TRANSLATE_BATCH_SIZE, total)}/${total}...`);
  }
  console.log(`\n   翻译了 ${translated} 个标题`);
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseRSS(xml, source) {
  // Expand CDATA first
  xml = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '$1');
  const items = [];
  const isAtom = xml.includes('<feed');
  const entryRegex = isAtom ? /<entry>([\s\S]*?)<\/entry>/gi : /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const e = match[1];
    const get = t => {
      const m = e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
      if (!m) return '';
      // Strip HTML tags first, then decode entities
      return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    };
    const title = get('title');
    const linkMatch = isAtom
      ? e.match(/<link[^>]+href="([^"]+)"/) || [null, get('link')]
      : [null, (e.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] || '').trim()];
    const link = linkMatch[1] || get('guid');
    const rawDate = get('published') || get('pubDate') || get('updated') || get('dc:date');
    const desc = get('description') || get('summary') || get('content');
    if (title && (link.startsWith('http') || !link)) {
      items.push({
        title: title.slice(0, 200),
        url: link.startsWith('http') ? link : (source.url + link),
        date: parseDate(rawDate),
        source: source.name,
        sourceId: source.id,
        description: desc.slice(0, 300),
        category: source.category,
      });
    }
  }
  return items;
}

function parseJina(markdown, source) {
  const items = [];
  if (!markdown || !markdown.includes('URL Source:')) return items;
  const seen = new Set();

  // Split markdown into sections by headings (for title extraction)
  // Then extract links from each section
  const badPatterns = /tag[s]?|\/tags?\/|subscribe|about|search|contact|privacy|terms|rss|feed|login|signin|signup|github\.com|facebook\.com|twitter\.com|linkedin\.com|instagram\.com|youtube\.com|cdn\.|storage\.|googleapis\.com|amazonaws\.com|figma\.com|notion\.so|linear\.app|slack\.com|jira\.|confluence|status\.io|support\.|help\.|\/blog\/category|\/blog\/author|\/authors?\/|cookie|cookiepolicy/i;

  // Find all links and their positions
  const re1 = /\[([^\]]{1,300})\]\((https?:\/\/[^\)]+)\)/g;
  const re2 = /\[\]\((https?:\/\/[^)]+)\)/g;
  const allLinks = [];
  let m;
  while ((m = re1.exec(markdown)) !== null) allLinks.push({ index: m.index, type: 1, match: m });
  re1.lastIndex = 0;
  while ((m = re2.exec(markdown)) !== null) allLinks.push({ index: m.index, type: 2, match: m });
  re2.lastIndex = 0;
  allLinks.sort((a, b) => a.index - b.index);

  for (const link of allLinks) {
    const url = link.match[2] || link.match[1];
    if (seen.has(url)) continue;
    if (badPatterns.test(url)) continue;

    // Domain-specific
    if (source.id === 'anthropic' && !/\/research\//.test(url) && !/anthropic\.com\/[a-z]/.test(url)) continue;
    if (source.id === 'deepmind' && !/deepmind\.(google\.)?com\/blog\//.test(url)) continue;
    if (source.id === 'openai' && !/openai\.com\/blog\//.test(url)) continue;
    if (source.id === 'jiqizhixin' && !/article/.test(url)) continue;
    if (source.id === '36kr-ai' && !/36kr\.com/.test(url)) continue;

    seen.add(url);

    // Find the heading that precedes this link (within 800 chars)
    const searchStart = Math.max(0, link.index - 800);
    const searchArea = markdown.slice(searchStart, link.index);
    let title = '';

    if (link.type === 2) {
      // Empty link [](): use preceding heading as title
      const headingMatch = searchArea.match(/#{1,3}\s+([^\n#]{5,200})/);
      title = headingMatch ? headingMatch[1].replace(/[*_`#]/g, '').trim() : url.split('/').pop().replace(/-/g, ' ');
    } else {
      title = link.match[1].trim();
      // For DeepMind: link text is often "Learn more", use preceding heading instead
      if (source.id === 'deepmind' && (/^learn more$/i.test(title) || title.length < 10)) {
        const headingMatch = searchArea.match(/#{1,3}\s+([^\n#]{5,200})/);
        if (headingMatch) title = headingMatch[1].replace(/[*_`#]/g, '').trim();
      }
      // Skip garbage
      if (title.length < 5) continue;
      if (title.startsWith('Image') || title.startsWith('![')) continue;
      if (/^[\d\s]+$/.test(title)) continue;
    }

    if (title.length < 3) continue;

    const contextStart = Math.max(0, link.index - 1500);
    const contextEnd = Math.min(markdown.length, link.index + link.match[0].length + 500);
    const context = markdown.slice(contextStart, contextEnd);
    const dm = context.match(/\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{1,2}\s+\w+\s+20\d{2})\b/i);
    const after = markdown.slice(link.index + link.match[0].length, link.index + link.match[0].length + 400);
    const em = after.match(/^[:\s\n]*([^.!?]{30,200}?)(?:[.!?\n]|$)/);
    const excerpt = em ? em[1].replace(/[*_`#\n]/g, ' ').trim() : '';

    items.push({ title, url, date: dm ? parseDate(dm[1]) : null, source: source.name, sourceId: source.id, description: excerpt, category: source.category });
  }

  return items;
}

async function fetchJina(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const content = await fetch(`${JINA_BASE}/${encodeURIComponent(url)}`, {
        headers: { 'Accept': 'text/plain', 'User-Agent': 'Mozilla/5.0' }
      }).then(r => r.text());
      if (content && content.includes('Markdown Content:')) return content;
      if (i < retries) await new Promise(r => setTimeout(r, 2000));
    } catch (e) { if (i < retries) await new Promise(r => setTimeout(r, 2000)); }
  }
  return '';
}

async function main() {
  const sources = JSON.parse(readFileSync(join(__dirname, 'sources.json'), 'utf8')).sources;
  const allItems = [];
  const errors = [];
  const now = new Date();

  console.log(`\n🤖 AI Daily Digest - ${now.toLocaleString('zh-CN')}`);
  console.log('='.repeat(50));

  for (const source of sources) {
    process.stdout.write(`\n📡 ${source.name} (${source.type})... `);
    try {
      let items = [];
      if (source.type === 'rss') {
        const xml = await httpsGet(source.url);
        items = parseRSS(xml, source);
      } else if (source.type === 'jina') {
        const md = await fetchJina(source.url);
        items = parseJina(md, source);
      }
      if (items.length > 0) {
        console.log(`✅ ${items.length}篇`);
        allItems.push(...items);
      } else {
        console.log(`⚠️ 0篇`);
        errors.push(source.id);
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      errors.push(source.id);
    }
  }

  const seen = new Set();
  const unique = allItems.filter(i => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });

  unique.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  console.log(`\n\n📊 共 ${unique.length} 篇 | 失败: ${errors.join(', ') || '无'}`);

  const recentCutoff = new Date(Date.now() - 48 * 3600 * 1000);
  const recentItems = unique.filter(i => i.date && new Date(i.date) >= recentCutoff);
  const recentCount = recentItems.filter(i => !hasChinese(i.title)).length;
  if (recentCount > 0) {
    console.log(`🌏 正在翻译最近 ${recentItems.length} 篇新文的标题...`);
    await translateItems(recentItems);
  }

  const data = { generated: now.toISOString(), count: unique.length, failed: errors, items: unique, recentCount: recentItems.length };
  writeFileSync(OUTPUT_JSON, JSON.stringify(data, null, 2));
  const html = generateHTML(data);
  writeFileSync(OUTPUT_HTML, html);
  console.log(`✅ 已生成: ${OUTPUT_HTML}`);
}

function generateHTML(data) {
  const recentCutoff = new Date(Date.now() - 48 * 3600 * 1000);
  const recentItems = data.items.filter(i => i.date && new Date(i.date) >= recentCutoff);
  const olderItems = data.items.filter(i => !i.date || new Date(i.date) < recentCutoff);
  const groups = {};
  olderItems.forEach(i => { (groups[i.category] = groups[i.category] || []).push(i); });
  const catNames = { '大牛': '🧠 大牛博客', '机构': '🏢 机构博客', '中文媒体': '📰 中文媒体' };

  let recentHTML = '';
  if (recentItems.length > 0) {
    recentHTML = `<div class="category-section"><h2 class="category-title">🔥 今日新文（48小时内，已翻译）</h2><div class="article-list">`;
    recentItems.forEach(item => {
      const d = item.date ? new Date(item.date) : null;
      const ds = d ? d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
      const ts = d ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      recentHTML += `<article class="article-card recent"><div class="article-meta"><span class="source-tag">${item.source}</span>${ds ? `<span class="date">${ds}</span>` : ''}${ts ? `<span class="time">${ts}</span>` : ''}</div><h3 class="article-title"><a href="${item.url}" target="_blank" rel="noopener">${item.title}</a></h3>${item.description ? `<p class="article-desc">${item.description}</p>` : ''}</article>`;
    });
    recentHTML += `</div></div>`;
  }

  let articlesHTML = '';
  for (const [cat, items] of Object.entries(groups)) {
    articlesHTML += `<div class="category-section"><h2 class="category-title">${catNames[cat] || cat}</h2><div class="article-list">`;
    items.forEach(item => {
      const d = item.date ? new Date(item.date) : null;
      const ds = d ? d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
      const ts = d ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      articlesHTML += `<article class="article-card"><div class="article-meta"><span class="source-tag">${item.source}</span>${ds ? `<span class="date">${ds}</span>` : ''}${ts ? `<span class="time">${ts}</span>` : ''}</div><h3 class="article-title"><a href="${item.url}" target="_blank" rel="noopener">${item.title}</a></h3>${item.description ? `<p class="article-desc">${item.description}</p>` : ''}</article>`;
    });
    articlesHTML += `</div></div>`;
  }

  const genTime = new Date(data.generated).toLocaleString('zh-CN');
  const failureNote = data.failed.length > 0 ? `<div class="failure-note">⚠️ 以下来源抓取失败: ${data.failed.join(', ')}</div>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Daily Digest - ${new Date().toLocaleDateString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --text-secondary: #8b949e; --accent: #58a6ff; --accent-hover: #79c0ff; --tag-bg: #1f6feb22; --tag-text: #58a6ff; --card-bg: #161b22; --recent-border: #238636; --recent-bg: #0d1917; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #0d1117 0%, #1a1f2e 100%); border-bottom: 1px solid var(--border); padding: 48px 24px 40px; text-align: center; }
    .header h1 { font-size: 2.2rem; font-weight: 700; background: linear-gradient(135deg, #58a6ff, #a371f7, #f778ba); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 12px; }
    .header .subtitle { color: var(--text-secondary); font-size: 0.95rem; }
    .stats { display: flex; justify-content: center; gap: 32px; margin-top: 20px; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat-num { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 0.8rem; color: var(--text-secondary); }
    .container { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; }
    .category-section { margin-bottom: 48px; }
    .category-title { font-size: 1.1rem; font-weight: 600; padding-bottom: 12px; border-bottom: 2px solid var(--accent); margin-bottom: 20px; display: inline-block; }
    .article-list { display: flex; flex-direction: column; gap: 16px; }
    .article-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; transition: all 0.2s; }
    .article-card:hover { border-color: var(--accent); transform: translateX(4px); box-shadow: 0 4px 20px rgba(88, 166, 255, 0.1); }
    .article-card.recent { background: var(--recent-bg); border-color: var(--recent-border); }
    .article-card.recent:hover { border-color: #3fb950; box-shadow: 0 4px 20px rgba(35, 134, 54, 0.2); }
    .article-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .source-tag { background: var(--tag-bg); color: var(--tag-text); padding: 2px 10px; border-radius: 20px; font-size: 0.78rem; font-weight: 500; }
    .date, .time { color: var(--text-secondary); font-size: 0.82rem; }
    .article-title { font-size: 1.05rem; font-weight: 600; line-height: 1.5; margin-bottom: 8px; }
    .article-title a { color: var(--text); text-decoration: none; transition: color 0.2s; }
    .article-title a:hover { color: var(--accent-hover); text-decoration: underline; }
    .article-desc { color: var(--text-secondary); font-size: 0.88rem; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .failure-note { background: #3d1f1f; border: 1px solid #d29922; color: #e3b341; padding: 12px 20px; border-radius: 8px; margin-bottom: 24px; font-size: 0.88rem; }
    .footer { text-align: center; padding: 24px; color: var(--text-secondary); font-size: 0.82rem; border-top: 1px solid var(--border); }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    @media (max-width: 600px) { .header h1 { font-size: 1.6rem; } .stats { gap: 20px; } .article-card { padding: 16px; } }
  </style>
</head>
<body>
  <header class="header">
    <h1>🤖 AI Daily Digest</h1>
    <p class="subtitle">每日 AI / LLM 领域资讯速递</p>
    <div class="stats">
      <div class="stat"><div class="stat-num">${data.count}</div><div class="stat-label">篇精选内容</div></div>
      <div class="stat"><div class="stat-num">${Object.keys(groups).length}</div><div class="stat-label">个来源</div></div>
      <div class="stat"><div class="stat-num">${data.recentCount || 0}</div><div class="stat-label">今日新文</div></div>
    </div>
  </header>
  <main class="container">
    ${failureNote}
    ${recentHTML}
    ${articlesHTML}
  </main>
  <footer class="footer">
    <p>最后更新: ${genTime}</p>
    <p style="margin-top: 6px;">由 AI Digest Bot 自动生成 · <a href="#" onclick="location.reload(); return false;">🔄 刷新</a></p>
  </footer>
</body>
</html>`;
}

main().catch(console.error);
