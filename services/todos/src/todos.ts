/**
 * The ONLY hand-written business code: one handler per operationId.
 * Validation (structural + semantic) has already happened in the router.
 */
import { randomBytes } from 'node:crypto';
import type { Todo, TodoCreate } from '@demo/contract';
import { problem, type Implementation } from './spec-router.ts';
import { accepted, operationHandlers, start } from './operations.ts';

const store = new Map<string, Todo>();
const archive = new Map<string, Todo>();
const now = () => new Date().toISOString();
const newId = () => `todo-${randomBytes(4).toString('hex')}`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

for (const seed of [
  { title: 'Write the ADR', priority: 'high', dueDate: inDays(2), tags: ['architecture'] },
  { title: 'Review OpenAPI spec', priority: 'medium', tags: ['api', 'review'] },
  { title: 'Water the plants', priority: 'low' },
] as TodoCreate[]) {
  const id = newId();
  store.set(id, { ...seed, id, status: 'open', createdAt: now(), completedAt: null });
}

const encodeCursor = (n: number) => Buffer.from(String(n)).toString('base64url');
const decodeCursor = (c?: string) => (c ? Number(Buffer.from(c, 'base64url').toString()) || 0 : 0);

const find = (id: string) => {
  const t = store.get(id);
  if (!t) throw problem(404, 'Todo not found', { detail: `No todo with id ${id}` });
  return t;
};

export const todos: Implementation = {
  load: ({ id }) => store.get(id),

  handlers: {
    listTodos: ({ query: { limit, cursor, status, priority } }) => {
      const all = [...store.values()].filter(
        (t) => (!status || t.status === status) && (!priority || t.priority === priority),
      );
      const start = decodeCursor(cursor);
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? encodeCursor(start + limit) : null;
      return { status: 200, body: { items, nextCursor: next } };
    },

    createTodo: ({ body }) => {
      const input = body as TodoCreate;
      const todo: Todo = {
        ...input, // priority default already applied from the schema
        id: newId(), status: 'open', createdAt: now(), completedAt: null,
      };
      store.set(todo.id, todo);
      return { status: 201, body: todo };
    },

    getTodo: ({ params }) => ({ status: 200, body: find(params.id) }),

    deleteTodo: ({ params }) => {
      find(params.id);
      store.delete(params.id);
      return { status: 204 };
    },

    // Preconditions (status == 'open' / 'done') are enforced from the spec.
    completeTodo: ({ current }) => {
      Object.assign(current, { status: 'done', completedAt: now() });
      return { status: 200, body: current };
    },

    reopenTodo: ({ current }) => {
      Object.assign(current, { status: 'open', completedAt: null });
      return { status: 200, body: current };
    },

    // Long-running: answers 202 at once; clients poll the operation.
    archiveTodos: () => accepted(start('Archive completed todos', async (report) => {
      const done = [...store.values()].filter((t) => t.status === 'done');
      const steps = Math.max(done.length, 3); // pace it so progress is visible even with few todos
      for (let i = 0; i < steps; i++) {
        await new Promise((r) => setTimeout(r, 900)); // stands in for slow downstream work
        if (done[i]) { archive.set(done[i].id, done[i]); store.delete(done[i].id); }
        report(((i + 1) / steps) * 100);
      }
      return { archived: done.length };
    })),

    ...operationHandlers,
  },
};
