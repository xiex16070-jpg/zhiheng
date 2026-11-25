/** 身份签名：签发、校验、防篡改、过期（R01 新格式 `id.exp.sig`）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AUTH_SECRET = 'test-secret-for-unit';
const { signIdentity, verifyIdentity, resolveMcpCaller, resolveIdentity, parseLegacyId, ID_RE } =
  await import('../src/server/auth.mjs');
const { config } = await import('../src/server/config.mjs');

/** 旧格式（`id.sig`，R01 之前的签发方式）签名，用于兼容性测试 */
const hmac22 = (data, secret = 'test-secret-for-unit') =>
  crypto.createHmac('sha256', secret).update(String(data)).digest('base64url').slice(0, 22);

test('签发后可还原身份（新格式 id.exp.sig）', () => {
  const v = signIdentity('u123abc');
  assert.equal(v.split('.').length, 3);
  assert.deepEqual(verifyIdentity(v), { id: 'u123abc', legacy: false });
});

test('旧格式签名仍可验证并标记 legacy（供 bootstrap 透明重签）', () => {
  const v = `u123abc.${hmac22('u123abc')}`;
  assert.deepEqual(verifyIdentity(v), { id: 'u123abc', legacy: true });
});

test('过期签名被拒绝', () => {
  const exp = Math.floor(Date.now() / 1000) - 10;
  const v = `u1.${exp}.${hmac22(`u1.${exp}`)}`;
  assert.equal(verifyIdentity(v), null);
});

test('篡改 id / exp 后签名校验失败', () => {
  const v = signIdentity('u123abc');
  const [id, exp, sig] = v.split('.');
  assert.equal(verifyIdentity(`u999999.${exp}.${sig}`), null);
  assert.equal(verifyIdentity(`${id}.${Number(exp) + 86400}.${sig}`), null);
  assert.equal(verifyIdentity(`${id}.${exp}.forgedsignature`), null);
  assert.equal(verifyIdentity(id), null);
});

test('非法 id 拒签（N-16：路径穿越/空白进不了签名与目录名）', () => {
  for (const bad of ['../evil', 'a b', '..', '', 'x'.repeat(33), 'a.b']) {
    assert.throws(() => signIdentity(bad), /invalid userId/);
    assert.equal(ID_RE.test(bad), false);
  }
});

test('不同密钥签不出可被接受的签名', () => {
  const exp = signIdentity('u1').split('.')[1];
  const forged = `u1.${exp}.${hmac22(`u1.${exp}`, 'another-secret')}`;
  assert.equal(verifyIdentity(forged), null);
});

test('空值与畸形输入不抛异常', () => {
  for (const v of [null, undefined, '', '.', '..', 'a.', '.b', 'a.b.c.d', 'a.1.2.3']) {
    assert.doesNotThrow(() => verifyIdentity(v));
    assert.equal(verifyIdentity(v), null);
  }
});

test('resolveMcpCaller：未配置令牌时仅本机回环放行', () => {
  assert.deepEqual(resolveMcpCaller({ loopback: true, uid: 'u1' }), { ok: true, callerId: 'u1', allowAll: true });
  assert.deepEqual(resolveMcpCaller({ loopback: true, uid: null }), { ok: true, callerId: 'mcp', allowAll: true });
  assert.equal(resolveMcpCaller({ loopback: false, uid: 'u1' }).ok, false);
});

test('resolveMcpCaller：配置令牌后必须命中，且身份绑定到令牌（R02/N-03）', () => {
  config.mcp.tokens.set('tok-abc', 'alice');
  try {
    assert.deepEqual(resolveMcpCaller({ authorization: 'Bearer tok-abc', loopback: true, uid: 'someoneelse' }), {
      ok: true,
      callerId: 'alice',
      allowAll: false,
    });
    // Scheme 不区分大小写；配置令牌后非回环也能用（令牌即凭据）
    assert.equal(resolveMcpCaller({ authorization: 'bearer tok-abc', loopback: false }).ok, true);
    assert.equal(resolveMcpCaller({ authorization: 'Bearer wrong-token', loopback: true }).ok, false);
    assert.equal(resolveMcpCaller({ authorization: 'tok-abc', loopback: true }).ok, false); // 缺 Scheme
    assert.equal(resolveMcpCaller({ loopback: true }).ok, false); // 配置令牌后回环匿名不再放行
  } finally {
    config.mcp.tokens.delete('tok-abc');
  }
});

test('resolveIdentity：未签名/伪造身份一律 null（不再回退共享 anon）', () => {
  assert.equal(resolveIdentity({ cookieValue: 'attacker', loopback: false }), null);
  assert.equal(resolveIdentity({ headerId: 'attacker', loopback: false }), null);
  // 回环但 legacy 开关未开（默认）→ 同样 null
  assert.equal(resolveIdentity({ cookieValue: 'attacker', loopback: true }), null);
  assert.equal(resolveIdentity({ headerId: 'attacker', loopback: true }), null);
});

test('resolveIdentity：合法签名可以还原身份', () => {
  const v = signIdentity('victim');
  assert.equal(resolveIdentity({ cookieValue: v, loopback: false }), 'victim');
  const legacy = `olduser.${hmac22('olduser')}`;
  assert.equal(resolveIdentity({ cookieValue: legacy, loopback: false }), 'olduser');
});

test('resolveIdentity：仅 legacyLoopback 开启时回环才认明文，且过白名单', () => {
  config.auth.legacyLoopback = true;
  try {
    assert.equal(resolveIdentity({ cookieValue: 'legacy-user', loopback: true }), 'legacy-user');
    assert.equal(resolveIdentity({ headerId: 'legacy-user', loopback: true }), 'legacy-user');
    // N-19：签名残片剥掉后取 id，不会拼出 "u1.oldsignature"
    assert.equal(resolveIdentity({ cookieValue: 'u1.oldsignature', loopback: true }), 'u1');
    // N-16：非法值（路径穿越/空白）拒绝
    assert.equal(resolveIdentity({ cookieValue: '../evil', loopback: true }), null);
    assert.equal(resolveIdentity({ headerId: 'a b', loopback: true }), null);
    // 非回环依旧不认明文
    assert.equal(resolveIdentity({ cookieValue: 'legacy-user', loopback: false }), null);
  } finally {
    config.auth.legacyLoopback = false;
  }
  assert.equal(resolveIdentity({ cookieValue: 'legacy-user', loopback: true }), null);
});

test('parseLegacyId：剥签名残片并过滤非法值', () => {
  assert.equal(parseLegacyId('u1.abc'), 'u1');
  assert.equal(parseLegacyId('alice'), 'alice');
  assert.equal(parseLegacyId('../x'), null);
  assert.equal(parseLegacyId('a b'), null);
  assert.equal(parseLegacyId(''), null);
  assert.equal(parseLegacyId(null), null);
});

test('审批过期判定', async () => {
  const { approvalExpired } = await import('../src/server/orchestrator.mjs');
  const now = Date.now();
  assert.equal(approvalExpired(null), false);
  assert.equal(approvalExpired({ status: 'approved', createdAt: new Date(now - 999999).toISOString() }), false);
  assert.equal(approvalExpired({ status: 'pending', createdAt: new Date(now - 1000).toISOString() }), false);
  // 默认 10 分钟，构造一个 11 分钟前的 pending
  assert.equal(approvalExpired({ status: 'pending', createdAt: new Date(now - 11 * 60 * 1000).toISOString() }), true);
  assert.equal(approvalExpired({action:'ask_user',status:'pending',createdAt:new Date(now-2*60*60*1000).toISOString()}),false,'clarification stays resumable for a day');
  assert.equal(approvalExpired({action:'ask_user',status:'pending',createdAt:new Date(now-25*60*60*1000).toISOString()}),true);
  // 缺少时间戳时保守处理：不算过期
  assert.equal(approvalExpired({ status: 'pending' }), false);
});
