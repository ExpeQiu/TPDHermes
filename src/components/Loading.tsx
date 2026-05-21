'use client'

import { useGlobalStore } from '@/lib/store'

// Global loading overlay
export function GlobalLoadingOverlay() {
  const globalLoading = useGlobalStore((s) => s.globalLoading)
  if (!globalLoading) return null

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 border-4 border-blue-500/30 rounded-full" />
          <div className="absolute inset-0 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
        <p className="text-white/80 text-sm">加载中...</p>
      </div>
    </div>
  )
}

// Skeleton shimmer component
interface SkeletonProps {
  className?: string
  lines?: number
}

export function Skeleton({ className = '', lines = 1 }: SkeletonProps) {
  if (lines > 1) {
    return (
      <div className={`space-y-2 ${className}`}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="h-4 bg-slate-300 dark:bg-slate-700/50 rounded animate-pulse"
            style={{ width: i === lines - 1 ? '70%' : '100%' }}
          />
        ))}
      </div>
    )
  }
  return <div className={`h-4 w-full bg-slate-300 dark:bg-slate-700/50 rounded animate-pulse ${className}`} />
}

// Card skeleton
export function CardSkeleton() {
  return (
    <div className="bg-slate-200/60 dark:bg-slate-800/60 rounded-xl p-5 border border-slate-300 dark:border-slate-700/50 space-y-3">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton lines={3} />
      <div className="flex gap-2 pt-1">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
      </div>
    </div>
  )
}

// Page skeleton
export function PageSkeleton() {
  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CardSkeleton />
        <CardSkeleton />
      </div>
      <CardSkeleton />
    </div>
  )
}
