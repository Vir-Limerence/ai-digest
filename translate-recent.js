#!/usr/bin/env node
/**
 * Re-translate recent articles only
 */
import { readFileSync, writeFileSync } from 'fs';

const hasChinese = t => /[\u4e00-\u9fff]/.test(t || '');
const cleanTranslation = t => {
  if (!t) return '';
  if (t.includes('MYMEMORY') || t.includes('translated.net')) return '';
  if (t.includes('error') && t.length < 100) return '';
  return t;
};

const translateToChinese = async (text) => {
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
};

const data = JSON.parse(readFileSync('digest.json'));
const recentCutoff = new Date(Date.now() - 48 * 3600 * 1000);
const recent = data.items.filter(i => i.date && new Date(i.date) >= recentCutoff && !hasChinese(i.title) && i.title);

console.log(`🌏 Re-translate ${recent.length} recent titles (Google Translate fallback)...`);
for (const item of recent) {
  const t = await translateToChinese(item.title);
  if (t && t !== item.title && !t.includes('MYMEMORY')) {
    console.log(`  ✅ ${item.title.slice(0, 35)} → ${t.slice(0, 35)}`);
    item.title = t;
  }
}

writeFileSync('digest.json', JSON.stringify(data, null, 2));
console.log('✅ Saved digest.json');
