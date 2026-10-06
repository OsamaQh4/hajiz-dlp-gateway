/*
 * The in-path forward proxy.
 *
 * This is how Hajiz sits in the network path. A managed machine is pointed at
 * this port, the employee changes nothing, and every HTTPS connection arrives
 * as a CONNECT. The proxy then does one of two things:
 *
 *   INTERCEPT, for the handful of hosts that carry prompts to AI assistants.
 *   The connection is terminated here with a certificate minted by the
 *   inspection CA, the request is read, inspected and rewritten, and a fresh
 *   TLS connection carries it to the real host.
 *
 *   TUNNEL, for everything else. Bytes are copied between two sockets and
 *   nothing is decrypted. The appliance cannot read it and does not try.
 *
 * Interception is an allow-list, never a default. Decrypting an employee's
 * banking session to look for prompts that cannot be there is indefensible,
 * and a proxy that intercepts everything "for simplicity" is one configuration
 * mistake away from being exactly that. Hosts that pin their certificates are
 * listed as never-intercept for the same reason the design called them out:
 * intercepting them does not fail safely, it fails as a broken application
 * nobody can diagnose.
 */

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { leafFor } from './ca.js';
import { bus } from '../lib/events.js';

/** Hosts whose traffic carries prompts, and is therefore worth reading. */
export const INSPECT_HOSTS = (process.env.DLP_INSPECT_HOSTS ||
  'api.anthropic.com,claude.ai,api.openai.com,chatgpt.com,generativelanguage.googleapis.com,api.deepseek.com,api.mistral.ai')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/**
 * Hosts that must never be intercepted even though they belong to the same
 * vendors. These pin their certificates, so terminating TLS does not degrade
 * gracefully - the app simply stops working, with an error that looks like
 * anything but a proxy.
 */
export const NEVER_INTERCEPT = (process.env.DLP_NEVER_INTERCEPT ||
  'ios.chat.openai.com,android.chat.openai.com,cdn.oaistatic.com,status.anthropic.com,login.microsoftonline.com')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export const shouldInspect = (hostname) => {
  const h = String(hostname ?? '').toLowerCase();
  if (NEVER_INTERCEPT.includes(h)) return false;
  return INSPECT_HOSTS.includes(h);
};

/**
 * @param {object} opts
 * @param {(req, res, context) => Promise<void>} opts.onRequest
 *   Called with a decrypted request. The same pipeline the direct routes use.
 */
/**
 * One HTTPS server, never listening on a port of its own, that raw sockets are
 * handed to after the CONNECT is answered.
 *
 * The first attempt wrapped each socket in a TLSSocket and paired it with a
 * fresh http.Server per connection. The handshake stalled: a TLSSocket created
 * that way is not driven by anything, and the http server attached to it never
 * saw a completed handshake. An https.Server already is a TLS server, so
 * feeding it the socket lets Node run the handshake and the HTTP parsing in
 * the order it expects. The certificate is chosen per connection by SNI, which
 * is also where the hostname the client actually asked for comes from.
 */
function createTlsTerminator({ onRequest }) {
  const server = https.createServer({
    SNICallback: (servername, callback) => {
      try {
        const leaf = leafFor(servername);
        callback(null, tls.createSecureContext({ cert: leaf.cert, key: leaf.key }));
      } catch (err) {
        callback(err);
      }
    },
  });

  server.on('request', async (req, res) => {
    // The authority is taken from SNI rather than the Host header: a client
    // can write anything in a header, and the certificate we presented was
    // minted for what it asked for in the handshake.
    const hostname = req.socket.servername || String(req.headers.host ?? '').split(':')[0];
    try {
      await onRequest(req, res, { hostname, port: 443, intercepted: true });
    } catch (err) {
      bus.publish({ kind: 'proxy_error', hostname, message: err.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'gateway_error', message: err.message } }));
    }
  });

  server.on('tlsClientError', (err, socket) => {
    // Almost always a machine that does not trust the inspection CA. It is a
    // deployment fact worth seeing on the console, not a crash.
    bus.publish({ kind: 'proxy_untrusted', message: err.message, ts: Date.now() });
    socket.destroy();
  });

  return server;
}

export function createProxy({ onRequest }) {
  const terminator = createTlsTerminator({ onRequest });

  // Plain HTTP through a forward proxy arrives as an absolute-form request
  // line. Nothing bound for an AI assistant should be unencrypted, so this is
  // relayed rather than inspected - and recorded, because a prompt arriving in
  // the clear is worth knowing about.
  const server = http.createServer((req, res) => relayPlain(req, res));

  server.on('connect', (req, clientSocket, head) => {
    const [host, portText] = String(req.url).split(':');
    const port = Number(portText) || 443;
    const hostname = host.toLowerCase();

    if (!shouldInspect(hostname)) {
      return tunnel({ hostname, port, clientSocket, head });
    }
    return intercept({ hostname, port, clientSocket, head, terminator });
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/** Copy bytes. The appliance learns the hostname and nothing else. */
function tunnel({ hostname, port, clientSocket, head }) {
  const upstream = net.connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const fail = () => {
    if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    upstream.destroy();
  };
  upstream.on('error', fail);
  clientSocket.on('error', () => upstream.destroy());

  bus.publish({ kind: 'proxy_tunnel', hostname, port, ts: Date.now() });
}

/**
 * Terminate the connection, read the request, and open a new one onward.
 *
 * The leaf certificate is minted for the hostname the client asked for. A
 * machine that does not trust the inspection CA gets a certificate warning
 * here and cannot proceed, which is the intended failure: unreadable AI-bound
 * traffic is refused rather than waved through.
 */
function intercept({ hostname, port, clientSocket, head, terminator }) {
  try {
    // Mint before answering the CONNECT: if the CA cannot issue, the client
    // should see a failed tunnel rather than a TLS error it cannot explain.
    leafFor(hostname);
  } catch (err) {
    bus.publish({ kind: 'proxy_error', hostname, message: `could not mint a certificate: ${err.message}` });
    if (clientSocket.writable) clientSocket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    return;
  }

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  // Anything the client sent with the CONNECT belongs to the TLS handshake
  // that follows, so it is put back before the socket changes hands.
  if (head?.length) clientSocket.unshift(head);

  clientSocket.on('error', () => clientSocket.destroy());
  terminator.emit('connection', clientSocket);

  bus.publish({ kind: 'proxy_intercept', hostname, port, ts: Date.now() });
}

/** Absolute-form HTTP through the proxy: relayed untouched, and recorded. */
function relayPlain(req, res) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('this port is a forward proxy; send an absolute URL or CONNECT');
  }

  bus.publish({ kind: 'proxy_plain', hostname: target.hostname, ts: Date.now() });

  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream error: ${err.message}`);
  });

  req.pipe(upstream);
}
