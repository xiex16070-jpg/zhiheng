# 用 Langfuse 排查一次 Agent 任务

若任务很慢，可以在一条轨迹上比较首次检索、模型请求和工具执行的起止时间。若同一模型请求重试，时间线上会出现多个 `model.call`。模型完成了请求、工具成功执行和最终引用支持回答是三个独立的判断。引用与回答质量仍通过项目评测验证。

## 服务器配置

1. 在自己的 Langfuse 实例中新建测试项目，创建该项目的 Public Key 和 Secret Key。试用期先确定删除日期和负责清理的人。使用支持保留策略的版本时，可在 Project Settings → Data Retention 为这个项目设 7 天。其他版本可在试用结束时删除专用项目。云版的历史可见天数仅影响查询范围。[保留策略](https://langfuse.com/docs/administration/data-retention) · [数据删除](https://langfuse.com/docs/administration/data-deletion)
2. 在知衡服务端的环境变量或本地 `.env` 中填写下列四项，重启知衡。示例地址假设 Langfuse 映射到本机 3100 端口。使用远程实例须填 HTTPS 根地址。应用会追加 `/api/public/otel/v1/traces`。请使用支持 OTLP/HTTP JSON 的实例版本。[Langfuse OTLP 接口](https://langfuse.com/integrations/native/opentelemetry)

   ```dotenv
   LANGFUSE_TRACING_ENABLED=1
   LANGFUSE_BASE_URL=http://127.0.0.1:3100
   LANGFUSE_PUBLIC_KEY=<项目公钥>
   LANGFUSE_SECRET_KEY=<项目密钥>
   ```

3. 用一句合成问题执行一次 Agent 任务，例如“什么是循环不变式？”。在 `/api/chat` 的 SSE 中找到 `type=task` 且 `task.status=running` 的事件，复制 `task.traceId`。任务所属用户也可以访问 `GET /api/tasks/<任务ID>`，在 `steps` 中找到本次 `attempt` 下 `name=trace` 的记录，读取 `detail.traceId`。
4. 在 Langfuse 的 Tracing 页面按追踪 ID 查找。审批会结束当前尝试，恢复后会生成另一条轨迹。本地步骤的 `attempt` 可区分两次尝试。直接调用 `/api/search` 也会产生独立的检索轨迹。

### 本机实例的端到端验收

如果使用本地模型，可让模型、知衡和 Langfuse 分别监听不同的回环端口。将上面四个变量放在仓库之外的私有文件，只给运行知衡的账户读取权限。在项目目录执行下列命令，替换为自己的凭据文件路径，即可用项目支持的 Node 版本为单个知衡进程载入配置。

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
node --env-file="D:\private\langfuse\app.env" server.mjs
```

1. 在新会话中选择回环模型，提一个需要教材原文作答的问题，并让模型调用 `read_source`。核对工具返回的章节与最终引用，记下这次尝试的 `traceId`。
2. 登录自己的 Langfuse 项目，在追踪详情展开调用树。对于一次读取原文的任务，应看到 `agent.task` 下的首次 `retrieval.search`、模型调用、`tool.execute` 和读取后的模型调用。在工具节点的 Metadata 中确认名称为 `read_source`。若模型调用的是 `search_knowledge`，该工具节点下还会出现检索子节点。
3. 展开根节点和各子节点的 Input、Output、Metadata。验证实际请求时，应检查发往 OTLP 端点的序列化请求体，限定字段及其取值，并将其中的每个 span ID、父 ID 与服务端返回的 observation 逐一比对。记录请求体哈希和节点数即可，保留签名密钥、请求头或原文副本会扩大敏感数据的接触范围。

| 观察项 | 读法 |
|---|---|
| `agent.task` | 单次任务尝试的总耗时，包含等待模型与工具的时间。等待人工审批单独标记 |
| `model.call` | 一次实际聊天请求，计时覆盖流式响应。重试产生独立记录 |
| `tool.execute` | 一次工具执行，只允许导出内置工具名称。查看类别可区分参数不合法、被拒绝及执行出错等情况 |
| `retrieval.search` | 一次融合检索。首次检索归在任务下，工具引发的检索归在工具下。可见空结果、证据偏弱或部分检索降级等状态 |

## 数据范围和投递状态

导出器从固定字段构造请求，只记录随机追踪与父子 ID、操作类型、时间以及有限的状态类别。问题、提示词、模型回答、原文、工具参数及返回值、错误正文、用户或任务标识均不进入追踪载荷。项目密钥仅用于向配置的实例发送 HTTP 身份验证头。知衡的本地步骤与审批记录仍受原有身份检查保护。

持有会话身份的管理员可从 `GET /api/metrics` 的 `stack.tracing` 查看当前进程的状态。沿用项目已有的 `x-admin-token` 或本机管理员设置。配置完整时 `state=enabled`，缺少密钥或地址无效时为 `misconfigured`，关闭时为 `disabled`。`pending` 表示尚待确认的记录数，`exported`、`failed`、`dropped` 分别统计本进程确认投递、投递失败和因容量等原因丢弃的记录数。仅凭 `enabled` 无法判定实例接收成功。

追踪通过内存队列异步发送，含在途记录最多 128 条，单次请求限时 2 秒。收集端超时、拒绝或队列满时，业务请求照常完成，部分轨迹可能缺少节点。设 `LANGFUSE_TRACING_ENABLED=0` 并重启即可关闭。远端已有记录按项目的删除策略处理。

## 离线验收

```bash
node --test tests/tracing.test.mjs tests/tracing-integration.test.mjs
```

集成用例启动隔离的知衡服务、回环模型和 OTLP 接收端，通过真实 API 验证带检索工具的成功任务、上游模型报错及审批后恢复失败。测试检查父子关系、每次尝试的追踪 ID、管理员可见范围，并在实际发出的载荷中搜索预埋的私密标记。Langfuse 界面的入库验收需使用上面的测试项目配置。
