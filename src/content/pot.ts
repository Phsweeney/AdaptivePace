/**
 * Getting the proof-of-origin token that /api/timedtext requires.
 *
 * The caption URLs in ytInitialPlayerResponse are correctly signed and still return HTTP
 * 200 with an empty body. The signature is not the problem: the same URL succeeds once
 * `c=WEB` and a `pot` token are appended, and fails with either one missing. That token is
 * minted by the player's attestation code, is bound to the page load, and is not written
 * anywhere in the page's data blobs, so there is nothing to read out of them.
 *
 * What the token is not bound to is the track or the format. One token covers every
 * language and every fmt on the page, which is why this is fetched once per extraction and
 * reused across the whole format ladder.
 *
 * A null result is an ordinary outcome. The caller still tries the bare URLs, because a
 * request that YouTube declines is no worse than one never made.
 */

import { POT_REQUEST, isPotResponse } from './protocol.ts';
import type { PotRequest, PotResponse } from './protocol.ts';

/**
 * Deliberately longer than the bridge's own mint timeout, so the normal way to give up is
 * the bridge replying 'unavailable' rather than this timer firing. This one only covers a
 * bridge that never loaded at all.
 */
const POT_TIMEOUT_MS = 15000;

export interface ProofOfOrigin {
  pot: string | null;
  via: PotResponse['via'] | 'no-bridge';
}

/**
 * Asks the MAIN world bridge for a token for the given caption language.
 *
 * The language matters only on the slow path, where the bridge has to provoke a caption
 * request and may as well provoke one for the track we actually want.
 */
export function getProofOfOrigin(languageCode: string | null): Promise<ProofOfOrigin> {
  return new Promise((resolve) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (value: ProofOfOrigin) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (!isPotResponse(event.data) || event.data.id !== id) return;
      finish({ pot: event.data.pot, via: event.data.via });
    };

    const timer = setTimeout(() => finish({ pot: null, via: 'no-bridge' }), POT_TIMEOUT_MS);
    window.addEventListener('message', onMessage);

    const request: PotRequest = { tag: POT_REQUEST, id, languageCode };
    window.postMessage(request, window.location.origin);
  });
}
