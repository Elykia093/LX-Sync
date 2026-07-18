import { loadConfig } from './config.js'
import { createDatabase, migrateToLatest } from './db/connection.js'
import { Repository } from './db/repository.js'
import { buildApp } from './http/app.js'
import { LxAuthService } from './sync/auth.js'
import {
  ConnectionRegistry,
  createLxGateway,
  type LxGateway,
} from './sync/gateway.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const database = createDatabase(config.DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  let gateway: LxGateway | undefined
  let sessionCleanup: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined

  const shutdown = (signal: string): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      app?.log.info({ signal }, 'Shutting down')
      if (sessionCleanup) clearInterval(sessionCleanup)

      const errors: unknown[] = []
      for (const closeResource of [
        () => gateway?.close(),
        () => app?.close(),
        () => database.destroy(),
      ]) {
        try {
          await closeResource()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, 'Server shutdown failed')
    })()
    return closing
  }

  try {
    await migrateToLatest(database)

    const repository = new Repository(database, config.MASTER_KEY)
    await repository.deleteExpiredSessions()
    const serverId = await repository.ensureServiceMetadata()
    const auth = new LxAuthService(repository, config.SERVER_NAME)
    const registry = new ConnectionRegistry()
    app = await buildApp({
      config,
      repository,
      auth,
      registry,
      serverId,
      startedAt: new Date(),
    })
    gateway = createLxGateway({
      server: app.server,
      repository,
      auth,
      registry,
      logger: app.log,
      trustProxy: config.TRUST_PROXY,
    })

    sessionCleanup = setInterval(() => {
      void repository.deleteExpiredSessions().catch((error: unknown) => {
        app?.log.error({ err: error }, 'Expired session cleanup failed')
      })
    }, 60 * 60_000)
    sessionCleanup.unref()

    process.once('SIGINT', () => {
      void shutdown('SIGINT').catch((error: unknown) => {
        app?.log.error({ err: error }, 'Shutdown failed')
        process.exitCode = 1
      })
    })
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM').catch((error: unknown) => {
        app?.log.error({ err: error }, 'Shutdown failed')
        process.exitCode = 1
      })
    })

    await app.listen({ host: config.HOST, port: config.PORT })
  } catch (error) {
    await shutdown('startup-failure').catch((shutdownError: unknown) => {
      console.error(
        shutdownError instanceof Error
          ? shutdownError.message
          : 'Startup cleanup failed',
      )
    })
    throw error
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Server startup failed',
  )
  process.exitCode = 1
})
