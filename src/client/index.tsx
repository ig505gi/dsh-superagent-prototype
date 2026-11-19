/** Standalone browser React entry point mounting the Superagent management panel. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { openSessionLink, SessionNavigationError } from '../navigation.ts'
import { ApiError, caller } from './api.ts'
import { App } from './app.tsx'
import { useHttpDeploymentForm, type DeploymentForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import { apiMessages } from './provider.tsx'
import { createTranslator } from './text.ts'

export type Language = 'zh' | 'en'
export type Theme = 'system' | 'light' | 'dark'
const LANG_KEY = 'dsh-superagent/lang'
const THEME_KEY = 'dsh-superagent/theme'
const THEMES: readonly Theme[] = ['system', 'light', 'dark']

function readStorage<V extends string>(key: string, allowed: readonly V[], fallback: V): V {
  try {
    const value = localStorage.getItem(key)
    return allowed.find(item => item === value) ?? fallback
  } catch {
    return fallback
  }
}
function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* Preference persistence is optional. */ }
}

function defaultOpenUrl(url: string): void {
  window.location.assign(url)
}

export interface StandaloneAppProps {
  initialLang?: Language
  initialTheme?: Theme
  openUrl?: (url: string) => void
  deploymentForm?: DeploymentForm
}

/** Root standalone Superagent application owning locale, color theme, deployment polling, and Paseo link navigation. */
export function StandaloneApp({ initialLang, initialTheme, openUrl = defaultOpenUrl, deploymentForm }: StandaloneAppProps) {
  const [lang, setLang] = useState<Language>(() => initialLang ?? readStorage(LANG_KEY, ['zh', 'en'], 'zh'))
  const [theme, setTheme] = useState<Theme>(() => initialTheme ?? readStorage(THEME_KEY, THEMES, 'system'))

  const t = useMemo(() => createTranslator(lang === 'en' ? en : zh), [lang])
  const copy = useRef(t)
  copy.current = t
  const call = useMemo(() => caller(() => apiMessages(copy.current)), [])
  const httpDeploymentForm = useHttpDeploymentForm(call)

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  }, [lang])

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
    const sync = () => {
      if (theme === 'system') delete root.dataset.theme
      else root.dataset.theme = theme
      const dark = theme === 'dark' || (theme === 'system' && !!media?.matches)
      if (dark) body.dataset.dsDarkTheme = ''
      else delete body.dataset.dsDarkTheme
    }
    sync()
    if (theme !== 'system' || !media) return
    media.addEventListener?.('change', sync)
    return () => { media.removeEventListener?.('change', sync) }
  }, [theme])

  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    try {
      await openSessionLink((target, signal) => call('GET sessions/:id/link', { id: target, signal }), id, openUrl, request.signal)
    } catch (error) {
      if (request.signal.aborted) return
      if (error instanceof SessionNavigationError) {
        throw new Error(copy.current(error.code === 'invalid-link' ? 'sessionInvalidLink' : 'sessionNotListed'))
      }
      if (error instanceof ApiError && error.missing) {
        throw new Error(copy.current('sessionNotListed'))
      }
      throw error
    }
  }, [call, openUrl])

  const toggleLang = useCallback(() => {
    setLang(current => {
      const next = current === 'zh' ? 'en' : 'zh'
      writeStorage(LANG_KEY, next)
      return next
    })
  }, [])

  const cycleTheme = useCallback(() => {
    setTheme(current => {
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!
      writeStorage(THEME_KEY, next)
      return next
    })
  }, [])

  return <App t={t} openSession={openSession} deploymentForm={deploymentForm ?? httpDeploymentForm}
    lang={lang} onToggleLang={toggleLang} theme={theme} onCycleTheme={cycleTheme} />
}

/** Mount the standalone Superagent panel into `container`. */
export function mountStandalone(container: HTMLElement, props: StandaloneAppProps = {}) {
  const root = createRoot(container)
  root.render(<StandaloneApp {...props} />)
  return { unmount: () => root.unmount() }
}

function boot() {
  const target = typeof document !== 'undefined' ? document.getElementById('root') : null
  if (target) mountStandalone(target)
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
}
