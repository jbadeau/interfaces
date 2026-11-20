import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, collectRules, checkRule } from './index.ts';
import spec from '../../contract/generated/openapi.json' with { type: 'json' };

const schemas = (spec as any).components.schemas;
const rules = collectRules(schemas.TodoCreate);
const now = new Date('2026-11-20T12:00:00Z');
const pointers = (self: unknown) => evaluate(rules, self, now).map((v) => v.pointer);

test('rules are read from the spec', () => assert.equal(rules.length, 3));

test('valid payload passes', () =>
  assert.deepEqual(pointers({ title: 'Ship demo', priority: 'high', dueDate: '2026-11-21', tags: ['work', 'demo'] }), []));

test('high priority requires a due date', () =>
  assert.deepEqual(pointers({ title: 'Ship demo', priority: 'high' }), ['/dueDate']));

test('low priority does not require a due date', () =>
  assert.deepEqual(pointers({ title: 'Someday', priority: 'low' }), []));

test('due date cannot be in the past', () =>
  assert.deepEqual(pointers({ title: 'Too late', dueDate: '2026-11-19' }), ['/dueDate']));

test('due date today is fine', () =>
  assert.deepEqual(pointers({ title: 'Today', dueDate: '2026-11-20' }), []));

test('tags must be unique', () =>
  assert.deepEqual(pointers({ title: 'Dupes', tags: ['a', 'b', 'a'] }), ['/tags']));

test('preconditions: complete only open todos', () => {
  const pre = schemas && (spec as any).paths['/todos/{id}/complete'].post['x-preconditions'];
  assert.deepEqual(evaluate(pre, { status: 'open' }), []);
  assert.equal(evaluate(pre, { status: 'done' })[0].detail, 'Only open todos can be completed.');
});

test('invalid CEL is detected', () => assert.notEqual(checkRule('self.title =='), null));
