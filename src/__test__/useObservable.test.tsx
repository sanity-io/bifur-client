// @vitest-environment jsdom
import {act, cleanup, render} from '@testing-library/react'
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {useObservable} from 'react-rx'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {fromUrl} from '../index'
import {MockWebSocket} from './mockWebSocket'

const SOCKET_URL = 'wss://example.api.sanity.io/v2022-06-30/socket/test'
const GRACEFUL_CLOSE = {
  code: 1000,
  reason: 'WebSockets connection closed by client',
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const createHeartbeatComponent = (client: ReturnType<typeof fromUrl>) => {
  return function HeartbeatComponent() {
    useObservable(client.heartbeats, null)
    return null
  }
}

/**
 * Integration tests against react-rx's `useObservable` — the consumer that
 * exposed the original bug. Every cold mount subscribes during render,
 * unsubscribes a microtask later, and only resubscribes from a passive
 * effect. That gap used to close the socket mid-handshake.
 */
describe('fromUrl with react-rx useObservable', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    sockets = []
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a cold mount on real (non-act) timing opens exactly one socket that is never closed', async () => {
    const client = fromUrl(SOCKET_URL)
    const HeartbeatComponent = createHeartbeatComponent(client)

    // Render without `act`: it flushes effects early, hiding the
    // zero-subscriber gap this test is about.
    const globalWithActFlag = globalThis as {
      IS_REACT_ACT_ENVIRONMENT?: boolean
    }
    const previousActFlag = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT
    globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = false
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      root.render(
        <StrictMode>
          <HeartbeatComponent />
        </StrictMode>,
      )
      await sleep(50)

      // one socket despite the warm-up churn — no aborted handshake
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.closeCalls).toHaveLength(0)

      sockets[0]!.finishHandshake()
      await sleep(50)

      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.closeCalls).toHaveLength(0)

      // Fake timers from here so the wall-clock disconnect grace can be
      // advanced instead of waited out (`shouldAdvanceTime` keeps React's
      // real-time scheduling flowing underneath).
      vi.useFakeTimers({shouldAdvanceTime: true})
      root.unmount()
      await vi.advanceTimersByTimeAsync(1_000)

      // ...unmounting doesn't close it until the disconnect grace elapses...
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.closeCalls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(5_000)

      // ...and then it closes gracefully
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.closeCalls).toEqual([
        {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
      ])
    } finally {
      globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previousActFlag
      container.remove()
    }
  })

  it('strict mode double-mounting opens exactly one socket and keeps it open', async () => {
    const client = fromUrl(SOCKET_URL)
    const HeartbeatComponent = createHeartbeatComponent(client)

    render(<HeartbeatComponent />, {reactStrictMode: true})

    // flush react-rx's warm-up store reset (scheduled on the asap scheduler)
    await Promise.resolve()

    expect(sockets).toHaveLength(1)
    act(() => sockets[0]!.finishHandshake())

    // the mounted component keeps the socket open across later tasks
    await sleep(50)
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toHaveLength(0)
  })

  it('unmounting mid-handshake never closes the CONNECTING socket', async () => {
    const client = fromUrl(SOCKET_URL)
    const HeartbeatComponent = createHeartbeatComponent(client)

    const {unmount} = render(<HeartbeatComponent />, {reactStrictMode: true})
    expect(sockets[0]!.readyState).toBe(sockets[0]!.CONNECTING)

    // Fake timers so the wall-clock disconnect grace can be advanced past
    vi.useFakeTimers({shouldAdvanceTime: true})
    unmount()
    // teardown runs while the handshake is still in flight — no close allowed
    await vi.advanceTimersByTimeAsync(6_000)
    expect(sockets[0]!.closeCalls).toHaveLength(0)

    // handshake settles → the deferred close runs against the OPEN socket
    sockets[0]!.finishHandshake()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toEqual([
      {...GRACEFUL_CLOSE, readyStateAtCall: sockets[0]!.OPEN},
    ])
  })

  it('a quick unmount/remount cycle reuses the socket instead of reconnecting', async () => {
    const client = fromUrl(SOCKET_URL)
    const HeartbeatComponent = createHeartbeatComponent(client)

    const first = render(<HeartbeatComponent />, {reactStrictMode: true})
    act(() => sockets[0]!.finishHandshake())

    first.unmount()
    // let react-rx's store reset drop the last subscriber before remounting
    await Promise.resolve()

    render(<HeartbeatComponent />, {reactStrictMode: true})
    await sleep(50)

    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closeCalls).toHaveLength(0)
  })
})
