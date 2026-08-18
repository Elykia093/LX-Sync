import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runImportCli } from './lxserver-v2-import.js'

const mainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (mainModule)
  runImportCli('lx-music-sync-server-v2').catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownError'
    console.error(`LX-Sync import failed: ${name}`)
    process.exitCode = 1
  })
