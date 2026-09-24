# news-crawler-gha（推送到 jxie8301-pixel/cls-news）

**CNB collect 硬失败时的 GitHub Actions 备用抓取** → Cloudflare D1。

```
主：cls-trigger → CNB collect → D1 → ingest-done → 企微
备：CNB 失败 → workflow_dispatch cls-news/collect.yml → D1
```

GitHub 仓：https://github.com/jxie8301-pixel/cls-news  

只做采集入库；不做 perf / 企微 / MiniMax / Pages（perf 只在 CNB）。

## Secrets

| Secret | 说明 |
|--------|------|
| `D1_WRITE_TOKEN` | 与 Worker `WRITE_TOKEN` 相同 |
| `D1_API_BASE` | 可选，默认 `https://cls-news.jxie.ccwu.cc` |

## 手动

Actions → `collect` → Run workflow
