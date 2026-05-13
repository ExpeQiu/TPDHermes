'use client'

import { useEffect } from 'react'
import { useThemeStore } from '@/lib/store'

export function ThemeInit() {
  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return null
}
