import type { RequestHandler } from 'express';

import { AppError } from '../utils/errors';

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address.length === 0) {
    return false;
  }
  return (
    address === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(address) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return (
    normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return false;
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export const requireLoopbackControlPlaneRead: RequestHandler = (request, _response, next) => {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    next(
      new AppError(
        403,
        'CONTROL_PLANE_LOCAL_ONLY',
        'Control-plane details are available only from the local machine'
      )
    );
    return;
  }
  if (!isLoopbackHostHeader(request.get('host'))) {
    next(
      new AppError(
        403,
        'CONTROL_PLANE_HOST_FORBIDDEN',
        'Control-plane details require an exact loopback host'
      )
    );
    return;
  }
  next();
};

function isSameLoopbackOrigin(origin: string, host: string): boolean {
  try {
    const parsedOrigin = new URL(origin);
    const parsedHost = new URL(`http://${host}`);
    return (
      parsedOrigin.protocol === 'http:' &&
      isLoopbackHostname(parsedOrigin.hostname) &&
      parsedOrigin.host === parsedHost.host
    );
  } catch {
    return false;
  }
}

export const requireLoopbackMutation: RequestHandler = (request, _response, next) => {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    next(
      new AppError(
        403,
        'DASHBOARD_LOCAL_ONLY',
        'Dashboard mutations are available only from the local machine'
      )
    );
    return;
  }
  const host = request.get('host');
  const origin = request.get('origin');
  const fetchSite = request.get('sec-fetch-site');
  if (
    !isLoopbackHostHeader(host) ||
    (origin !== undefined && !isSameLoopbackOrigin(origin, host ?? '')) ||
    (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
  ) {
    next(
      new AppError(
        403,
        'DASHBOARD_ORIGIN_FORBIDDEN',
        'Dashboard mutations require the exact loopback dashboard origin'
      )
    );
    return;
  }
  next();
};
