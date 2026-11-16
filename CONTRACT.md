# 来源与消费契约

## 来源

入口 `/events/E1/requests`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

requests 是居民申请，不是门户确认事实。门户 /portal 的剩余量只为当时页面观察，最终 /portal/confirm 的 201 receipt 才确认名额，409 代表提交时无余量。两会话可以同时填写草稿；取消 /portal/cancel 使 receipt 状态取消并增加 revision。bookings 查询同时返回已取消记录，旧 receipt 不能推翻更晚取消。source/portal.js 的 capacity 控制名额。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
