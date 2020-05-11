import {useObservable} from './utils/useObservable'
import {client} from './client'
import React from 'react'
import {
  concatMap,
  map,
  mapTo,
  mergeMapTo,
  share,
  take,
  takeUntil,
} from 'rxjs/operators'
import {observableCallback} from 'observable-callback'
import {
  concat,
  EMPTY,
  fromEvent,
  merge,
  NEVER,
  Observable,
  of,
  throwError,
  timer,
} from 'rxjs'
import {catchWithCount} from './utils/catchWithCount'
import formatDistanceToNowStrict from 'date-fns/formatDistanceToNowStrict'

type ConnectingState = {
  type: 'connecting'
}
type ErrorState = {
  type: 'error'
  error: Error
  retry: (arg: any) => void
  attemptNo: number
  offline: boolean
  retryAt: Date
}

type RetryingState = {
  type: 'retrying'
}

type ConnectedState = {type: 'connected'; lastHeartbeat: Date}

type ConnectionStatusState =
  | ConnectingState
  | ErrorState
  | ConnectedState
  | RetryingState

const sleep = (ms: number) => timer(ms).pipe(mergeMapTo(EMPTY))

const onOnline$ = fromEvent(window, 'online')
const onOffline$ = fromEvent(window, 'offline')

const expBackoff = (retryCount: number) => Math.pow(2, retryCount) * 100

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
  const connectionState = useObservable<ConnectionStatusState>(
    merge(
      client.heartbeat$,
      onOffline$.pipe(
        mergeMapTo(
          throwError(new Error('The network connection has been lost.')),
        ),
      ),
    ).pipe(
      map((ts): ConnectedState => ({type: 'connected', lastHeartbeat: ts})),
      catchWithCount((error, successiveErrorsCount, caught) => {
        const [onRetry$, onRetry] = observableCallback()
        const timeUntilRetry = Math.min(
          1000 * 240,
          expBackoff(successiveErrorsCount),
        )
        const retryAt = new Date(new Date().getTime() + timeUntilRetry)
        const expiry$ = timer(retryAt)

        const isOffline = !navigator.onLine

        const initialErrorState: ErrorState = {
          type: 'error',
          error,
          attemptNo: successiveErrorsCount,
          retry: onRetry,
          offline: isOffline,
          retryAt,
        }

        const triggerRetry$ = NEVER.pipe(
          takeUntil(isOffline ? onOnline$ : merge(expiry$, onOnline$, onRetry$)),
        )

        return concat(
          of(initialErrorState),
          triggerRetry$.pipe(take(1)),
          of({...initialErrorState, retryAt: new Date()}),
          sleep(1000),
          caught,
        )
      }),
    ),
    {type: 'connecting'},
  )

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
