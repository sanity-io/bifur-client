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
import {client} from '../client'
import {map, mergeMapTo, startWith, take, takeUntil} from 'rxjs/operators'
import {catchWithCount} from '../utils/catchWithCount'
import {observableCallback} from 'observable-callback'

const sleep = (ms: number) => timer(ms).pipe(mergeMapTo(EMPTY))

const onOnline$ = fromEvent(window, 'online')
const onOffline$ = fromEvent(window, 'offline')

const expBackoff = (retryCount: number) => Math.pow(2, retryCount) * 100

type ConnectingState = {
  type: 'connecting'
}

export type ErrorState = {
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

export type ConnectedState = {type: 'connected'; lastHeartbeat: Date}

export const CONNECTING: ConnectingState = {type: 'connecting'}

export type ConnectionStatusState =
  | ConnectingState
  | ErrorState
  | ConnectedState
  | RetryingState

export const connectionStatus$: Observable<ConnectionStatusState> = merge(
  client.heartbeats,
  onOffline$.pipe(
    mergeMapTo(throwError(new Error('The network connection has been lost.'))),
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
  startWith(CONNECTING),
)
