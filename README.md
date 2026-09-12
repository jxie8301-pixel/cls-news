# 财联社 沪深A股 · 栏目新闻实时盯盘

> ### 📱 手机随时看：<https://yunqingzou-bit.github.io/cls-news-dashboard/>
>
 > 云端每 30 分钟自动抓取并发布的快照表格，带搜索框和栏目筛选，**不需要电脑开机**。
>
> ⚠️ 别和代码仓库搞混：`github.com/yunqingzou-bit/cls-news-dashboard` 是**源码**，
> `yunqingzou-bit.github.io/cls-news-dashboard` 才是**网站**。

把**在上海证券交易所与深圳证券交易所上市的全部股票**（约 5200 只）里，命中《盘中宝》《风口研报》《电报解读》《财联社早知道》《数据研选》《九点特供》《公告全知道》《解读龙虎榜》等栏目前缀的个股新闻（默认回溯 7 天）抓下来，输出成**一张合并表格**，并提供一个打开就能实时看的本地面板。

零依赖：只要有 Node.js 18+，不用 `npm install`。

## 快速开始

```bash
node src/server.js
```

然后在浏览器打开 <http://127.0.0.1:8848>。

程序启动后会先同步股票池、再抓一次，之后每 10 分钟自动刷新（可在 `config.json` 里改）。页面自己每 30 秒拉一次数据，新出现的新闻会高亮。

## 一次性抓取并导出表格
## 手机 / 外网访问（Tailscale）

面板默认只监听回环地址，外部访问不到。程序支持自动绑定 Tailscale 私有网卡（config.json 里 tailscale 设 false 可关闭）：

- 启动时绑定 127.0.0.1 和 Tailscale 网卡上的 100.x 地址；运行中每 30 秒复查一次，Tailscale 上线或换 IP 都会自动补绑，不用重启。
- 结果：本机用 127.0.0.1:8848，手机用「本机 Tailscale IP:8848」。
- 家里局域网（192.168.x.x）和公网都不监听，扫不到也连不上 —— 这是选 Tailscale 而不是端口转发的核心原因。
- 手机装 Tailscale App 并用同一账号登录一次即可，之后 Wi-Fi / 5G 都能访问。
- 查本机 Tailscale IP：控制台 Machines 页，或管理员 PowerShell 执行 tailscale ip -4。

两个注意事项：

- 电脑休眠或关机时手机自然连不上，建议把电源计划设为不休眠。
- Tailscale 在 Windows 默认跟随登录会话；希望注销后仍在线，可在托盘设置里打开 Run unattended。

```bash
node src/cli.js                # 抓取 7 天 + 导出 CSV/HTML/JSON
node src/cli.js --days 3       # 只抓近 3 天
node src/cli.js --limit 20     # 只跑前 20 只股票（试跑用）
node src/cli.js --export       # 不抓取，只用本地缓存重新导出
node src/cli.js --no-text      # 跳过正文抓取，只收标题
node src/cli.js --no-sync      # 跳过股票池同步，直接用本地名单
```

**只生成一张合并表**——沪市、深市不分开，所有股票池的命中结果合并在一起。导出到 `out/`：

| 文件 | 说明 |
| --- | --- |
| `cls-news-latest.csv` | Excel 可直接打开的表格（UTF-8 BOM） |
| `cls-news-latest.html` | 带样式的网页表格，双击即看 |
| `cls-news-latest.json` | 结构化数据，便于二次处理 |
| `cls-news-<时间>.csv/.html/.json` | 带时间戳的快照，只保留最近 5 组 |

表格列顺序：**新闻发布时间 / 涉及股票 / 前缀类型 / 新闻标题 / 新闻正文**（后接 正文来源 / 所属股票池 / 股票代码 / 文章链接）。

## 实时面板能做什么

- 「股票池」下拉：在全部 / 沪深A股 / 自选股 之间切换（默认看全部）。
- 按栏目、股票名或标题关键词过滤；点栏目标签快速筛选。
- 「全部栏目」开关：默认只看配置里列的栏目，打开后显示所有带 `【…】` 栏目前缀的新闻。
- 「立即刷新」手动触发一次抓取；「导出表格」下载最新导出的 CSV。
- 每只涉及股票自动生成简洁调研结论：题材、最新 PE/PB、市值、未来三个月潜力、当前及未来事件、近半年增减持公告。
- 「启用全文」录入财联社登录态，回填订阅栏目正文（见下）。
- 「同步成分股」重新拉取股票池名单并重跑；「同步自选股」从线上自选股页面导入。

## 配置（`config.json`）

```jsonc
{
  "port": 8848,             // 本地端口
  "refreshMinutes": 10,     // 自动刷新间隔（分钟）
  "days": 7,                // 回溯天数
  "concurrency": 8,         // 并发抓多少只股票
  "requestDelayMs": 120,    // 每只股票之间的间隔，调大可降低被限流的概率
  "syncPoolsOnStart": true, // 启动时自动同步股票池
  "marketPool": { "enabled": true, "key": "all-a", "name": "沪深A股", "market": "all" },
  "marketPageSize": 200,    // 股票列表分页倍数（200 → 一次可拿 6000 只）
  "research": { "enabled": true, "refreshHours": 24, "concurrency": 5 }, // 调研按日缓存
  "indexPools": [],         // 可选：额外盯的指数成分股池
  "prefixes": [ ... ]       // 目标栏目前缀，命中即入库
}
```

`prefixes` 的匹配规则：栏目名完全相等，或栏目名后带副标题（例如配置 `风口研报` 会匹配 `风口研报·行业`、`风口研报·公司`）。不做互相包含匹配，所以 `龙虎榜` 不会被 `解读龙虎榜` 误收。

## 股票池

### 沪深A股全量（默认，自动）

默认池就是**沪深两市全部上市公司**，启动时自动拉取并写入 `data/pools/all-a.json`：

    "marketPool": { "enabled": true, "key": "all-a", "name": "沪深A股", "market": "all" }

对应接口 `https://x-quote.cls.cn/web_quote/web_stock/stock_list?market=all`（签名规则同网页 API）。实测返回 5207 只：沪市 2311 + 深市 2896，不含北交所。面板上点「同步成分股」可手动刷新。

### 指数成分股（可选）

还想同时盯某几个指数的成分股，在 `indexPools` 里声明即可：

    "indexPools": [
      { "code": "sz399006", "name": "创业板指" }
    ]

对应接口 `https://x-quote.cls.cn/web_quote/web_stock/indCompoment`。

### 自选股（手动 / 半自动）

`data/watchlist.json` 是自选股名单（沪深A股的子集，主要作为面板上的一个筛选维度）。两种更新方式：

1. **一键同步**：打开面板点「同步自选股」，把面板给出的代码粘贴到已登录的 `https://www.cls.cn/optional` 页面控制台里回车。它会自动点开「加载更多」、解析全部股票，回传给本程序并立即重新抓取。
2. **手动编辑**：直接改 `data/watchlist.json` 里的 `stocks` 数组，形如 `{"code":"sh600967","name":"内蒙一机"}`。

同一只股票若同时属于多个池，只抓一次，命中的新闻会出现在合并表里，并在「所属股票池」列标注。

## 关于「新闻正文」——为什么很多是空的

这点必须说清楚：**上面这些栏目全部是财联社的付费 VIP 栏目，正文需要订阅登录态。**

匿名访问时只能拿到：发布时间、栏目名、标题、关联股票、以及一句话摘要；正文接口会返回空壳。实测（2026-09-12）：

- `https://api3.cls.cn/share/article/<id>` 这类公开分享页，对付费稿返回的是空的内容容器。
- `https://i.cls.cn/articles/v1/detail`（页面详情接口）对这类稿只返回 `column` / `articlePrice` / `brief` 等元信息，没有 `content`。
- 只有《电报》《文章》这类公开稿能拿到正文。

所以程序默认把能拿到的摘要填进「正文」列，并在「正文来源」里标注 `需订阅登录（点标题查看全文）`。

### 想拿到全文：启用登录态

**方式一（页面内一键）**：打开面板点「启用全文」，把给出的代码粘到 `https://www.cls.cn` 任意页面的控制台里回车。它会把 `localStorage.userInfo` 里的 `oauth_info.token` 和 `uid` POST 给本程序。

**方式二（手动）**：DevTools → Application → Local Storage → `https://www.cls.cn` → `userInfo`，把 `oauth_info.token` 和 `uid` 填进面板输入框；也可以直接粘 `Cookie` 字符串。

凭据只写进本机的 `config.local.json`（不参与分发，请勿外传）。保存后程序会自动重新抓取并回填正文；已有记录只要还没拿到正文，下一轮会自动重试。

## 数据来源与实现说明

- 新闻列表：`GET https://www.cls.cn/es/quotes/articles?keyword=<股票代码>&lastTime=<秒级时间戳>&rn=10`，用 `lastTime` 往前翻页，翻到窗口边界为止。
- 沪深A股全量：`GET https://x-quote.cls.cn/web_quote/web_stock/stock_list?market=all&way=change&page=<N>&rever=1`，返回 `secu_code` / `secu_name`。
- 指数成分股（可选）：`GET https://x-quote.cls.cn/web_quote/web_stock/indCompoment?secu_code=<指数代码>& way=change&page=<N>&rever=1`。
- 正文：优先 `https://api3.cls.cn/share/article/<id>`（服务端直出，能拿到就是全文），失败再回退 `/articles/v1/detail`。
- 接口签名：站点前端对参数按 key 排序拼成 query string 后 `sign = md5(sha1(qs))`，本程序照此复现（见 `src/cls.js`）。
- `page` 在行情接口里相当于「取前 page×30 条」，所以传大值可一次拿全，不需要翻页。

## 目录结构

```
src/cls.js        财联社接口客户端（签名 / 新闻列表 / 正文 / 股票池）
src/collect.js    抓取编排、并发、缓存（data/news.json）
src/report.js     CSV / HTML / JSON 导出
src/cli.js        命令行一次性抓取与导出
src/server.js     本地服务 + 自动刷新调度
public/index.html 实时面板（原生 JS，无构建）
data/watchlist.json  自选股名单
data/pools/*.json    股票池名单（all-a.json = 沪深A股全量）
data/news.json       抓取缓存
out/                 导出结果
```

## 已知限制

- 付费栏目正文依赖你的登录态；凭据过期后正文会重新变回「需订阅登录」，重新启用一次即可。
- 频率过高可能被站点限流；`concurrency` / `requestDelayMs` 可调。默认值实测：沪深A股 5207 只一轮约 88 秒（读回 3.4 万条新闻）。
- 栏目名会随财联社改版变化（例如你列表里的《数据研选》《解读龙虎榜》，线上实际是《研选·行业数据》《研选·研报数据》和《龙虎榜》），可直接在 `config.json` 里增删。
- 【龙虎榜】是每只上榜股票的成交明细（数据类），量很大——本周占全表约 7 成。不想收就在 `prefixes` 里删掉 `"龙虎榜"`。
- 数据仅用于个人研究，不构成任何投资建议。

## 调研结论列

表格末列会按“每只股票”生成一段简洁结论，同一篇新闻涉及多只股票时仍逐股展示。数据来自财联社个股资料、最新行情和公司公告：

- 板块题材：公司所属行业与主要概念；
- 当前估值：最近收盘对应的 PE(TTM)、PB 和总市值；
- 三个月潜力：基于盈利增速、ROE、估值、近三个月走势、重大公告与股东动向形成的 15–85 分规则模型，只用于横向筛查，不是买卖评级；
- 大事件：近半年的重大合同、业绩、回购、重组、监管等公告，以及未来三个月的法定财报节点和事项跟踪点；
- 增减持：近半年公告标题中可核验的增持、减持或不减持承诺，未检索到会明确写出。

研究缓存位于 `data/research.json`，默认 24 小时刷新一次。GitHub Pages 会继承上一轮公开缓存，避免每 30 分钟对数百只股票重复请求。
## 装成手机 App（PWA）

面板本身就是个 PWA，不需要上架、不需要签名、不需要账号：

- 安卓 Chrome：打开面板 → 右上角菜单 → 「添加到主屏幕」/「安装应用」。
- iPhone Safari：打开面板 → 分享 → 「添加到主屏幕」。
- 装好后是一个独立图标，全屏打开，没有浏览器地址栏，和原生 app 体验基本一致。

离线行为：Service Worker 会缓存页面外壳和最近一次数据。电脑休眠或断网时，App 仍然能打开，显示最近一次抓到的内容，并在顶部标出「可能已离线（显示最近一次缓存）」。**但它不会带来新数据**——想要新鲜数据，抓取必须跑在一个不关机的地方。

图标由 tools/make-icons.js 生成（零依赖手写 PNG）：node tools/make-icons.js
