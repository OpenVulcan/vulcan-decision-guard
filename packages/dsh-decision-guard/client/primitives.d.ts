/** Ambient types of dsh's UI primitives module; see dsh-client.ts for the source references. */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

  export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

  export function Tag(props: { tone?: TagTone; className?: string | undefined; children?: ReactNode }): ReactNode

  export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    /** The primitive forwards it to the native button. */
    ref?: Ref<HTMLButtonElement>
  }): ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  /** The copy the settings form frame renders. */
  export interface SettingsFormLabels {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }

  /** Availability, writability and what a save would do. */
  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  /** One plugin's settings form frame on the Plugins page: notices, controls, and the save. */
  export function SettingsForm(props: {
    labels: SettingsFormLabels
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children: ReactNode
  }): ReactNode
}
