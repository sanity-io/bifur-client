import {SanityClient} from '@sanity/client'
import {BifurClient, fromUrl} from './createClient'

export {fromUrl}

export function fromSanityClient(client: SanityClient): BifurClient {
  const {dataset} = client.config()
  return fromUrl(client.getUrl(`/socket/${dataset}`).replace(/^http/, 'ws'))
}
