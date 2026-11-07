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
 * 结构化渠道：--input 支持 JSON，同时传 --source 与 --source-url。
 * 文件字段为 date、currency ("CNY")、condition ("new")、offers。
 * offers 中每项含 model（price-map.json 中的完整型号）与 price（人民币数值）。
 * 每次导入一份当日完整快照，至少五个不同型号。可先加 --dry 验证。
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
const date = arg('--date', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()));
const inputRel = arg('--input', `data/raw/${date}.txt`);
const sourceUrl = arg('--source-url', '');
const sourceName = arg('--source', '显卡日报（图文转载版）');
const doPush = argv.includes('--push');
const dry = argv.includes('--dry');
const backfill = argv.includes('--backfill');
const priceRuleOverride = arg('--price-rule', '');

if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date) fail('日期格式应为有效的 YYYY-MM-DD');
if (sourceUrl && (!URL.canParse(sourceUrl) || !['http:', 'https:'].includes(new URL(sourceUrl).protocol))) {
  fail('原文链接需要使用有效的 HTTP 或 HTTPS 地址');
}

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
const prices = {};
const quotes = {};
const rules = map.rules.map(rule => ({ ...rule, pattern: new RegExp(rule.match, 'i') }));

function parsePrice(line) {
  // 只接受行首报价；型号、容量、日期或下一行的商品名不能充当价格。
  const hit = line.match(/^(?:约\s*)?[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\s*[–—~至～-]\s*(\d{1,3}(?:,\d{3})+|\d+))?(?=$|[元（(+＋/\s])/);
  if (!hit || /%|同比|环比/.test(line)) return null;
  const low = Number(hit[1].replaceAll(',', ''));
  const high = hit[2] ? Number(hit[2].replaceAll(',', '')) : low;
  if (low < 200 || high > 200000 || high < low) return null;
  return Math.round((low + high) / 2);
}

const structured = path.extname(inputPath).toLowerCase() === '.json';
if (structured) {
  const feed = JSON.parse(text);
  if (!sourceUrl || !arg('--source') || feed.date !== date || feed.currency !== 'CNY' ||
      feed.condition !== 'new' || !Array.isArray(feed.offers)) {
    fail('结构化报价需要来源名、原文链接、同日报价、CNY 币种和 new 成色');
  }
  for (const {model, price} of feed.offers) {
    const rule = rules.find(r => r.model === model);
    if (!rule || Object.hasOwn(prices, model) || !Number.isFinite(price) || price <= 0) {
      fail('无效型号、重复型号或无效价格：' + model);
    }
    prices[model] = price;
    quotes[model] = { label: rule.label, raw: sourceName + ' · ¥' + price };
  }
} else {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const start = lines.findIndex(line => line.includes(map.scope.start));
  if (start < 0) fail('日报文本里找不到价格速查表区块');
  let section = 'other';
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(map.scope.end) || /^(?:[♻️\s]*)(?:二手|闲鱼)/u.test(line)) break;
    const header = map.sections.find(s => line === s.header);
    if (header) { section = header.id; continue; }
    const rule = rules.find(r => r.pattern.test(line));
    if (!rule || Object.hasOwn(prices, rule.model)) continue;
    for (const raw of lines.slice(i + 1, i + 3)) {
      if (map.sections.some(s => raw.includes(s.header)) || rules.some(r => r.pattern.test(raw)) ||
          /二手|闲鱼/.test(raw)) break;
      const price = parsePrice(raw);
      if (price === null) {
        if (!/^(?:价格|报价|到手价|零售价)[：:]?$/.test(raw)) break;
        continue;
      }
      prices[rule.model] = price;
      quotes[rule.model] = { raw, section, label: rule.label, line: line.slice(0, 80) };
      break;
    }
  }
}

const unmatched = map.rules.filter(r => !Object.hasOwn(prices, r.model)).map(r => r.label);
const count = Object.keys(prices).length;
if (count < 5) fail(`只解析到 ${count} 个价格，低于安全阈值 5，已保留上一版数据不覆盖`);

const snapshot = {
  schema: 1,
  date,
  generatedAt: new Date().toISOString(),
  source: sourceName,
  sourceUrl,
  upstream: structured ? sourceName : 'B 站 UP 主「芝士华莱士」(mid 22697887) 每日显卡日报',
  upstreamNote: structured ? '按完整型号导入全新件人民币报价' : '日报价格表仅存在于视频画面，无结构化接口；此处采用每日图文转载版的价格速查表',
  priceRule: priceRuleOverride || (structured ? '采用来源当日的单项报价' : '取日报价格区间的中值；单值直接取用；跳过二手 / 闲鱼口径；未匹配的型号沿用页面内置基线价'),
  caveat: structured ? '具体库存与成交条件请核对来源原文。' : '转载版混有电商采集价、零售到手价、官方到手价；全网最低价多来自第三方店铺，自营旗舰常缺货，实际下单价通常更高。原文亦提示不同渠道口径打架。',
  references: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/official-reference.json'), 'utf8')),
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
    note: '各日归档可能采用区间中值、渠道最低价或来源单项报价。跨口径涨跌仅供参考，缺少报价的日期留空。'
  };
}

const json = JSON.stringify(snapshot, null, 2) + '\n';
if (!dry) {
  if (!backfill && fs.existsSync(outPath) && JSON.parse(fs.readFileSync(outPath, 'utf8')).date > date) {
    fail('已有更新日期的行情，补录旧日期请使用 --backfill');
  }
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
