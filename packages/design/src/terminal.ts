/** Terminal renderer: the same atoms and tokens, as ANSI truecolor. */
import { atomFor, atomText, toneColor, toneSymbol, TAG_PREFIX, EMPTY, type Atom, type Layout, type Tone } from './index.ts';

const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const fg = (h: string, s: string) => (useColor ? `\x1b[38;2;${hex(h).join(';')}m${s}\x1b[39m` : s);
const tone = (t: Tone, s: string) => fg(toneColor(t), s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);

export function atom(a: Atom): string {
  switch (a.atom) {
    case 'badge': return tone(a.tone, `${toneSymbol(a.tone)} ${a.label}`);
    case 'tags': return a.items.map((t) => tone('accent', TAG_PREFIX + t)).join(' ');
    case 'date': return a.tone === 'neutral' ? a.label : tone(a.tone, a.label);
    case 'text': return a.tone ? tone(a.tone, a.text) : a.text;
    case 'empty': return dim(EMPTY);
  }
}

const pad = (s: string, plain: string, w: number) => s + ' '.repeat(Math.max(0, w - [...plain].length));

export function render(l: Layout): string {
  switch (l.layout) {
    case 'table': {
      if (!l.rows.length) return dim('No items.');
      const cells = l.rows.map((r) => l.columns.map((c) => atomFor(c.schema, r[c.key])));
      const widths = l.columns.map((c, i) => Math.max([...c.title].length, ...cells.map((row) => [...atomText(row[i])].length)));
      const head = l.columns.map((c, i) => pad(dim(c.title.toUpperCase()), c.title, widths[i])).join('  ');
      const rule = dim(widths.map((w) => '─'.repeat(w)).join('  '));
      const body = cells.map((row) => row.map((a, i) => pad(atom(a), atomText(a), widths[i])).join('  '));
      const ids = l.rows.map((r) => r.id).filter(Boolean);
      const idCol = ids.length === l.rows.length
        ? (line: string, i: number) => `${dim(String(l.rows[i].id).padEnd(Math.max(...ids.map((x) => String(x).length))))}  ${line}`
        : (line: string) => line;
      const idHead = ids.length === l.rows.length ? ' '.repeat(Math.max(...ids.map((x) => String(x).length)) + 2) : '';
      return [idHead + head, idHead + rule, ...body.map(idCol), l.next ? dim(`\nmore: --cursor ${l.next}`) : ''].filter(Boolean).join('\n');
    }
    case 'record': {
      const w = Math.max(...l.fields.map((f) => [...f.title].length));
      return l.fields.map((f) => `${dim(f.title.padEnd(w))}  ${atom(atomFor(f.schema, l.value[f.key]))}`).join('\n');
    }
    case 'problem': {
      const head = `${tone('danger', `✗ ${l.status}`)} ${bold(l.title)}`;
      const errs = l.errors.map((e) => `  ${tone('danger', '›')} ${e.pointer ? fg(toneColor('accent'), e.pointer) + ' ' : ''}${e.detail}${e.rule ? dim(`  [${e.rule}]`) : ''}`);
      const detail = l.detail && !l.errors.some((e) => e.detail === l.detail) ? [`  ${l.detail}`] : [];
      return [head, ...detail, ...errs].join('\n');
    }
    case 'operation': return progressLine(l);
    case 'empty': return tone('success', `${toneSymbol('success')} ${l.message}`);
    case 'raw': return JSON.stringify(l.value, null, 2);
  }
}

/** One line for a running operation: badge + bar + percent + title. */
export function progressLine(l: Extract<Layout, { layout: 'operation' }>, width = 24): string {
  const filled = Math.round((l.progress / 100) * width);
  const bar = tone(l.tone, '█'.repeat(filled)) + dim('░'.repeat(width - filled));
  return `${atom({ atom: 'badge', label: l.status, tone: l.tone })}  ${bar} ${String(l.progress).padStart(3)}%  ${l.title}`;
}
