# 生产冻结说明

本目录对应的线上仓库 **`jxie8301-pixel/cls-news`（dashboard）已切流冻结**。

- **现网采集 / 企微 / Pages / 复盘**：改由 **`jxie8301-pixel/news-crawler`**
- **本仓 Actions**：`collect` / `push-perf` / `keepalive` 均已 `if: false`，且去掉定时；勿再手动跑
- **回滚**：恢复各 workflow 的 job 条件与 `push-perf`/`keepalive` 的 `schedule`，并把 `cls-trigger` 的 `GH_REPO` 改回本仓

详见 `news-crawler/README.md`。
