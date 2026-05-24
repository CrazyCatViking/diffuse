import { defineStore } from 'pinia'
import { coreClient } from '../lib/coreClient'
import type { ChangedFile, OpenRepositoryResult, VersionInfo } from '../lib/protocol'

export const useRepoStore = defineStore('repo', {
  state: () => ({
    version: null as VersionInfo | null,
    repository: null as OpenRepositoryResult | null,
    changedFiles: [] as ChangedFile[],
    activeFileId: null as string | null,
    loading: false,
    error: null as string | null
  }),

  getters: {
    activeFile(state): ChangedFile | null {
      return state.changedFiles.find((file) => file.id === state.activeFileId) ?? null
    }
  },

  actions: {
    async loadVersion() {
      this.version = await coreClient.getVersion()
    },

    async pickAndOpenRepository() {
      const path = await coreClient.pickRepository()
      if (!path) return
      await this.openRepository(path)
    },

    async openRepository(path: string) {
      this.loading = true
      this.error = null
      try {
        this.repository = await coreClient.openRepository(path)
        this.changedFiles = await coreClient.listChangedFiles()
        this.activeFileId = this.changedFiles[0]?.id ?? null
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    selectFile(fileId: string) {
      this.activeFileId = fileId
    }
  }
})
