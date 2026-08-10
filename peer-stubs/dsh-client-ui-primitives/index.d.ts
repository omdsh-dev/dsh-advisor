/**
 * Dev-time type-only shim for `@deepseek-ai/dsh-client-ui-primitives` — the
 * token-styled UI atoms consumed by the dsh-advisor client half.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * b8343cb (2026-08-09 snapshot): the `Button` atom (with `ButtonVariant`), the
 * `Modal` dialog, and the `IconPlusOutline16` icon — the primitives the
 * advisor settings form (task 3) renders. TYPE-ONLY for the task-2 skeleton:
 * the skeleton renders no primitives, so no value crosses the bundle boundary
 * yet; when a value import appears (task 3), this stub gains a minimal runtime
 * stand-in (main/types → index.ts) under the same consumed surface.
 *
 * @module @deepseek-ai/dsh-client-ui-primitives
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Visual variant, each backed by its --dsw-alias-button-* token family. */
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

/** Render a button; native button attributes pass through. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual family (default 'ghost'). */
  variant?: ButtonVariant
  /** 'md' 36px capsule or 'sm' 28px compact. */
  size?: 'md' | 'sm'
  /** Optional leading 16px icon node. */
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
}

/** The Button atom (type-only in this stub). */
export const Button: (props: ButtonProps) => ReactNode

/** Modal dialog props (minimal consumed face). */
export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  closeLabel?: string
  className?: string | undefined
  footer?: ReactNode
  children?: ReactNode
}

/** The Modal dialog (type-only in this stub). */
export const Modal: (props: ModalProps) => ReactNode

/** 16px plus icon glyph (type-only in this stub). */
export interface IconPlusOutline16Props {
  size?: number
  className?: string | undefined
}

/** The IconPlusOutline16 glyph (type-only in this stub). */
export const IconPlusOutline16: (props: IconPlusOutline16Props) => ReactNode
