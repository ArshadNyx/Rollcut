import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';

/*
 * Public-only mode (`--public-only`, or ROLLCUT_PUBLIC_ONLY=1).
 *
 * When Rollcut records sites on someone else's behalf, the browser must not be
 * able to reach the machine it runs on or its private network: a page, a
 * redirect or a subresource could otherwise put an internal service on video.
 * Chromium is pointed at this small proxy, which resolves every host itself,
 * refuses private, loopback, link-local and unique-local addresses, and then
 * connects to the address it checked (so a name cannot resolve differently a
 * moment later). Plain HTTP is forwarded; HTTPS and WebSockets are tunnelled
 * with CONNECT, so nothing is decrypted.
 *
 * Off by default: recording an app on localhost in CI is the common case.
 */

export function isPrivateIp(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return (
      p === 0 ||
      p === 10 ||
      p === 127 ||
      p >= 224 ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 100 && q >= 64 && q <= 127)
    );
  }
  if (a === '::' || a === '::1') return true;
  if (a.startsWith('::ffff:')) return isPrivateIp(a.slice(7));
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a) || a.startsWith('ff');
}

export function isPrivateName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
  );
}

/** The public address to connect to for `host`, or null when it is private. */
export async function publicAddress(host: string): Promise<string | null> {
  const h = host.replace(/^\[|\]$/g, '');
  if (isPrivateName(h)) return null;
  if (isIP(h)) return isPrivateIp(h) ? null : h;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(h, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (addrs.length === 0 || addrs.some((x) => isPrivateIp(x.address))) return null;
  return addrs[0]!.address;
}

function splitHostPort(target: string, fallback: number): [string, number] {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) ?? /^([^:]+)(?::(\d+))?$/.exec(target);
  return m ? [m[1]!, m[2] ? Number(m[2]) : fallback] : [target, fallback];
}

const warned = new Set<string>();
function refuse(host: string) {
  if (!warned.has(host)) {
    warned.add(host);
    console.error(`rollcut: public-only: refused ${host} (a local or private address)`);
  }
}

/** Starts the filtering proxy on 127.0.0.1 and resolves to its address. */
export async function startEgressProxy(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req: IncomingMessage, res) => {
    // Plain HTTP through a proxy: the request line carries the absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const ip = await publicAddress(url.hostname);
    if (!ip) {
      refuse(url.hostname);
      res
        .writeHead(403, { 'content-type': 'text/plain' })
        .end('Blocked by Rollcut public-only mode.');
      return;
    }
    const upstream = httpRequest(
      {
        host: ip,
        port: Number(url.port) || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...req.headers, host: url.host },
        setHost: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });

  // HTTPS and WebSockets: a CONNECT tunnel to the checked address.
  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    const [host, port] = splitHostPort(req.url ?? '', 443);
    const ip = await publicAddress(host);
    if (!ip) {
      refuse(host);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(port, ip, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', close);
    client.on('error', close);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  server.unref();
  return { server, url: `http://127.0.0.1:${port}` };
}

let started: Promise<{ server: Server; url: string }> | undefined;

/** Chromium arguments for public-only mode, or none when it is off. */
export async function egressArgs(): Promise<string[]> {
  if (process.env.ROLLCUT_PUBLIC_ONLY !== '1') return [];
  started ??= startEgressProxy();
  const { url } = await started;
  // <-loopback> stops Chromium's built-in proxy bypass for localhost, so those
  // requests reach the proxy (and are refused) too.
  return [`--proxy-server=${url}`, '--proxy-bypass-list=<-loopback>'];
}
