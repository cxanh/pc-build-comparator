#!/usr/bin/env node
/**
 * 每日行情更新：把「显卡日报」图文转载版的价格速查表解析成结构化数据。
 *
 * 用法：
 *   node scripts/update-daily.mjs --date 2026-11-06 \
 *        --input data/raw/2026-11-06.txt \
 *        --source-url https://www.toutiao.com/xxxxx \
 *        [--source "显卡日报（图文转载版）"] [--push] [--dry]
 *
 * 输出：
 *   data/daily-<date>.json   当日归档快照
 *   daily-data.json          页面实际加载的数据（原子覆盖）
 *
 * 说明：B 站 UP 主「芝士华莱士」的日报价格表只存在于视频画面中，
 * 没有结构化接口。本脚本解析的是每日图文转载版的价格速查表，
 * 并在 product 里保留来源、口径与原文摘录，不做真实性背书。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const date = arg('--date', new Date().toISOString().slice(0, 10));
const inputRel = arg('--input', `data/raw/${date}.txt`);
const sourceUrl = arg('--source-url', '');
const sourceName = arg('--source', '显卡日报（图文转载版）');
const doPush = argv.includes('--push');
const dry = argv.includes('--dry');
const backfill = argv.includes('--backfill');
const priceRuleOverride = arg('--price-rule', '');

const inputPath = path.resolve(ROOT, inputRel);
const mapPath = path.resolve(ROOT, 'data/price-map.json');
const outPath = path.resolve(ROOT, 'daily-data.json');
const archivePath = path.resolve(ROOT, `data/daily-${date}.json`);

function fail(msg) {
  console.error(`[daily] 失败：${msg}`);
  process.exit(1);
}

if (!fs.existsSync(inputPath)) fail(`找不到日报文本 ${inputPath}`);
if (!fs.existsSync(mapPath)) fail(`找不到型号映射 ${mapPath}`);

const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const text = fs.readFileSync(inputPath, 'utf8');
const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

// 只取「价格速查表」到「二手」之间的全新件表格
const startIdx = lines.findIndex(l => l.includes(map.scope.start));
let endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(map.scope.end));
if (startIdx < 0) fail('日报文本里找不到价格速查表区块');
if (endIdx < 0) endIdx = lines.length;
const scoped = lines.slice(startIdx, endIdx);

// 给每一行打上所属分区
let section = 'other';
const headerHits = map.sections.map(s => ({ id: s.id, header: s.header, hit: false }));

function parsePrice(line) {
  if (!line || /%|同比|环比|30天|\+14%/.test(line)) return null;
  const range = line.match(/(\d[\d,]*)\s*[–—\-~至]\s*(\d[\d,]*)/);
  if (range) {
    const a = Number(range[1].replace(/,/g, ''));
    const b = Number(range[2].replace(/,/g, ''));
    if (a >= 200 && a <= 200000 && b >= 200 && b <= 200000 && b >= a) {
      return Math.round((a + b) / 2);
    }
  }
  const nums = [...line.matchAll(/\d[\d,]*/g)]
    .map(m => Number(m[0].replace(/,/g, '')))
    .filter(n => n >= 200 && n <= 200000);
  return nums.length ? nums[0] : null;
}

const prices = {};
const quotes = {};
const usedRules = new Set();

for (let i = 0; i < scoped.length; i++) {
  const line = scoped[i];
  const hdr = headerHits.find(h => !h.hit && line.includes(h.header));
  if (hdr) { hdr.hit = true; section = hdr.id; continue; }
  const rule = map.rules.find(r => !usedRules.has(r.model) && new RegExp(r.match, 'i').test(line));
  if (!rule) continue;
  let price = null, raw = '';
  for (let j = i + 1; j < Math.min(i + 3, scoped.length); j++) {
    const p = parsePrice(scoped[j]);
    if (p !== null) { price = p; raw = scoped[j]; break; }
  }
  if (price === null) continue;
  prices[rule.model] = price;
  quotes[rule.model] = { raw, section, label: rule.label, line: line.slice(0, 80) };
  usedRules.add(rule.model);
}

const unmatched = map.rules.filter(r => !usedRules.has(r.model)).map(r => r.label);
const count = Object.keys(prices).length;
if (count < 5) fail(`只解析到 ${count} 个价格，低于安全阈值 5，已保留上一版数据不覆盖`);

const snapshot = {
  schema: 1,
  date,
  generatedAt: new Date().toISOString(),
  source: sourceName,
  sourceUrl,
  upstream: 'B 站 UP 主「芝士华莱士」(mid 22697887) 每日显卡日报',
  upstreamNote: '日报价格表仅存在于视频画面，无结构化接口；此处采用每日图文转载版的价格速查表',
  priceRule: priceRuleOverride || '取日报价格区间的中值；单值直接取用；跳过二手 / 闲鱼口径；未匹配的型号沿用页面内置基线价',
  caveat: '转载版混有电商采集价、零售到手价、官方到手价；全网最低价多来自第三方店铺，自营旗舰常缺货，实际下单价通常更高。原文亦提示不同渠道口径打架。',
  coverage: { matched: count, rules: map.rules.length, unmatched },
  prices,
  quotes
};

// 汇总最近 14 天归档，页面用它画涨跌 / 迷你走势 / 数据新鲜度
function buildHistory() {
  const dir = path.resolve(ROOT, 'data');
  const files = fs.readdirSync(dir).filter(f => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const dates = [], prices = {};
  files.slice(-14).forEach(f => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!j.date) return;
      dates.push(j.date);
      Object.keys(j.prices || {}).forEach(m => {
        if (!prices[m]) prices[m] = {};
        prices[m][j.date] = j.prices[m];
      });
    } catch (e) { /* 跳过损坏的归档 */ }
  });
  return {
    schema: 1, generatedAt: new Date().toISOString(), dates, prices,
    note: '价格来自 B 站 UP 主「芝士华莱士」每日显卡日报的图文转载版。10-31/11-01/11-03/11-04 取各平台最低（日低价/全网最低），11-06 取区间中值，口径略有差异，日环比为参考信号而非实测。11-02、11-05 无可用日报表，相应日期显示为缺口；未匹配型号当日沿用页面内置基线价。'
  };
}

const json = JSON.stringify(snapshot, null, 2) + '\n';
if (!dry) {
  fs.writeFileSync(archivePath, json, 'utf8');
  if (!backfill) {
    const tmp = outPath + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, outPath);
  }
  fs.writeFileSync(path.resolve(ROOT, 'history.json'), JSON.stringify(buildHistory(), null, 2) + '\n', 'utf8');
}
console.log(`[daily] ${date} 解析完成：${count}/${map.rules.length} 个型号`);
if (unmatched.length) console.log(`[daily] 未匹配（沿用基线价）：${unmatched.join('、')}`);
if (dry) { console.log('[daily] --dry 模式，未写入文件'); process.exit(0); }
if (backfill) console.log(`[daily] --backfill 模式：已写归档 ${path.relative(ROOT, archivePath)}（未覆盖 daily-data.json）`);
else console.log(`[daily] 已写入 daily-data.json 与 ${path.relative(ROOT, archivePath)}`);

if (doPush) {
  const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();
  git('add', 'daily-data.json', 'history.json', `data/daily-${date}.json`, 'data/price-map.json', 'scripts/update-daily.mjs', 'index.html', '.gitignore');
  const status = git('status', '--porcelain');
  if (!status) { console.log('[daily] 没有变更，跳过提交'); process.exit(0); }
  git('commit', '-m', `data: 每日行情 ${date}（更新 ${count} 个型号）`);
  git('push', 'origin', 'main');
  console.log('[daily] 已推送到 GitHub，Pages 将在约 1–2 分钟后更新');
}
