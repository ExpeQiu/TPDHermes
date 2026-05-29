'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useIsDefaultAdmin } from '@/lib/admin-access'
import { useThemeStore, useUserStore } from '@/lib/store'

const navLinks = [
  { href: '/', label: '首页', emoji: '🏠' },
  { href: '/projects', label: '项目中心', emoji: '📁' },
  { href: '/create', label: '场景编排', emoji: '⚡', adminOnly: true },
  { href: '/chat', label: '编排协作', emoji: '💬' },
  { href: '/workshop', label: '结果工坊', emoji: '🛠️' },
  { href: '/knowledge', label: '知识库', emoji: '📚', adminOnly: true },
  { href: '/skills', label: '技能工坊', emoji: '📦' },
]

export function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggleTheme)
  const user = useUserStore((s) => ({ username: s.username, isLoggedIn: s.isLoggedIn }))
  const { isAdmin } = useIsDefaultAdmin()
  const [mobileOpen, setMobileOpen] = useState(false)
  const visibleNavLinks = navLinks.filter((link) => !link.adminOnly || isAdmin)

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      {/* Sidebar - desktop */}
      <aside className="hidden md:flex flex-col w-56 bg-slate-900 dark:bg-slate-950 border-r border-slate-800 dark:border-slate-800 fixed top-0 left-0 h-full z-30">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-slate-800">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
            TH
          </div>
          <div>
            <p className="text-white text-sm font-semibold leading-tight">TPDHermes</p>
            <p className="text-slate-500 text-xs leading-tight">技术推广平台</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
          {visibleNavLinks.map((link) => {
            const active = pathname === link.href
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`
                  flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors
                  ${active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }
                `}
              >
                <span className="text-base">{link.emoji}</span>
                <span>{link.label}</span>
              </Link>
            )
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-slate-800 px-4 py-4">
          <button
            onClick={toggleTheme}
            className="flex items-center gap-2 text-slate-500 hover:text-white text-xs transition-colors w-full"
          >
            <span>{theme === 'dark' ? '🌙' : '☀️'}</span>
            <span>{theme === 'dark' ? '深色模式' : '浅色模式'}</span>
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={`
          fixed top-0 left-0 h-full w-56 bg-slate-900 border-r border-slate-800 z-40
          transition-transform duration-300 ease-in-out
          md:hidden
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-slate-800">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            TH
          </div>
          <div>
            <p className="text-white text-sm font-semibold leading-tight">TPDHermes</p>
            <p className="text-slate-500 text-xs leading-tight">技术推广平台</p>
          </div>
        </div>
        <nav className="flex-1 py-3 px-3 space-y-0.5">
          {visibleNavLinks.map((link) => {
            const active = pathname === link.href
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`
                  flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors
                  ${active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }
                `}
              >
                <span className="text-base">{link.emoji}</span>
                <span>{link.label}</span>
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Main content area */}
      <div className="flex-1 md:ml-56 flex flex-col min-h-screen">
        {/* Top navbar */}
        <header className="sticky top-0 z-20 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-4">
          {/* Hamburger */}
          <button
            className="md:hidden text-slate-600 dark:text-slate-300 hover:text-blue-600 transition-colors text-2xl leading-none"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="菜单"
          >
            {mobileOpen ? '×' : '☰'}
          </button>

          {/* Mobile logo */}
          <div className="md:hidden flex items-center gap-2">
            <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-xs">
              TH
            </div>
            <span className="text-sm font-semibold">TPDHermes</span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* User info */}
          {user.isLoggedIn ? (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-medium">
                {user.username?.[0]?.toUpperCase() ?? 'U'}
              </div>
              <span className="text-sm text-slate-600 dark:text-slate-300 hidden sm:block">
                {user.username}
              </span>
            </div>
          ) : (
            <span className="text-xs text-slate-400 hidden sm:block">未登录</span>
          )}

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            aria-label="切换主题"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}
