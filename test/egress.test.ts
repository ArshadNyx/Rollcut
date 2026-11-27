import { request } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isPrivateIp,
  isPrivateName,
  publicAddress,
  startEgressProxy,
} from '../src/record/egress.js';
import { isWebTarget } from '../src/spec/schema.js';

describe('navigate targets', () => {
  it('allows paths and http(s) addresses only', () => {
    for (const ok of [
      '/',
      '/pricing?x=1',
      'https://example.com',
      'http://example.com/a',
      'pricing',
    ])
      expect(isWebTarget(ok), ok).toBe(true);
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chrome://settings',
      'view-source:https://a.com',
      '',
    ])
      expect(isWebTarget(bad), bad).toBe(false);
  });
});

describe('private addresses', () => {
  it('knows the private ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fdaa::3',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateIp(ip), ip).toBe(false);
    for (const n of ['localhost', 'a.localhost', 'printer.local', 'app.internal'])
      expect(isPrivateName(n), n).toBe(true);
  });
  it('refuses names and literals that are private', async () => {
    expect(await publicAddress('localhost')).toBeNull();
    expect(await publicAddress('127.0.0.1')).toBeNull();
    expect(await publicAddress('[::1]')).toBeNull();
    expect(await publicAddress('8.8.8.8')).toBe('8.8.8.8');
  });
});

describe('public-only proxy', () => {
  let close: () => void = () => {};
  afterAll(() => close());

  const viaProxy = (proxy: string, opts: { method: string; path: string; host?: string }) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(proxy);
      const req = request({
        host: u.hostname,
        port: u.port,
        method: opts.method,
        path: opts.path,
        headers: opts.host ? { host: opts.host } : {},
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  it('refuses plain HTTP and CONNECT tunnels to private addresses', async () => {
    const { server, url } = await startEgressProxy();
    close = () => server.close();
    expect(
      await viaProxy(url, { method: 'GET', path: 'http://127.0.0.1:9/', host: '127.0.0.1:9' }),
    ).toBe(403);
    expect(await viaProxy(url, { method: 'GET', path: 'http://localhost/' })).toBe(403);
    expect(await viaProxy(url, { method: 'CONNECT', path: '169.254.169.254:443' })).toBe(403);
    expect(await viaProxy(url, { method: 'CONNECT', path: '[::1]:443' })).toBe(403);
    expect(await viaProxy(url, { method: 'GET', path: 'file:///etc/passwd' })).toBe(400);
  });
});
