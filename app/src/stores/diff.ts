import { defineStore } from 'pinia'
import { coreClient } from '../lib/coreClient'
import type { DiffRenderModel } from '../lib/protocol'

export const useDiffStore = defineStore('diff', {
  state: () => ({
    current: null as DiffRenderModel | null,
    loading: false,
    error: null as string | null
  }),

  actions: {
    async loadDiff(fileId: string) {
      this.loading = true
      this.error = null
      try {
        this.current = await coreClient.getDiffRenderModel(fileId, { mode: 'split' })
      } catch (error) {
        this.current = null
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    clear() {
      this.current = null
      this.error = null
    }
  }
})
