# 生产冻结说明

本目录对应的线上仓库 **`jxie8301-pixel/cls-news`（dashboard）当前为生产冻结态**。

- **继续**：VIP 触发的现网 `collect.yml`、企微推送、Pages、`push-perf`（不要停，直到 v2 切流完成）
- **不要**：往现网 `collect.yml` 加 Matrix / 大改扫描链路
- **并行开发**：在 `news-crawler`（cls-news v2）进行；影子期默认不推企微、不发本仓 Pages
- **切流后**：将 `cls-trigger` 指向 v2，再停旧仓定时与触发

详见 `news-crawler/README.md`。
