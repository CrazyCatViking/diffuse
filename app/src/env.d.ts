/// <reference types="vite/client" />

import type { DiffuseApi } from './lib/coreClient'

declare global {
  interface Window {
    diffuse: DiffuseApi
  }
}
