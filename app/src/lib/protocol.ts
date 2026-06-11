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

export type DiffViewMode = 'split' | 'inline'

export type DiffContextMode = 'diff' | 'full'

export type DiffRenderOptions = {
  mode: DiffViewMode
  context: DiffContextMode
}

export type DiffRenderModel = {
  fileId: string
  mode: DiffViewMode
  context: DiffContextMode
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
