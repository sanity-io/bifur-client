import * as React from 'react'
import {Observable, Subscription} from 'rxjs'

const isFunction = (val: any): val is Function => typeof val === 'function'

function getValue<T>(value: T): T
function getValue<T>(value: T | (() => T)): T {
  return isFunction(value) ? value() : value
}

export function useObservable<T>(observable$: Observable<T>): T | undefined
export function useObservable<T>(observable$: Observable<T>, initialValue: T): T
export function useObservable<T>(
  observable$: Observable<T>,
  initialValue: () => T,
): T
export function useObservable<T>(
  observable$: Observable<T>,
  initialValue?: T,
): T | undefined {
  const subscription = React.useRef<Subscription>()
  const [value, setState] = React.useState<T | undefined>(() => {
    let isSync = true
    let syncVal = getValue(initialValue)
    subscription.current = observable$.subscribe(nextVal => {
      if (isSync) {
        syncVal = nextVal
      } else {
        setState(nextVal)
      }
    })
    isSync = false
    return syncVal
  })

  React.useEffect(
    () => () => {
      if (subscription.current) {
        subscription.current.unsubscribe()
      }
    },
    [],
  )

  return value
}
