/*
 * The inspection certificate authority.
 *
 * To read a prompt on its way to claude.ai the appliance has to terminate the
 * TLS connection, which means presenting a certificate the employee's browser
 * will accept for a hostname it does not own. That is only possible because
 * the organization has chosen to trust this CA on its own managed machines. It
 * is the most sensitive thing this product does, so a few rules are built in
 * rather than left to deployment:
 *
 *   The CA private key never leaves the appliance. The console offers the
 *   certificate for distribution and has no route that returns the key.
 *
 *   Leaf certificates are short-lived and minted per hostname on demand. A
 *   long-lived wildcard sitting on disk would be a far better prize.
 *
 *   The CA is marked as what it is. The subject says so plainly, so anyone
 *   inspecting a certificate chain in a browser sees the organization's
 *   inspection CA named rather than something impersonating a public issuer.
 *
 * The key is generated once and kept at 0600. Replacing it invalidates every
 * machine's trust at once, which is the intended way to retire it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { ROOT, config } from '../config.js';

const DIR = process.env.DLP_CA_DIR || path.join(ROOT, 'data', 'ca');
const CERT_FILE = path.join(DIR, 'inspection-ca.crt');
const KEY_FILE = path.join(DIR, 'inspection-ca.key');

const LEAF_DAYS = Number(process.env.DLP_LEAF_DAYS || 7);
const CA_YEARS = Number(process.env.DLP_CA_YEARS || 3);

let ca = null;
const leaves = new Map();

const org = () => process.env.DLP_CA_ORG || 'Hajiz DLP';

/** Load the CA from disk, creating it on first use. */
export function loadCA() {
  if (ca) return ca;

  try {
    const certPem = fs.readFileSync(CERT_FILE, 'utf8');
    const keyPem = fs.readFileSync(KEY_FILE, 'utf8');
    ca = {
      certPem,
      keyPem,
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
      created: false,
    };
    return ca;
  } catch {
    /* not created yet */
  }

  ca = createCA();
  return ca;
}

function createCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `00${crypto.randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 86400000);

  // Named for what it is. An administrator looking at a certificate chain in a
  // browser should see the organization's inspection CA, not something dressed
  // up to look like a public issuer.
  const attrs = [
    { name: 'commonName', value: `${org()} Inspection CA` },
    { name: 'organizationName', value: org() },
    { name: 'organizationalUnitName', value: 'AI traffic inspection' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
    { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CERT_FILE, certPem);
  // The one file in this product whose exposure would let someone read every
  // employee's traffic undetected.
  fs.writeFileSync(KEY_FILE, keyPem, { mode: 0o600 });

  return { certPem, keyPem, cert, key: keys.privateKey, created: true };
}

/**
 * A certificate for one hostname, signed by the inspection CA.
 *
 * Cached, because this runs inside the TLS handshake: a browser opening ten
 * connections to the same host must not wait for ten key generations. The
 * cache is in memory only, so a restart re-mints and nothing long-lived is
 * written to disk.
 */
export function leafFor(hostname) {
  const cached = leaves.get(hostname);
  if (cached && cached.notAfter > Date.now() + 60000) return cached;

  const authority = loadCA();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = `00${crypto.randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 86400000);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(authority.cert.subject.attributes);

  // A literal IP has to go in the SAN as an IP entry, not a DNS name, or every
  // client rejects it. Type 7 is iPAddress, type 2 is dNSName.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [isIp ? { type: 7, ip: hostname } : { type: 2, value: hostname }] },
  ]);
  cert.sign(authority.key, forge.md.sha256.create());

  const entry = {
    hostname,
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    notAfter: cert.validity.notAfter.getTime(),
  };
  leaves.set(hostname, entry);
  return entry;
}

/** SHA-256 of the DER form, colon-grouped, to compare against the printout. */
export function fingerprint(certPem = loadCA().certPem) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes();
  const digest = crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase();
  return digest.match(/.{2}/g).join(':');
}

export function caStatus() {
  let state;
  try {
    state = loadCA();
  } catch (err) {
    return { present: false, error: err.message };
  }
  const cert = state.cert;
  return {
    present: true,
    subject: cert.subject.getField('CN')?.value ?? null,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    expiresInDays: Math.floor((cert.validity.notAfter.getTime() - Date.now()) / 86400000),
    fingerprint: fingerprint(state.certPem),
    certPath: CERT_FILE,
    keyPath: KEY_FILE,
    leafDays: LEAF_DAYS,
    minted: leaves.size,
    createdThisBoot: state.created === true,
  };
}

/** The certificate, for distribution. There is deliberately no key accessor. */
export const caCertificatePem = () => loadCA().certPem;

export const caDir = () => DIR;
export const interceptEnabled = () => Boolean(config.proxyPort);
