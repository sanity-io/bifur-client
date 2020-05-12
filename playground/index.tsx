import * as ReactDOM from 'react-dom'
import React from 'react'
import {ConnectionStatus} from './ConnectionStatus'
import {Root} from './components/Root'
import {PresenceTest} from "./PresenceTest";
ReactDOM.render(
  <Root>
    {/*<ConnectionStatus />*/}
    <PresenceTest />
  </Root>,
  document.getElementById('root'),
)
