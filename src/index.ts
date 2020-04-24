import {createConnect} from "./createConnect";
import {SanityClient} from "@sanity/client";

export const fromUrl = createConnect<WebSocket>(
  (url: string, protocols?: string | string[]) =>
    new window.WebSocket(url, protocols),
)

export function fromClient(client: SanityClient) {
  const {dataset} = client.config()
  return fromUrl(client.getUrl(`/socket/${dataset}`).replace(/^http/, "ws"))
}
