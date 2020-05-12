import React from 'react'
import {client} from './client'
import {merge, defer} from 'rxjs'
import {switchMap, take, debounceTime} from 'rxjs/operators'

client.request('presence').subscribe()
client.request('presence_rollcall').subscribe()
client.request('presence_announce', {data: {foo: 'Hello'}}).subscribe()

client.heartbeats.subscribe()
client.request('query', {query: '*[0...10]'}).subscribe()

defer(() => client.heartbeats.pipe(debounceTime(100)))
  // .pipe(switchMap(h => client.request('presence_rollcall').pipe(take(1))))
  .subscribe(console.log)

export function PresenceTest() {
  return <div style={{padding: 10}}>presence test</div>
}
