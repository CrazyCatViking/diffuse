export type VersionInfo = {
  name: string
  version: string
}

export type OpenRepositoryResult = {
  root: string
  head: string
}

export type ChangedFile = {
  id: string
  oldPath: string | null
  newPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

export type DiffRenderModel = {
  fileId: string
  mode: 'split'
  rows: DiffRow[]
}

export type DiffRow = {
  kind: 'context' | 'added' | 'deleted' | 'hunk'
  oldLine?: number
  newLine?: number
  oldText?: string
  newText?: string
  text?: string
  hunkHeader?: string
}
