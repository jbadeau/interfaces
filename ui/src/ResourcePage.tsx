import { useCallback, useEffect, useMemo, useState } from 'react';
import Form from '@rjsf/core';
import type { ErrorSchema, FormValidation, RJSFSchema, UiSchema } from '@rjsf/utils';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import { collectRules, evaluate } from '@demo/semantic';
import { layoutFor } from '@demo/design';
import { Badge, Button, Table } from '@demo/design/react';
import { isOperation, pollOperation, type OperationLike } from '@demo/contract/async';
import { call, fillPath, resourceModel, type ProblemResponse } from './resource';
import type { Operation } from '@demo/contract';
import { completeSignIn, missingScopes, signIn, signOut, type Session } from './auth';

// RJSF validates with the same JSON Schema dialect as the service (2020-12).
const validator = customizeValidator({ AjvClass: Ajv2020 });

/** Turn RFC 9457 `errors[].pointer` into RJSF's nested ErrorSchema. */
function toErrorSchema(problem: ProblemResponse): ErrorSchema {
  const root: any = {};
  for (const e of problem.errors ?? []) {
    let node = root;
    for (const seg of (e.pointer ?? '').split('/').filter(Boolean)) node = node[seg] ??= {};
    (node.__errors ??= []).push(e.detail);
  }
  return root;
}

export function ResourcePage({ collectionPath }: { collectionPath: string }) {
  const model = useMemo(() => resourceModel(collectionPath), [collectionPath]);
  // Same layout model the CLI and MCP use: columns + atoms come from the spec.
  const columns = useMemo(() => {
    const l = layoutFor({ properties: { items: { type: 'array', items: model.itemSchema } } }, { items: [] });
    return l.layout === 'table' ? l.columns : [];
  }, [model]);
  const rules = useMemo(() => collectRules(model.createSchema), [model]);
  const filters = model.list.parameters!.filter((p) => p.in === 'query' && p.schema.enum);

  const [items, setItems] = useState<any[]>([]);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [formData, setFormData] = useState<any>({});
  const [extraErrors, setExtraErrors] = useState<ErrorSchema>();
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [formKey, setFormKey] = useState(0);
  const [running, setRunning] = useState<OperationLike>();
  const [me, setMe] = useState<Session>();
  const [authReady, setAuthReady] = useState(false);
  useEffect(() => { completeSignIn().then((s) => { setMe(s); setAuthReady(true); }); }, []);
  /** Authorization from the spec: why the signed-in user may not run `op` (or undefined). */
  const denied = (op?: Operation) => {
    if (!op) return undefined;
    const m = missingScopes(op, me);
    return m.length ? `Requires scope ${m.join(', ')}` : undefined;
  };

  const flash = (kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(undefined), 3500);
  };

  const load = useCallback(async () => {
    if (!me) return;
    try {
      const page = await call('get', collectionPath, undefined, { limit: '100', ...query });
      setItems(page.items);
    } catch (p: any) {
      if (p.status === 401) setMe(signOut());
      else flash('error', p.title);
    }
  }, [collectionPath, query, me]);
  useEffect(() => { load(); }, [load]);

  // Semantic validation in the browser: the SAME CEL rules the service enforces.
  const customValidate = (data: any, errors: FormValidation) => {
    for (const v of evaluate(rules, data)) {
      let node: any = errors;
      for (const seg of v.pointer.split('/').filter(Boolean)) node = node?.[seg];
      (node ?? errors).addError(v.detail);
    }
    return errors;
  };

  const submit = async ({ formData: body }: any) => {
    try {
      const created = await call('post', collectionPath, body);
      flash('ok', `Created ${created.id}`);
      setFormData({});
      setFormKey((k) => k + 1);
      setExtraErrors(undefined);
      load();
    } catch (p: any) {
      setExtraErrors(toErrorSchema(p));
      flash('error', p.title);
    }
  };

  // Long-running operations: 202 + Operation, polled with the shared poller.
  const runCollectionAction = async (path: string) => {
    try {
      let res = await call('post', path);
      if (isOperation(res)) {
        res = await pollOperation(res, (href) => call('get', href), { onUpdate: setRunning });
        setRunning(undefined);
        if (res.status === 'failed') return flash('error', res.error?.title ?? 'Operation failed');
        const summary = Object.entries(res.result ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ');
        flash('ok', `${res.title}: done${summary ? ` (${summary})` : ''}`);
      }
      load();
    } catch (p: any) {
      setRunning(undefined);
      flash('error', p.detail ?? p.title);
    }
  };

  const act = async (method: string, path: string, row: any) => {
    try {
      await call(method, fillPath(path, row));
      load();
    } catch (p: any) {
      flash('error', p.detail ?? p.title);
    }
  };

  if (authReady && !me) {
    return (
      <main className="signin">
        <section className="card">
          <h1>{model.title}</h1>
          <p className="muted">Sign in to continue. Who may do what is declared in <code>openapi.yaml</code> (OAuth2 scopes) and enforced by the API for every interface.</p>
          <Button tone="accent" onClick={signIn}>Sign in with Platform SSO</Button>
        </section>
      </main>
    );
  }
  if (!me) return null;

  return (
    <main>
      <header>
        <div className="whoami">
          <span><b>{me.name}</b> <span className="muted">{me.scopes.join(' · ')}</span></span>
          <Button onClick={() => { setMe(signOut()); setItems([]); }}>Sign out</Button>
        </div>
        <h1>{model.title}</h1>
        <p className="muted">
          Everything on this page is rendered from <code>openapi.yaml</code>: form, validation, columns, filters and actions.
        </p>
      </header>

      <div className="layout">
        {model.create && (
          <section className="card">
            <h2>{model.create.summary}</h2>
            <Form
              key={formKey}
              disabled={!!denied(model.create)}
              schema={model.createSchema as RJSFSchema}
              uiSchema={{ ...(model.createSchema!['x-ui-schema'] as UiSchema), 'ui:submitButtonOptions': { submitText: 'Create', norender: !!denied(model.create) } }}
              validator={validator}
              formData={formData}
              onChange={(e) => setFormData(e.formData)}
              customValidate={customValidate}
              extraErrors={extraErrors}
              onSubmit={submit}
              showErrorList={false}
              liveValidate="onChange"
              noHtml5Validate
            />
          </section>
        )}

        <section className="card grow">
          <div className="toolbar">
            <h2>{model.list.summary}</h2>
            {model.collectionActions.map(({ name, path, op }) => (
              <Button key={name} tone="accent" title={denied(op) ?? op.summary} disabled={!!running || !!denied(op)} onClick={() => runCollectionAction(path)}>
                {name}
              </Button>
            ))}
            {filters.map((f) => (
              <label key={f.name}>
                {f.schema.title ?? f.name}
                <select
                  value={query[f.name] ?? ''}
                  onChange={(e) => setQuery(({ [f.name]: _, ...q }) => (e.target.value ? { ...q, [f.name]: e.target.value } : q))}
                >
                  <option value="">all</option>
                  {f.schema.enum.map((v: string) => <option key={v}>{v}</option>)}
                </select>
              </label>
            ))}
          </div>
          <Table
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            rowClass={(r) => `status-${r.status}`}
            actions={(row) => (
              <>
                {model.actions.map(({ name, path, op }) => {
                  // Preconditions from the spec decide whether a button is enabled.
                  const blocked = denied(op) ?? evaluate(op['x-preconditions'] ?? [], row)[0]?.detail;
                  return (
                    <Button key={name} tone="accent" disabled={!!blocked} title={blocked ?? op.summary}
                      onClick={() => act('post', path, row)}>
                      {name}
                    </Button>
                  );
                })}
                {model.remove && (
                  <Button tone="danger" title={denied(model.remove) ?? model.remove.summary} disabled={!!denied(model.remove)} onClick={() => act('delete', model.itemPath, row)}>
                    delete
                  </Button>
                )}
              </>
            )}
          />
        </section>
      </div>
      {running && (
        <div className="toast progress">
          <div className="progress-head"><Badge tone={running.status === 'pending' ? 'neutral' : 'info'}>{running.status}</Badge><span className="op-title">{running.title}</span><b>{running.progress}%</b></div>
          <div className="progress-bar"><i style={{ width: `${running.progress}%` }} /></div>
        </div>
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </main>
  );
}
