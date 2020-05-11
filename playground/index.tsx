import * as ReactDOM from 'react-dom'
import React from 'react'
import {ConnectionStatus} from './ConnectionStatus'
import {Root} from './components/Root'

ReactDOM.render(
  <Root>
    <ConnectionStatus />
  </Root>,
  document.getElementById('root'),
)
