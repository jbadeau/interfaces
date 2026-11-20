/** React renderer: the same atoms and tokens, as DOM + CSS variables. */
import type { ReactNode } from 'react';
import { atomFor, tokens, toneSymbol, TAG_PREFIX, EMPTY, type Atom, type Column, type Tone } from './index.ts';

/** Emits design tokens as CSS custom properties (light + dark). */
export function ThemeStyle() {
  const tones = Object.entries(tokens.tone).map(([k, v]) => `--tone-${k}: ${v.color.$value};`).join('');
  const surface = (m: 'light' | 'dark') => Object.entries(tokens.surface[m]).map(([k, v]) => `--${k}: ${v.$value};`).join('');
  const css = `:root{${tones}${surface('light')}}@media (prefers-color-scheme: dark){:root{${surface('dark')}}}`;
  return <style>{css}</style>;
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className="atom-badge" style={{ ['--t' as any]: `var(--tone-${tone})` }}>{toneSymbol(tone)} {children}</span>;
}

export const Tag = ({ children }: { children: ReactNode }) => <span className="atom-tag">{TAG_PREFIX}{children}</span>;

export function AtomView({ atom: a }: { atom: Atom }) {
  switch (a.atom) {
    case 'badge': return <Badge tone={a.tone}>{a.label}</Badge>;
    case 'tags': return <>{a.items.map((t) => <Tag key={t}>{t}</Tag>)}</>;
    case 'date': return <time dateTime={a.iso} style={a.tone === 'neutral' ? undefined : { color: `var(--tone-${a.tone})` }}>{a.label}</time>;
    case 'text': return <span>{a.text}</span>;
    case 'empty': return <span className="atom-empty">{EMPTY}</span>;
  }
}

export const Value = ({ schema, value }: { schema?: Record<string, any>; value: unknown }) =>
  <AtomView atom={atomFor(schema, value)} />;

export function Button({ tone = 'neutral', ...props }: { tone?: Tone } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`atom-button ${props.className ?? ''}`} style={{ ['--t' as any]: `var(--tone-${tone})` }} />;
}

export function Table({ columns, rows, rowKey, rowClass, actions }: {
  columns: Column[];
  rows: Record<string, any>[];
  rowKey: (r: any) => string;
  rowClass?: (r: any) => string;
  actions?: (r: any) => ReactNode;
}) {
  return (
    <table className="atom-table">
      <thead><tr>{columns.map((c) => <th key={c.key}>{c.title}</th>)}{actions && <th />}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={rowKey(r)} className={rowClass?.(r)}>
            {columns.map((c) => <td key={c.key} data-col={c.key}><Value schema={c.schema} value={r[c.key]} /></td>)}
            {actions && <td className="actions">{actions(r)}</td>}
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={columns.length + 1} className="atom-empty">No items.</td></tr>}
      </tbody>
    </table>
  );
}
