/** Small Vulcan-style building blocks; the look lives in `style.ts`. */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { fill, type Key, type Translate } from './i18n'
import { messageOf, saveSettings, type Change, type GuardSettings, type HostWatch } from './shared'
import type { ConfigForm } from './dsh-client'

export function Section({ title, lead, actions, flush, children }: {
  title: string
  lead?: string | undefined
  actions?: ReactNode
  /** The body touches the frame, for tables and rows. */
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section className="vdg-section">
      <div className="vdg-section-head">
        <div>
          <h3 className="vdg-section-title">{title}</h3>
          {lead === undefined ? null : <p className="vdg-section-lead">{lead}</p>}
        </div>
        {actions === undefined ? null : <div className="vdg-inline">{actions}</div>}
      </div>
      <div className={flush === true ? 'vdg-section-body flush' : 'vdg-section-body'}>{children}</div>
    </section>
  )
}

/** Radio cards: one choice of a few, each with a short explanation. */
export function Choices<V extends string>({ label, value, options, disabled, onChoose }: {
  label: string
  value: V | undefined
  options: readonly { readonly value: V; readonly title: string; readonly hint?: string }[]
  disabled: boolean
  onChoose: (value: V) => void
}) {
  return (
    <div className="vdg-choices" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="vdg-choice"
          aria-checked={value === option.value}
          aria-disabled={disabled}
          onClick={() => { if (!disabled && value !== option.value) onChoose(option.value) }}
        >
          <span className="vdg-choice-mark" />
          <span>
            <span className="vdg-choice-title">{option.title}</span>
            {option.hint === undefined ? null : <span className="vdg-choice-hint">{option.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** A compact one-of-few switch. */
export function Segments<V extends string>({ label, value, options, disabled, onChoose }: {
  label: string
  value: V | undefined
  options: readonly { readonly value: V; readonly title: string }[]
  disabled: boolean
  onChoose: (value: V) => void
}) {
  return (
    <div className="vdg-segments" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className="vdg-segment"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => { if (value !== option.value) onChoose(option.value) }}
        >
          {option.title}
        </button>
      ))}
    </div>
  )
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'outline'

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`vdg-badge ${tone}`}>{children}</span>
}

export function ErrorLine({ text }: { text: string | undefined }) {
  return text === undefined ? null : <p className="vdg-error" role="alert">{text}</p>
}

export function useWatch<T>(watch: HostWatch<T>): T | undefined {
  return useSyncExternalStore(watch.subscribe, watch.getSnapshot)
}

/** Re-read `watch` now and every `ms` while mounted. */
export function usePolling(watch: HostWatch<unknown>, ms: number | undefined): void {
  useEffect(() => {
    watch.refresh()
    if (ms === undefined) return undefined
    const timer = setInterval(() => { watch.refresh() }, ms)
    return () => { clearInterval(timer) }
  }, [watch, ms])
}

/** Run actions one at a time, keeping the last failure to show next to them. */
export function useAction(after?: () => void) {
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const act = (name: string, work: () => Promise<unknown>): void => {
    setBusy(name)
    setError(undefined)
    work().catch((failure: unknown) => {
      setError(messageOf(failure))
    }).finally(() => {
      setBusy(undefined)
      after?.()
    })
  }
  return { busy, error, act }
}

/** The plugin's accepted settings and an immediate save of single changes. */
export function useSettings(form: ConfigForm<GuardSettings>, t: Translate) {
  const snapshot = useSyncExternalStore(
    (listener: () => void) => form.subscribe(listener),
    () => form.getSnapshot(),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const save = async (changes: Change): Promise<boolean> => {
    setSaving(true)
    setError(undefined)
    try {
      const landed = await saveSettings(form, changes)
      if (!landed) setError(fill(t('saveFailed'), { error: t('readOnly') }))
      return landed
    } catch (failure) {
      setError(fill(t('saveFailed'), { error: messageOf(failure) }))
      return false
    } finally {
      setSaving(false)
    }
  }
  return {
    status: snapshot.status,
    value: snapshot.value,
    writable: snapshot.writable,
    disabled: !snapshot.writable || saving,
    saving,
    error,
    save: (changes: Change): void => { void save(changes) },
    saveAsync: save,
  }
}

/** A modal dialog over the page, closed by Escape, the scrim or its own controls. */
export function Dialog({ title, onClose, footer, children }: {
  title: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    // Capture, so the Settings dialog underneath does not close as well.
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true) }
  }, [onClose])
  return createPortal(
    <div className="vdg vdg-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="vdg-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="vdg-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="vdg-btn ghost sm" aria-label="×" onClick={onClose}>×</button>
        </div>
        <div className="vdg-dialog-body">{children}</div>
        <div className="vdg-dialog-foot">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

/** A card anchored above `anchor`, closed by Escape or a press outside both. */
export function Popover({ anchor, label, onClose, children }: {
  anchor: RefObject<HTMLElement | null>
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const place = (): void => {
      const target = anchor.current?.getBoundingClientRect()
      const own = panel.current?.getBoundingClientRect()
      if (target === undefined || own === undefined) return
      const margin = 12
      const left = Math.min(Math.max(margin, target.right - own.width), window.innerWidth - own.width - margin)
      const above = target.top - own.height - 8
      const top = above >= margin ? above : Math.min(target.bottom + 8, window.innerHeight - own.height - margin)
      setPosition({ left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    if (panel.current !== null) observer.observe(panel.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])
  useEffect(() => {
    const pointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null || panel.current?.contains(target) === true || anchor.current?.contains(target) === true) return
      // A press inside one of this plugin's dialogs opened from the card keeps it open.
      if (target instanceof Element && target.closest('.vdg-overlay') !== null) return
      onClose()
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && document.querySelector('.vdg-overlay') === null) onClose()
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', keydown)
    }
  }, [anchor, onClose])
  return createPortal(
    <div
      ref={panel}
      className="vdg vdg-popover"
      role="dialog"
      aria-label={label}
      style={position === undefined ? { left: -9999, top: -9999 } : { left: position.left, top: position.top }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Milliseconds as the tables show them. */
export function ms(t: Translate, value: number | undefined): string {
  return value === undefined ? '—' : fill(t('ms'), { value: Math.round(value) })
}

/** A short local date and time. */
export function when(at: number | string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(at))
}

export type { Key }
