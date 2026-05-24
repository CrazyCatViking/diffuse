import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CoreRpcClient } from './coreRpcClient'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function startCoreProcess(): CoreRpcClient {
  const executable = resolveCoreExecutable()
  const child = spawn(executable, ['rpc'], {
    stdio: 'pipe',
    windowsHide: true
  })

  return new CoreRpcClient(child)
}

function resolveCoreExecutable(): string {
  const devCandidates = [
    resolve(__dirname, '../../../core/zig-out/bin/diffuse'),
    resolve(process.cwd(), '../core/zig-out/bin/diffuse')
  ]

  for (const candidate of devCandidates) {
    if (existsSync(candidate)) return candidate
  }

  const packagedPath = join(process.resourcesPath, 'diffuse')
  if (existsSync(packagedPath)) return packagedPath

  return devCandidates[0]
}
