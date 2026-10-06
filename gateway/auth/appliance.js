/*
 * What this appliance is, for the console's Appliance page.
 *
 * Everything here is read from the running process rather than configured
 * twice. A console that reports the certificate it was told about, instead of
 * the one it is actually presenting, is worse than one that reports nothing:
 * an administrator comparing a fingerprint against the installation printout
 * would be comparing it against a copy of the same claim.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { config, ROOT } from '../config.js';
import * as accounts from './accounts.js';
import { sessionTtlMs } from './session.js';
import * as versions from '../policy/versions.js';
import { adapters } from '../proxy/adapters.js';
import { getPolicy } from '../policy/policy.js';

/** SHA-256 of the DER form of the certificate being served, colon-grouped. */
export function certificateFingerprint(pem) {
  if (!pem) return null;
  const body = String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!body) return null;
  const der = Buffer.from(body, 'base64');
  const digest = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return digest.match(/.{2}/g).join(':');
}

function tlsState() {
  const certPath = process.env.DLP_TLS_CERT || null;
  if (!certPath) {
    return {
      enabled: false,
      // Said plainly, because an appliance serving its console over plain HTTP
      // on a corporate network is a real finding, not a configuration detail.
      note: 'The console is served over plain HTTP. Anyone on the path between a browser and this appliance can read the session cookie and everything on these pages.',
    };
  }
  try {
    const pem = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    return {
      enabled: true,
      path: certPath,
      fingerprint: certificateFingerprint(pem),
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      expiresInDays: Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86400000),
      note: 'Compare this fingerprint against the one printed when the appliance was installed before typing a password into this console.',
    };
  } catch (err) {
    return { enabled: true, path: certPath, error: err.message };
  }
}

function buildInfo() {
  let commit = null;
  try {
    // Useful when it works, absent when it does not. An appliance installed
    // from a tarball has no git directory and that is not an error.
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    commit = null;
  }

  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    /* no package.json beside the install */
  }

  return { version, commit, node: process.version, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
}

export function applianceState() {
  const sharedPort = !config.adminPort || config.adminPort === config.port;
  return {
    build: buildInfo(),
    account: accounts.accountStatus(),
    session: { ttlMs: sessionTtlMs() },
    tls: tlsState(),
    listeners: {
      traffic: config.port,
      admin: config.adminPort ?? config.port,
      shared: sharedPort,
      // The reason this matters: on a shared port, any application that can
      // send a prompt can also reach the console's API and is one credential
      // away from rewriting policy. Separating them means a firewall rule can
      // express "employees here, administrators there".
      note: sharedPort
        ? 'Employee traffic and the administrative API share a port. Set DLP_ADMIN_PORT to serve the console and its API somewhere employee traffic cannot reach.'
        : 'The console and its API are served on their own port, away from employee traffic.',
    },
    policy: {
      path: config.policyPath,
      versions: versions.list(5),
      storedVersions: versions.list(1000).length,
    },
    audit: { path: config.auditPath },
    mode: { enforcement: config.mode, upstream: config.upstreamMode },

    // The API page is generated from these rather than written beside them.
    // Documentation that is a second copy of the routing table is a
    // documentation that goes stale the first time the table changes.
    api: {
      routes: adapters.map((a) => ({ name: a.name, route: a.route })),
      groupHeader: 'x-dlp-group',
      groups: Object.keys(getPolicy().groups ?? {}),
      upstreams: config.upstream,
    },
  };
}
