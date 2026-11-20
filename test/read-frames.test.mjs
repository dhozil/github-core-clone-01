import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../app.ts';

test('warm REST frames follow issue, repository, and ref mutations', async t => {
  process.env.MAKEFUN_SHOP_TOKEN = 'cache-test';
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v3';
  const repo = '/repos/adaiversen/frame-test';

  async function call(path, method = 'GET', body, expected = 200, token = 'cache-test') {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected);
    return response.json();
  }

  await call('/user/repos', 'POST', { name: 'frame-test' }, 201);
  const issue = await call(repo + '/issues', 'POST', { title: 'Unicode ✓' }, 201);
  const issuePath = repo + '/issues/' + issue.number;
  assert.deepEqual(await call(issuePath), issue);
  assert.deepEqual(await call(issuePath), issue);
  await call(issuePath, 'GET', undefined, 401, 'wrong');
  await call(issuePath, 'PATCH', { state: 'closed' });
  assert.equal((await call(issuePath)).state, 'closed');

  assert.equal((await call(repo)).description, '');
  assert.equal((await call(repo)).description, '');
  await call(repo, 'PATCH', { description: 'updated' });
  assert.equal((await call(repo)).description, 'updated');

  const branches = repo + '/branches';
  assert.deepEqual(await call(branches), []);
  assert.deepEqual(await call(branches), []);
  const commit = await call(repo + '/contents/a.txt', 'PUT', { content: 'YQ==' }, 201);
  assert.deepEqual(await call(branches), [{ name: 'main', commit: commit.commit }]);
  await call(repo + '/git/refs', 'POST', { ref: 'refs/heads/next', sha: commit.commit.sha }, 201);
  assert.deepEqual((await call(branches)).map(branch => branch.name), ['main', 'next']);
});
