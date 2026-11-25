---
name: blocked-page-recovery
description: 抓取被 403/429/付费墙拦住时的降级链
category: research
---
# 抓取失败恢复

## 触发
web_fetch 返回 403 / 429 / 空正文 / 「Just a moment…」/ 付费墙 / 机器人校验页。

## 阶梯（由便宜到贵，逐级尝试，不重复打同一 URL）
1. **换入口**：同一内容常见于 `/amp`、`?output=1`、打印版、RSS、站内 API（`.json`、`/api/`、`/graphql`）。
2. **Wayback**：web_fetch `https://archive.org/wayback/available?url=<原文URL>`，再抓返回的 `snapshot_url`；引用时注明快照时间。
3. **archive.today**：`https://archive.ph/newest/<原文URL>`（域名轮换 .ph/.md/.li/.is 均可试）。
4. **搜索引擎缓存/摘要**：只把摘要当线索，不当全文引用。
5. 仍失败就如实告诉用户「该页面拒绝访问」，并给出可自行打开的链接与已确认的事实（来自其他来源）。

## 出处纪律
- 用快照时必须写明「经 Wayback 快照，YYYY-MM-DD」，不能伪装成原文实时抓取。
- 快照可能缺图表/更新段落；据此下的结论要降级措辞。
- 不绕过付费墙、不伪造 UA/登录态；拿不到就承认拿不到。
