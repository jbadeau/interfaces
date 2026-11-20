/** Text/markdown renderer for MCP tool results: the same atoms, as symbols. */
import { atomFor, atomText, EMPTY, type Layout } from './index.ts';

const cell = (s: string) => s.replaceAll('|', '\\|');

export function render(l: Layout): string {
  switch (l.layout) {
    case 'table': {
      if (!l.rows.length) return '_No items._';
      const hasId = l.rows.every((r) => r.id);
      const cols = hasId ? [{ key: 'id', title: 'ID', schema: {} }, ...l.columns] : l.columns;
      const head = `| ${cols.map((c) => c.title).join(' | ')} |\n|${cols.map(() => '---').join('|')}|`;
      const rows = l.rows.map((r) => `| ${cols.map((c) => cell(c.key === 'id' ? `\`${r.id}\`` : atomText(atomFor(c.schema, r[c.key])))).join(' | ')} |`);
      return [head, ...rows, l.next ? `\nMore results: cursor \`${l.next}\`` : ''].filter(Boolean).join('\n');
    }
    case 'record':
      return l.fields.map((f) => `- **${f.title}:** ${atomText(atomFor(f.schema, l.value[f.key]))}`).join('\n');
    case 'problem':
      return [
        `✗ **${l.status} ${l.title}**${l.detail ? ` — ${l.detail}` : ''}`,
        ...l.errors.map((e) => `- \`${e.pointer || '/'}\` ${e.detail}${e.rule ? ` (rule: \`${e.rule}\`)` : ''}`),
      ].join('\n');
    case 'operation': return `${atomText({ atom: 'badge', label: l.status, tone: l.tone })} ${l.progress}% — ${l.title}`;
    case 'empty': return `✓ ${l.message}`;
    case 'raw': return '```json\n' + JSON.stringify(l.value, null, 2) + '\n```';
  }
}
export { EMPTY };
