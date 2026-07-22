import { createMsg2call } from 'message2call'
import message2callPackage from 'message2call/package.json' with {
  type: 'json',
}
import { describe, expect, it, vi } from 'vitest'
import { LX_SYNC } from '../protocol/index.js'

interface RawRemote {
  getEnabledFeatures: (
    serverType: 'server',
    features: typeof LX_SYNC.featureVersion,
  ) => Promise<{ list: { skipSnapshot: boolean } }>
}

describe('message2call 0.1.3 wire compatibility', () => {
  it('produces and consumes the original raw call and response frames', async () => {
    expect(message2callPackage.version).toBe('0.1.3')
    const outbound: Array<Record<string, unknown>> = []
    const featureChanges: unknown[] = []
    const rpc = createMsg2call<RawRemote>({
      funcsObj: {
        onFeatureChanged: (feature: unknown) => {
          featureChanges.push(feature)
        },
      },
      sendMessage: (frame) => outbound.push(structuredClone(frame)),
      timeout: 1_000,
    })

    try {
      const result = rpc.remote.getEnabledFeatures(
        'server',
        LX_SYNC.featureVersion,
      )
      const request = outbound.shift()
      expect(request).toEqual({
        name: expect.stringMatching(/^getEnabledFeatures__\d+$/),
        path: ['getEnabledFeatures'],
        data: ['server', { list: 1, dislike: 1 }],
      })
      const requestName = request?.name
      if (typeof requestName !== 'string') throw new Error('Missing call id')

      rpc.message(
        JSON.parse(
          `{"name":${JSON.stringify(requestName)},"error":null,"data":{"list":{"skipSnapshot":false}}}`,
        ) as Record<string, unknown>,
      )
      await expect(result).resolves.toEqual({ list: { skipSnapshot: false } })

      rpc.message(
        JSON.parse(
          '{"name":"client-call-1","path":["onFeatureChanged"],"data":[{"list":false}]}',
        ) as Record<string, unknown>,
      )
      await vi.waitFor(() => expect(featureChanges).toEqual([{ list: false }]))
      await vi.waitFor(() => expect(outbound).toHaveLength(1))
      expect(outbound[0]).toEqual({ name: 'client-call-1', error: null })
    } finally {
      rpc.destroy()
    }
  })
})
