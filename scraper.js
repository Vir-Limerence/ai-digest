#!/usr/bin/env node
/**
 * AI Daily Digest Scraper v3
 * RSS (fast) + Jina Reader (reliable)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_HTML = join(__dirname, 'digest.html');
const OUTPUT_JSON = join(__dirname, 'digest.json');
const JINA_BASE = 'https://r.jina.ai';

// Use built-in fetch for reliability
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

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '') // strip CDATA
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRSS(xml, source) {
  const items = [];
  const isAtom = xml.includes('<feed');
  const entryRegex = isAtom ? /<entry>([\s\S]*?)<\/entry>/gi : /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const e = match[1];
    const get = t => {
      const m = e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get(isAtom ? 'title' : 'title');
    const linkMatch = isAtom
      ? e.match(/<link[^>]+href="([^"]+)"/) || [null, get('link')]
      : [null, (e.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] || '').trim()];
    const link = linkMatch[1] || get('guid');
    const rawDate = get(isAtom ? 'published' : 'pubDate') || get('updated') || get('dc:date');
    const desc = get(isAtom ? 'summary' : 'description') || get('content');
    if (title && (link.startsWith('http') || !link)) {
      items.push({
        title: title.slice(0, 200),
        url: link.startsWith('http') ? link : (source.url + link),
        date: parseDate(rawDate),
        source: source.name,
        sourceId: source.id,
        description: stripHtml(desc).slice(0, 300),
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
  
  // Split markdown into sections by article links (both patterns)
  // Pattern 1: [Title](url)
  const re1 = /\[([^\]]{5,300})\]\((https?:\/\/[^\)]+)\)/g;
  // Pattern 2: [](url) - empty link (lilianweng style)
  const re2 = /\[\]\((https?:\/\/[^)]+)\)/g;
  
  // For each link, find the section it belongs to
  // Strategy: split markdown by link occurrences and use context
  const allLinks = [];
  let m;
  
  // Collect all link positions with type
  while ((m = re1.exec(markdown)) !== null) {
    allLinks.push({ index: m.index, type: 1, match: m });
  }
  re1.lastIndex = 0;
  while ((m = re2.exec(markdown)) !== null) {
    allLinks.push({ index: m.index, type: 2, match: m });
  }
  re2.lastIndex = 0;
  
  // Sort by position
  allLinks.sort((a, b) => a.index - b.index);
  
  for (const link of allLinks) {
    const url = link.match[2] || link.match[1];
    if (seen.has(url)) continue;
    if (/tag[s]?|\/tags?\/|subscribe|about|search|contact|privacy|terms|rss|feed/i.test(url)) continue;
    seen.add(url);
    
    // Get surrounding context
    const start = Math.max(0, link.index - 1500);
    const end = Math.min(markdown.length, link.index + link.match[0].length + 500);
    const context = markdown.slice(start, end);
    
    // Extract title
    let title = '';
    if (link.type === 1) {
      title = link.match[1].trim();
    } else {
      // For empty links: get the last sentence/paragraph before the link
      const before = markdown.slice(Math.max(0, link.index - 800), link.index);
      // Find the last sentence-ending character before the link
      const lastPunc = Math.max(
        before.lastIndexOf('\n\n'),
        before.lastIndexOf('.\n'),
        before.lastIndexOf('?\n'),
        before.lastIndexOf('!\n'),
        before.lastIndexOf('\n')
      );
      const lastSentence = before.slice(lastPunc + 1).replace(/[*_`#]/g, '').trim();
      title = lastSentence.slice(0, 200) || url.split('/').pop().replace(/-/g, ' ');
    }
    
    if (title.length < 3) title = url.split('/').pop().replace(/-/g, ' ');
    
    // Extract date
    const dm = context.match(/\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{1,2}\s+\w+\s+20\d{2})\b/i);
    
    // Extract excerpt
    const after = markdown.slice(link.index + link.match[0].length, link.index + link.match[0].length + 400);
    const em = after.match(/^[:\s\n]*([^.!?]{30,200}?)(?:[.!?\n]|$)/);
    const excerpt = em ? em[1].replace(/[*_`#\n]/g, ' ').trim() : '';
    
    items.push({ title, url, date: dm ? parseDate(dm[1]) : null, source: source.name, sourceId: source.id, description: excerpt, category: source.category });
  }
  
  return items;
}

async function fetchJina(url, retries = 2) {
  const jinaUrl = `${JINA_BASE}/${encodeURIComponent(url)}`;
  for (let i = 0; i <= retries; i++) {
    try {
      const content = await fetch(jinaUrl, {
        headers: { 'Accept': 'text/plain', 'User-Agent': 'Mozilla/5.0' }
      }).then(r => r.text());
      if (content && content.includes('Markdown Content:')) return content;
      if (i < retries) await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      if (i < retries) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return '';
}

async function main() {
  const sources = JSON.parse(readFileSync(join(__dirname, 'sources.json'), 'utf8')).sources;
  const allItems = [];
  const errors = [];
  const now = new Date();
  
  console.log(`\n🤖 AI Daily Digest — ${now.toLocaleString('zh-CN')}`);
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
  
  const data = { generated: now.toISOString(), count: unique.length, failed: errors, items: unique };
  writeFileSync(OUTPUT_JSON, JSON.stringify(data, null, 2));
  
  const html = generateHTML(data);
  writeFileSync(OUTPUT_HTML, html);
  
  console.log(`✅ 已生成: ${OUTPUT_HTML}`);
}

function generateHTML(data) {
  const groups = {};
  data.items.forEach(i => { (groups[i.category] = groups[i.category] || []).push(i); });
  const catNames = { '大牛': '🧠 大牛博客', '机构': '🏢 机构博客', '中文媒体': '📰 中文媒体' };
  
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
  <title>AI Daily Digest — ${new Date().toLocaleDateString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --text-secondary: #8b949e; --accent: #58a6ff; --accent-hover: #79c0ff; --tag-bg: #1f6feb22; --tag-text: #58a6ff; --card-bg: #161b22; }
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
      <div class="stat"><div class="stat-num">${data.items.filter(i => i.date && new Date(i.date) >= new Date(Date.now() - 7 * 86400000)).length}</div><div class="stat-label">本周新文</div></div>
    </div>
  </header>
  <main class="container">
    ${failureNote}
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
