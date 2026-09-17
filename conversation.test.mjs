import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversation } from '../app/api/telegram/conversation.mjs';

function fixture(actions, context = {}) {
  const calls = [];
  return { calls, options: {
    context: { text: 'Вопрос', media: [{ id: 'new' }, { id: 'old' }], ...context },
    request: async () => JSON.stringify(actions.shift() || { action: 'answer', text: 'Готово' }),
    search: async query => { calls.push(query); return { results: [] }; },
    inspect: async media => { calls.push(media.id); return { observation: 'Проверено' }; },
  } };
}
test('ordinary conversation needs no tools', async () => {
  const f = fixture([{ action: 'answer', text: 'Привет!' }]);
  assert.equal((await runConversation(f.options)).text, 'Привет!');
  assert.deepEqual(f.calls, []);
});
test('search can refine its query', async () => {
  const f = fixture([{ action: 'search', query: 'first' }, { action: 'search', query: 'refined' }]);
  await runConversation(f.options); assert.deepEqual(f.calls, ['first', 'refined']);
});
test('exact reply rejects unrelated media', async () => {
  const f = fixture([{ action: 'inspect', mediaId: 'old' }, { action: 'inspect', mediaId: 'new' }], { replyMediaId: 'new' });
  await runConversation(f.options); assert.deepEqual(f.calls, ['new']);
});
test('unknown media cannot be fetched', async () => {
  const f = fixture([{ action: 'inspect', mediaId: 'invented' }]);
  await runConversation(f.options); assert.deepEqual(f.calls, []);
});
test('duplicate tools are not executed twice', async () => {
  const f = fixture([{ action: 'search', query: 'same' }, { action: 'search', query: 'same' }]);
  await runConversation(f.options); assert.deepEqual(f.calls, ['same']);
});
test('tool failures are recoverable', async () => {
  const f = fixture([{ action: 'search', query: 'test' }]);
  f.options.search = async () => { throw Error('offline'); };
  assert.equal((await runConversation(f.options)).text, 'Готово');
});
test('invalid model output has a bounded fallback', async () => {
  const f = fixture([]); let count = 0;
  f.options.request = async () => { count++; return 'invalid'; };
  const result = await runConversation(f.options);
  assert.equal(count, 6); assert.match(result.text, /Не удалось/);
});
