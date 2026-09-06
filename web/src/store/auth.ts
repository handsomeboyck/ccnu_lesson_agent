import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TokenPair, User } from '../types'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  setAuth: (pair: TokenPair) => void
  setUser: (u: User | null) => void
  clear: () => void
}

// 会话级认证状态：token 与用户信息持久化到 localStorage。
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setAuth: (pair) =>
        set({ user: pair.user, accessToken: pair.access_token, refreshToken: pair.refresh_token }),
      setUser: (user) => set({ user }),
      clear: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    { name: 'ccnu-auth' },
  ),
)
