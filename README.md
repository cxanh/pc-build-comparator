# PC Build Comparator

[打开配置对比网页](https://cxanh.github.io/pc-build-comparator/)

## 安装 CLI

需要 Node.js 20.19 或更高版本。在任意目录运行：

```sh
npm install -g https://codeload.github.com/cxanh/pc-build-comparator/tar.gz/refs/heads/main
pc-build --help
```

## 查询价格

```sh
pc-build prices 5070
pc-build prices "RTX 5060 Ti 16GB" --date 2026-11-08 --json
pc-build history "Ryzen 7 9700X" --json
```

项目根目录下默认查询本地快照，其他目录读取 GitHub 主分支的最新快照。加上 `--remote` 可在项目中查询主分支。结果日期对应采价归档日。历史行情覆盖最近 14 份归档，按日期查询可读取更早的快照。

`prices --json` 返回数组，每条记录含日期、完整型号、人民币价格、来源、原文链接、优惠条件和取价规则。历史归档可能采用区间中值，可用 `prices --date` 查当天口径。退出码 0 表示成功，1 表示无匹配，2 表示参数或读取错误。诊断信息写入标准错误。

## 更新项目数据

在克隆的项目根目录执行。以下示例使用仓库已有的原始报价文件。

```sh
pc-build update --date 2026-11-08 --dry
pc-build update --date 2026-11-08
```

新一期的数据格式见 [11 月 8 日原始报价](data/low-reports/2026-11-08.json)。将核对后的记录放入 `data/low-reports/YYYY-MM-DD.json`，或用 `--input` 指定文件。正式更新会生成当日归档、最新行情和历史序列。补录旧日期使用 `--backfill`。更新仅写入本地项目，发布时将原始报价与生成文件一并提交。

在项目根目录也可以用 `node scripts/pc-build.mjs` 代替 `pc-build`。
