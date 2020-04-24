import WebSocket from "ws"

import {fromEvent, merge, timer} from "rxjs"

import {map, mapTo, mergeMap, takeUntil, tap} from "rxjs/operators"

const wss = new WebSocket.Server({port: 3099})

const HEARTBEAT = "♥︎"

const first = <T>(arg: T[]): T => arg[0]

fromEvent<WebSocket[]>(wss, "connection")
  .pipe(
    map(first),
    mergeMap(ws => {
      const messages$ = fromEvent<MessageEvent>(ws, "message")

      const heartbeats$ = timer(0, 1000 * 30).pipe(
        tap(() => ws.send(HEARTBEAT)),
      )

      const replies$ = messages$.pipe(
        tap(message => console.log('message arrived - ', message.data)),
        map(message => JSON.parse(message.data)),
        mergeMap(request =>
          timer(Math.ceil(Math.random() * 10000)).pipe(mapTo(request)),
        ),
        tap(request => {
          ws.send(
            JSON.stringify({
              requestId: request.id,
              data: "PLINGPLONG",
              complete: true,
            }),
          )
        }),
      )

      return merge(heartbeats$, replies$).pipe(
        takeUntil(fromEvent(ws, "disconnect")),
      )
    }),
  )
  .subscribe()
