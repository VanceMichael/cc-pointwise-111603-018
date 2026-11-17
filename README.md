# 社区活动报名台账

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。当前导入以 sourceId 保存最新观察；历史版本、完整批次、身份决策及恢复流程尚未纳入接入生命周期。

居民申请不再等于报名成功：来源页面的 `join` 只是候选，只有门户 `/portal/confirm` 返回 201 回执、且该回执当前仍是 `confirmed` 时，居民才进入成功名单。候选名额与门户回执分开保存，门户满额时进入可解释顺序的候补，取消会释放名额并递补。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源、读取首批并展示业务查询，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入来源观察，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放、业务查询，以及一条完整的候选→门户确认→候补→取消递补流程，完成后清理临时状态。

## 报名生命周期

1. **候选**：`apply` / `enroll` 把来源申请写成候选（`src/enrollment-repository.js` 的 `candidates.json`）。重复看到同一个 `join` 页面、重放旧观察或较旧的页面都不会重置候补位置，也不会覆盖更晚的取消。
2. **门户确认**：候选通过本地门户客户端填写草稿并提交确认。门户剩余量只是页面观察，201 receipt 才确认名额；409 表示提交时已满额。
3. **候补**：满额候选进入 `waitlisted`，`waitlist.position` 按候补登记时间升序，同时间按申请时间、再按申请编号排序；返回结果带有中文解释和前方人数（`ahead`）。
4. **成功名单**：只有“候选 + 当前仍为 confirmed 的回执”同时成立才出现在 `successes`。回执被取消、失效或修订号更旧时，成功立即消失。
5. **取消与递补**：取消使用门户已知的回执（不依赖本地成功标记），回执状态变为 `cancelled` 并增加 revision；释放名额后按候补顺序尝试递补，仍满额则停留在候补。
6. **重试与去重**：重试前先用 `/portal/bookings?reference=` 核对既有报名；确认响应丢失时不会重复占位。同一参考号同一时刻只保留一个有效回执，换场次会先释放旧回执。
7. **并发**：同一进程内的待办按仓库串行，跨进程通过状态目录文件锁串行，两个 CLI 同时抢同一场次也不会超额确认。

旧的成功响应不能推翻更晚的取消：回执按门户 revision 合并，revision 更低或同为取消状态的响应被忽略；没有 revision 时也会拒绝把已取消回执复活。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；目前 demo 只导入首批。

`src/service.js` 与 `src/repository.js` 维护持久观察集合；`src/operations.js` 是读取该集合的业务消费入口，同时把报名视图（`candidates`、`successes`、`waitlist`、`receipts`）合并在同一返回对象中，`rows` 保持原有形状。

报名状态由 `src/enrollment-repository.js`（候选与回执分开保存、文件锁）、`src/enrollment-service.js`（确认、候补、取消、递补、重试核对）和 `src/enrollment-state.js`（观察合并、回执 revision 规则、视图）组成，`src/portal-client.js` 提供只接受本地回环地址的门户客户端。状态目录属于运行产物（默认 `var/enrollment/`）；扩展导入时保留现有 CLI 和集合查询能力。

`npm start` 或 `npm start -- --help` 查看命令。原导入和查询使用显式的 ingest、query 动作；报名相关动作：

```sh
npm start -- apply [文件] [--no-process]        # 让来源申请进入确认流程
npm start -- status                             # 候选、成功名单、候补顺序、回执
npm start -- enroll <reference> --portal URL    # 单个居民申请
npm start -- process [--retry] --portal URL     # 处理待办（重试前先核对门户）
npm start -- lookup <reference> --portal URL    # 用门户报名记录核对本地状态
npm start -- cancel <reference> --portal URL    # 取消并递补
npm start -- operations                         # 业务读取入口
```

`--portal` 也可用 `PORTAL_URL` 环境变量；`RECORDS_FILE`、`ENROLLMENT_DIR` 可覆盖默认状态路径。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。

来源协议见 [CONTRACT.md](CONTRACT.md)。
