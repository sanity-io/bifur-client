import {useObservable} from './utils/useObservable'
import React from 'react'
import {map, share} from 'rxjs/operators'
import {Observable, timer} from 'rxjs'
import formatDistanceToNowStrict from 'date-fns/formatDistanceToNowStrict'
import {
  ConnectedState,
  CONNECTING,
  connectionStatus$,
  ErrorState,
} from './ds/connectionStatus'

const clock$: Observable<Date> = timer(0, 1000).pipe(
  map(() => new Date()),
  share(),
)

const useNow = () => useObservable(clock$, new Date())

function RelativeTime({
  date,
  options,
}: {
  date: Date
  options?: {
    unit?: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year'
    roundingMethod?: 'floor' | 'ceil' | 'round'
    addSuffix?: boolean
  }
}) {
  useNow()
  return <>{formatDistanceToNowStrict(date, options)}</>
}

export function ConnectionStatus() {
  const connectionState = useObservable(connectionStatus$, CONNECTING)

  return (
    <div style={{padding: 10}}>
      {connectionState.type === 'connecting' && <>Connecting…</>}
      {connectionState.type === 'error' && (
        <ConnectionError errorStatus={connectionState} />
      )}
      {connectionState.type === 'connected' && (
        <ConnectedStatus status={connectionState} />
      )}
    </div>
  )
}

const HEARTBEAT_DELAY_SAFE = 10
const HEARTBEAT_DELAY_SUSPICIOUS = 20

function ConnectedStatus({status}: {status: ConnectedState}) {
  const now = useNow()
  const distance = (now.getTime() - status.lastHeartbeat.getTime()) / 1000

  const symbol =
    distance < HEARTBEAT_DELAY_SAFE
      ? '💚'
      : distance < HEARTBEAT_DELAY_SUSPICIOUS
      ? '💛'
      : '💔'

  return (
    <>
      Sanity Studio is connected ({symbol} Last heartbeat{' '}
      <RelativeTime
        date={status.lastHeartbeat}
        options={{roundingMethod: 'floor', unit: 'second'}}
      />{' '}
      ago)
    </>
  )
}

function ConnectionError({errorStatus}: {errorStatus: ErrorState}) {
  if (errorStatus.offline) {
    return navigator.onLine ? (
      <>Connecting…</>
    ) : (
      <>
        No internet connection detected. Sanity Studio will automatically
        reconnect when it detects an internet connection.
      </>
    )
  }

  const now = useNow()

  const secondsUntilRetry = Math.floor(
    (errorStatus.retryAt.getTime() - now.getTime()) / 1000,
  )
  const isRetrying = secondsUntilRetry < 1
  return (
    <div style={{display: 'flex', flexDirection: 'column'}}>
      <div>
        Sanity Studio failed to establish server connection. (
        {errorStatus.error.message})
      </div>
      <div>
        Trying to reconnect
        {errorStatus.attemptNo < 5 || isRetrying ? (
          '…'
        ) : (
          <>
            {' '}
            in <RelativeTime date={errorStatus.retryAt} />{' '}
          </>
        )}
      </div>
      <div>
        {errorStatus.attemptNo > 4 && (
          <button
            disabled={isRetrying}
            type="button"
            onClick={errorStatus.retry}
          >
            Reconnect now
          </button>
        )}
      </div>
    </div>
  )
}
