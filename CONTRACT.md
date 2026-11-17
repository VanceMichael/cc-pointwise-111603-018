# 来源与消费契约

## 来源

入口 `/events/E1/requests`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

requests 是居民申请，不是门户确认事实。门户 /portal 的剩余量只为当时页面观察，最终 /portal/confirm 的 201 receipt 才确认名额，409 代表提交时无余量。两会话可以同时填写草稿；取消 /portal/cancel 使 receipt 状态取消并增加 revision。bookings 查询同时返回已取消记录，旧 receipt 不能推翻更晚取消。source/portal.js 的 capacity 控制名额。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

## 报名语义

- 来源 `requests` 中的 `join`/`cancel` 是居民意向观察，不是门户事实。每次观察按 observedAt 前进；较旧或重放的观察不能覆盖较新的意向。
- 采集层把每份申请写成候选，候选与门户回执分开持久化（`candidates.json` / `receipts.json`）。表单已提交、候选已创建、确认响应丢失都不构成成功。
- 成功名单由“候选 + 当前 confirmed 回执”推导；回执按门户 revision 合并，较旧的 201 成功响应不能覆盖更晚的取消，取消或失效回执立即把申请移出成功名单。
- 门户 409（capacity）使候选进入候补；候补顺序按候补登记时间、申请时间、申请编号升序，读取结果给出位置与前方人数。取消释放名额后按该顺序尝试递补。
- 同一参考号只允许一个有效回执：换场次先释放旧回执，重试或确认响应不确定时先查询 `/portal/bookings` 再决定是否再次提交。
- 同一状态目录的读改写按进程内队列和文件锁串行，跨进程的多个待办不会对同一场次超额确认。

`readOperations` 在报名状态存在时于同一返回对象中追加 `candidates`、`successes`（别名 `success`）、`waitlist`、`receipts`，`rows` 仍保持来源观察的原有形状。

