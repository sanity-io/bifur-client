import {mergeMapTo, shareReplay,} from 'rxjs/operators'
import {createConnect} from '../src/createConnect'
import {Observable, race, throwError, timer} from 'rxjs'
import {createClient} from '../src/createClient'

const CONNECT_TIMEOUT_MS = 5000

// Operator that will time out using <withObservable> if <due> time passes before receiving the first value
const timeoutOneWith = <T>(due: number, withObservable: Observable<any>) => {
  return (input$: Observable<T>): Observable<T> => {
    return race(input$, timer(due).pipe(mergeMapTo(withObservable)))
  }
}

const connect = createConnect<WebSocket>(
  (url: string, protocols?: string | string[]) =>
    new window.WebSocket(url, protocols),
)

const connection$ = connect('wss://ppsg7ml5.api.sanity.io/v1/socket/test').pipe(
  timeoutOneWith(
    CONNECT_TIMEOUT_MS,
    throwError(
      new Error(
        `Timeout after ${CONNECT_TIMEOUT_MS} while establishing WebSockets connection`,
      ),
    ),
  ),
  shareReplay({refCount: true}),
)

export const client = createClient(connection$)
