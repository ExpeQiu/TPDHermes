import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Toast type
export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: string
  type: ToastType
  message: string
}

interface UserState {
  username: string
  avatar: string
  isLoggedIn: boolean
  setUser: (username: string, avatar: string) => void
  logout: () => void
}

interface GlobalState {
  globalLoading: boolean
  setGlobalLoading: (loading: boolean) => void
}

interface ToastState {
  toasts: ToastItem[]
  addToast: (type: ToastType, message: string) => void
  removeToast: (id: string) => void
}

interface ThemeState {
  theme: 'dark' | 'light'
  toggleTheme: () => void
  setTheme: (theme: 'dark' | 'light') => void
}

// User Store
export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      username: '',
      avatar: '',
      isLoggedIn: false,
      setUser: (username, avatar) => set({ username, avatar, isLoggedIn: true }),
      logout: () => set({ username: '', avatar: '', isLoggedIn: false }),
    }),
    { name: 'tphermes-user' }
  )
)

// Global Loading Store
export const useGlobalStore = create<GlobalState>((set) => ({
  globalLoading: false,
  setGlobalLoading: (loading) => set({ globalLoading: loading }),
}))

// Toast Store
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, message) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`
    set((state) => ({ toasts: [...state.toasts, { id, type, message }] }))
    // auto remove after 3s
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, 3000)
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

// Theme Store
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      toggleTheme: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark'
        set({ theme: next })
        if (typeof document !== 'undefined') {
          document.documentElement.classList.toggle('dark', next === 'dark')
          document.documentElement.setAttribute('data-theme', next)
        }
      },
      setTheme: (theme) => {
        set({ theme })
        if (typeof document !== 'undefined') {
          document.documentElement.classList.toggle('dark', theme === 'dark')
          document.documentElement.setAttribute('data-theme', theme)
        }
      },
    }),
    { name: 'tphermes-theme' }
  )
)
