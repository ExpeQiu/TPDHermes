'use client'

import { Component, type ReactNode } from 'react'
import { accentRedSoft } from '@/lib/theme-text'

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white p-8">
          <div className="max-w-lg text-center">
            <div className="text-6xl mb-6">💥</div>
            <h1 className={`text-2xl font-bold mb-4 ${accentRedSoft}`}>页面出错了</h1>
            <p className="text-slate-600 dark:text-slate-400 mb-2 text-sm">
              抱歉，页面遇到了意外错误，请刷新重试。
            </p>
            {this.state.error && (
              <details className="mt-4 text-left">
                <summary className="text-slate-500 cursor-pointer text-xs mb-1">
                  错误详情
                </summary>
                <pre className={`text-xs ${accentRedSoft} opacity-80 bg-slate-100 dark:bg-slate-900 p-3 rounded-lg overflow-auto max-h-40`}>
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              className="mt-6 px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition text-sm"
            >
              🔄 刷新页面
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
