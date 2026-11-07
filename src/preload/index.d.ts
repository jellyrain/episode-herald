import type { HongguoAPI } from '../shared/types'

declare global {
  interface Window {
    hongguo: HongguoAPI
  }
}
