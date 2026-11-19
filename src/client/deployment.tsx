/**
 * Deployment settings view and standalone HTTP adapter.
 * Displays instance details and edits machine limits via `/orchestrator/api/deployment` or an injected store.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { DeploymentOp, DeploymentView } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { ApiError, usePoll, type Call, type SetupView } from './api.ts'
import { InfoTip, Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { setupText, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'

export type DeploymentValue = DeploymentView['value']
export interface DeploymentSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: DeploymentValue
  revision: number | undefined
  writable: boolean
  readOnlyReason?: 'readonly' | 'unavailable'
  error?: string
}
export interface DeploymentStore {
  getSnapshot(): DeploymentSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: DeploymentOp[], revision: number): Promise<boolean | { revision: number }>
  reload?: () => Promise<void>
}
export interface DeploymentFormAdapter {
  state: DeploymentSnapshot
  mutate: DeploymentStore['mutate']
  reload?: () => Promise<void>
}
export type DeploymentForm = DeploymentFormAdapter | undefined

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

const NOP = () => {}
export function usePageForm(form: DeploymentStore | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : NOP, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state
    ? { state, mutate: form.mutate.bind(form), ...form.reload ? { reload: form.reload.bind(form) } : {} }
    : undefined, [form, state])
}

/** Poll and mutate machine limits through `GET/PUT /orchestrator/api/deployment`. */
export function useHttpDeploymentForm(call: Call, intervalMs = 5000): DeploymentForm {
  const { data, error, reload } = usePoll(() => call('GET deployment'), [call], intervalMs)
  return useMemo(() => {
    const unavailable = !!error
    const transient = error instanceof ApiError && (!!error.details.unreachable || error.status === 503)
    const state: DeploymentSnapshot = unavailable ? {
      status: 'unavailable',
      value: data?.value ?? { stateDir: '' },
      revision: data?.revision,
      writable: false,
      readOnlyReason: 'unavailable',
      ...transient || !error.message ? {} : { error: error.message },
    } : data ? {
      status: 'ready',
      value: data.value,
      revision: data.revision,
      writable: data.writable,
      ...data.writable ? {} : { readOnlyReason: 'readonly' as const },
    } : {
      status: 'loading',
      value: { stateDir: '' },
      revision: undefined,
      writable: false,
    }
    const mutate: DeploymentStore['mutate'] = async (ops, revision) => {
      const updated = await call('PUT deployment', { body: { revision, ops } })
      return { revision: updated.revision }
    }
    return { state, mutate, reload }
  }, [call, data, error, reload])
}

/** Deployment configuration form; falls back to read-only display when unavailable or read-only. */
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  const savedSource = snapshot?.status === 'ready' ? snapshot.value : setup.machine
  // Pass `revision` only while writable so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(savedSource), revision: editable ? snapshot.revision : undefined,
    reload: async () => { await form?.reload?.() },
    save: async (value, revision, base) => {
      const ops: DeploymentOp[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form) throw new Error(t('deploymentRefused'))
      const result = await form.mutate(ops, revision)
      if (!result) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: typeof result === 'object' ? result.revision : revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  const readOnlyHint = !form ? t('deploymentNoForms')
    : snapshot?.status === 'loading' ? t('loading')
    : snapshot?.status === 'unavailable' ? (snapshot.error ?? t('deploymentUnavailable'))
    : !editable ? (snapshot?.error ?? t('deploymentReadOnly')) : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  const { instanceId, listen, paseoEndpoint } = snapshot?.value ?? {}
  const bindHost = listen?.host.includes(':') ? `[${listen.host}]` : listen?.host
  const stateDir = snapshot?.status === 'ready' && snapshot.value.stateDir ? snapshot.value.stateDir : setup.machine.stateDir
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Hint>{t('deploymentIntro')}</Hint>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      <Section title={t('deploymentMachine')}>
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        {(instanceId !== undefined || listen || paseoEndpoint) && <KeyValues rows={[
          [t('deploymentInstance'), <span className="dt-mono">{instanceId ?? '—'}</span>],
          [t('deploymentListen'), <span className="dt-mono">{listen ? `${bindHost}:${listen.port}` : '—'}</span>],
          [t('deploymentPaseoEndpoint'), <span className="dt-mono">{paseoEndpoint ?? '—'}</span>],
        ]} />}
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{stateDir}</span>
        </div>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

function DeploymentBody({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
function HttpDeploymentBody() {
  const { call } = usePanel()
  return <DeploymentBody form={useHttpDeploymentForm(call, 10_000)} />
}
/** Standalone Deployment page including derived repository and account facts. */
export function StandaloneDeployment({ t, form = 'http' }: { t: T; form?: DeploymentForm | 'http' }) {
  return <PanelProvider t={t} interval={10_000}>
    {form === 'http' ? <HttpDeploymentBody /> : <DeploymentBody form={form} />}
  </PanelProvider>
}
