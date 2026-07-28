/**
 * The window.postMessage contract between the MAIN world bridge and the isolated content
 * script.
 *
 * Content scripts run in an isolated world and cannot see page JavaScript variables, so
 * reading ytInitialPlayerResponse requires code running in page scope. Anything on the
 * page can post messages too, hence the namespace tag and the request id: replies are
 * matched by id and messages without our tag are ignored.
 */

export const BRIDGE_REQUEST = 'adaptive-playback:request';
export const BRIDGE_RESPONSE = 'adaptive-playback:response';
export const POT_REQUEST = 'adaptive-playback:pot-request';
export const POT_RESPONSE = 'adaptive-playback:pot-response';

export interface BridgeRequest {
  tag: typeof BRIDGE_REQUEST;
  id: string;
}

export interface PotRequest {
  tag: typeof POT_REQUEST;
  id: string;
  /** Which caption track to ask the player for, so the mint targets the track we want. */
  languageCode: string | null;
}

export interface PotResponse {
  tag: typeof POT_RESPONSE;
  id: string;
  pot: string | null;
  /** How the token was obtained. Surfaced in the dev panel when extraction fails. */
  via: 'observed' | 'minted' | 'unavailable';
}

export interface BridgeResponse {
  tag: typeof BRIDGE_RESPONSE;
  id: string;
  /** JSON text rather than objects: structured clone of these blobs is needlessly costly. */
  playerResponse: string | null;
  ytInitialData: string | null;
  href: string;
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as BridgeRequest).tag === BRIDGE_REQUEST &&
    typeof (value as BridgeRequest).id === 'string'
  );
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as BridgeResponse).tag === BRIDGE_RESPONSE &&
    typeof (value as BridgeResponse).id === 'string'
  );
}

export function isPotRequest(value: unknown): value is PotRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as PotRequest).tag === POT_REQUEST &&
    typeof (value as PotRequest).id === 'string'
  );
}

export function isPotResponse(value: unknown): value is PotResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as PotResponse).tag === POT_RESPONSE &&
    typeof (value as PotResponse).id === 'string'
  );
}
