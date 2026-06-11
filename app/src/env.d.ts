/// <reference types="vite/client" />

import type { DiffuseBridge } from '../electron/preload'

declare global {
  interface Window {
    diffuse: DiffuseBridge
  }
}
