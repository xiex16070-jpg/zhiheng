/**
 * 本地联调用的 mock 模型（OpenAI 兼容，SSE 流式）。
 *
 * 行为：
 *   1. 第一轮返回 search_knowledge 工具调用；
 *   2. 第二轮基于工具结果作答并带 [[论文ID]] 引用；
 *   3. 问句含「简洁/偏好」时返回 update_preferences 调用（触发审批）；
 *   4. 问句含「红烧肉/菜谱」时走 NO_EVIDENCE 分支。
 *
 * 运行：node scripts/mock-llm.mjs [port]
 */

import http from 'node:http';

const PORT = Number(process.argv[2] || 8080);

const chunk = (delta, finish = null) => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function pickIds(text) {
  const ids = [];
  const re = /ref=([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(text))) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

function sendToolCall(res, name, args) {
  const s = JSON.stringify(args);
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
  res.write(
    `data: ${JSON.stringify(
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] })
    )}\n\n`
  );
  for (let i = 0; i < s.length; i += 10) {
    res.write(
      `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: s.slice(i, i + 10) } }] }))}\n\n`
    );
  }
  res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function streamText(res, text) {
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
  for (let i = 0; i < text.length; i += 10) {
    res.write(`data: ${JSON.stringify(chunk({ content: text.slice(i, i + 10) }))}\n\n`);
    await new Promise((r) => setTimeout(r, 6));
  }
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  res.write(
    `data: ${JSON.stringify({
      id: 'mock',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 320, completion_tokens: 160, total_tokens: 480 },
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  // 供「测试连接」使用
  if (req.url.endsWith('/models')) {
    const body = JSON.stringify({
      object: 'list',
      data: [{ id: 'mock' }, { id: 'mock-pro' }, { id: 'mock-mini' }],
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }

  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const messages = body.messages || [];
  const userMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const systemMsg = messages.find((m) => m.role === 'system')?.content || '';

  // 查询改写：返回 3 条变体，用来验证多路召回
  if (systemMsg.includes('查询改写器')) {
    const base = userMsg.replace(/[？?。！!]/g, '').trim();
    const variants = [base.replace(/是什么|有哪些|怎么样|如何/g, '').trim(), `${base} 研究进展`, `${base} 方法`]
      .filter((x) => x && x.length >= 2)
      .slice(0, 3);
    return streamText(res, JSON.stringify(variants));
  }

  const wantsPref = /偏好|风格|简洁一点/.test(userMsg);
  const noEvidence = /红烧肉|菜谱|怎么做菜/.test(userMsg);

  if (hasTools && !toolMsgs.length && !noEvidence) {
    if (wantsPref) return sendToolCall(res, 'update_preferences', { style: 'concise', citeQuotes: true });
    const q = userMsg.replace(/^用户问题：/, '').split('\n')[0].replace(/[？?。！!]/g, '').slice(0, 40);
    return sendToolCall(res, 'search_knowledge', { query: q, top_k: 5 });
  }

  if (wantsPref && toolMsgs.length) {
    return streamText(res, '已按你的偏好把回答风格调整为「简洁」，后续回答会只保留结论与关键依据。');
  }

  const ids = pickIds(toolMsgs.map((m) => m.content).join('\n'));

  if (noEvidence || !ids.length) {
    return streamText(
      res,
      'NO_EVIDENCE: 我检索了该问题的关键词，文献库中没有摘要涉及这个主题。当前库覆盖 2010-2020 年中文核心期刊的 13 个门类、67 个学科。'
    );
  }

  const answer = `知识库中与这个问题最相关的是以下内容。

- 该方向已有明确论述，结论集中在方法改进与效果验证上 [[${ids[0]}]]。
- 另一条依据从不同角度补充了证据，可作为交叉参考 [[${ids[1] || ids[0]}]]。

\`\`\`text
方法要点：数据预处理 → 特征构建 → 对照实验 → 显著性检验
\`\`\`

以上结论均可点击编号回到摘要原文核对。`;

  return streamText(res, answer);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] http://127.0.0.1:${PORT}/v1`));
