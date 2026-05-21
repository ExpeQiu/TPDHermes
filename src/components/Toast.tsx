'use client'

import { useToastStore, ToastType } from '@/lib/store'
import { useEffect, useState } from 'react'

const icons: Record<ToastType, string> = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
}

const borderColors: Record<ToastType, string> = {
  success: 'border-emerald-500',
  error: 'border-red-500',
  warning: 'border-amber-500',
  info: 'border-blue-500',
}

const bgColors: Record<ToastType, string> = {
  success: 'bg-emerald-950/90',
  error: 'bg-red-950/90',
  warning: 'bg-amber-950/90',
  info: 'bg-blue-950/90',
}

interface ToastProps {
  id: string
  type: ToastType
  message: string
}

function ToastItem({ id, type, message }: ToastProps) {
  const removeToast = useToastStore((s) => s.removeToast)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // trigger enter animation
    requestAnimationFrame(() => setVisible(true))
  }, [])

  return (
    <div
      className={`
        flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-sm shadow-lg
        min-w-[280px] max-w-sm
        transition-all duration-300 ease-out
        ${bgColors[type]} ${borderColors[type]}
        ${visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'}
      `}
    >
      <span className="text-xl flex-shrink-0">{icons[type]}</span>
      <p className="text-sm text-slate-900 dark:text-white flex-1">{message}</p>
      <button
        onClick={() => removeToast(id)}
        className="text-white/60 hover:text-slate-900 dark:hover:text-white transition-colors text-lg leading-none flex-shrink-0"
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem {...toast} />
        </div>
      ))}
    </div>
  )
}

// Convenience helpers (call these from anywhere)
export function toast(type: ToastType, message: string) {
  useToastStore.getState().addToast(type, message)
}
