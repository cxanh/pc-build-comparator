#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const help = `pc-build prices [型号关键词] [--date YYYY-MM-DD] [--json] [--remote]
pc-build history <型号关键词> [--json] [--remote]
pc-build update --date YYYY-MM-DD [--input 文件] [--dry] [--backfill]

在项目根目录读取本地数据，其他目录从 GitHub main 读取。--remote 强制读取远程。
update 在项目根目录执行。默认输入为 data/low-reports/日期.json。`;
const remote = 'https://raw.githubusercontent.com/cxanh/pc-build-comparator/main/';
const repo = existsSync('scripts/update-daily.mjs') && existsSync('data/price-map.json');
const boolean = { type: 'boolean' };
const string = { type: 'string' };

async function data(file, online) {
  if (repo && !online) return JSON.parse(await readFile(file, 'utf8'));
  const response = await fetch(remote + file, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`读取 ${file} 失败（HTTP ${response.status}）`);
  return response.json();
}

async function main([command, ...args]) {
  if (!command || command === '--help' || command === 'help' || command === '-h') {
    console.log(help);
    return;
  }
  if (!['prices','history','update'].includes(command)) throw new Error('未知命令，请运行 pc-build --help');
  const options = command === 'update'
    ? { date:string, input:string, dry:boolean, backfill:boolean }
    : { json:boolean, remote:boolean, ...(command === 'prices' ? { date:string } : {}) };
  const { values, positionals } = parseArgs({ args, options, allowPositionals:true });
  if (values.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) ||
      !Number.isFinite(Date.parse(values.date)) || new Date(values.date).toISOString().slice(0,10) !== values.date)) {
    throw new Error('请输入有效日期 YYYY-MM-DD');
  }
  if (command === 'update') {
    if (!repo) throw new Error('请先进入 pc-build-comparator 项目根目录');
    if (!values.date || positionals.length) throw new Error('用法：pc-build update --date YYYY-MM-DD [--input 文件] [--dry] [--backfill]');
    const params = ['--date', values.date];
    if (values.input) params.push('--input', resolve(values.input));
    if (values.dry) params.push('--dry');
    if (values.backfill) params.push('--backfill');
    const child = spawnSync(process.execPath, ['scripts/update-daily.mjs', ...params], {stdio:'inherit'});
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const query = positionals.join(' ').trim().toLowerCase();
  if (command === 'history' && !query) throw new Error('请输入要查询历史行情的型号关键词');
  const result = [];
  if (command === 'prices') {
    const file = values.date ? `data/daily-${values.date}.json` : 'daily-data.json';
    const d = await data(file, values.remote);
    for (const [model, price] of Object.entries(d.prices)) {
      if (!model.toLowerCase().includes(query)) continue;
      const q = d.quotes?.[model];
      result.push({date:d.date, model, price, currency:'CNY', source:q?.source || d.source,
        url:q?.url || d.sourceUrl, detail:q?.raw || '', priceRule:d.priceRule});
    }
  } else {
    const h = await data('history.json', values.remote);
    for (const [model, series] of Object.entries(h.prices)) {
      if (!model.toLowerCase().includes(query)) continue;
      for (const date of h.dates) {
        if (series[date] != null) result.push({date, model, price:series[date], currency:'CNY'});
      }
    }
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else for (const row of result) {
    console.log(`${row.date}  ${row.model}  ¥${row.price}`);
    if (row.source) console.log(`  ${row.source} · ${row.detail}\n  ${row.url}\n  ${row.priceRule}`);
  }
  if (!result.length) {
    console.error('没有匹配的报价');
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 2;
});
