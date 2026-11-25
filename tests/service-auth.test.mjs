import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceAuth } from '../src/server/service-auth.mjs';
test('service tokens are owner-bound, hashed, scoped to task submission and never approval', () => {
  const token = 'a'.repeat(32); const auth = createServiceAuth(`${token}:alice,short:bob,${'b'.repeat(32)}:../bad`); const req = { method: 'POST', headers: { authorization: `Bearer ${token}` } };
  assert.equal(auth.enabled, true); const identity = auth.authenticate(req); assert.equal(identity.userId, 'alice'); assert.equal(identity.canApprove, false); assert.equal(identity.canConfigure, false);
  assert.equal(auth.authenticate(req, { route: '/api/settings' }), null); assert.equal(auth.authenticate({ ...req, method: 'GET' }), null); assert.equal(auth.authenticate({ ...req, headers: { authorization: `Bearer ${'c'.repeat(32)}` } }), null);
  assert.equal(createServiceAuth('short:alice').enabled, false); assert.ok(!JSON.stringify(auth).includes(token));
});
