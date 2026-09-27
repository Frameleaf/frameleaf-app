import { Injectable } from '@nestjs/common';
import { Client as AcmeLibraryClient, crypto as acmeCrypto } from 'acme-client';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** The certificates the edge worker holds: the `*.<label>` wildcard, and one for the custom hostname. */
export type EdgeCertificateKind = 'wildcard' | 'custom';

export type EdgeCertificatePair = { certificate: string; key: string };

/** The part of an ACME client an issuance uses (acme-client's `Client`), so specs can stand in a fake CA. */
export type AcmeClient = Pick<
  AcmeLibraryClient,
  | 'createAccount'
  | 'getAccountUrl'
  | 'createOrder'
  | 'getAuthorizations'
  | 'getChallengeKeyAuthorization'
  | 'completeChallenge'
  | 'waitForValidStatus'
  | 'finalizeOrder'
  | 'getCertificate'
>;

export type AcmeIssueRequest = {
  directoryUrl: string;
  /** Every name the certificate covers (one order). */
  names: string[];
  /** The CA's certificate profile (`tlsserver`), when the enrolment names one. */
  profile?: string;
  /** Called with the ACME account URL before ordering, so the CAA record can name the account first. */
  onAccount?: (accountUrl: string) => Promise<void>;
  /**
   * Publish one DNS-01 value; it resolves once the value may be validated. For every name this
   * server orders, the value goes under its own `_acme-challenge.<label>` record (a custom hostname
   * delegates its challenge there by CNAME).
   */
  setChallenge: (value: string) => Promise<void>;
  removeChallenge: (value: string) => Promise<void>;
};

export type AcmeIssueResult = EdgeCertificatePair & { accountUrl: string };

/** The folder under the identity directory; created 0700, every file in it 0600. */
export const EDGE_DIRECTORY = 'edge';
const ACCOUNT_KEY_FILE = 'acme-account.key.pem';
const certificateFile = (kind: EdgeCertificateKind) => `${kind}.cert.pem`;
const keyFile = (kind: EdgeCertificateKind) => `${kind}.key.pem`;

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * The edge worker's certificates (FL-165, CLD-102): the ACME account key and each certificate with
 * its private key, as 0600 files under `<identity>/edge`. No key ever leaves this host: the cloud
 * only publishes the DNS-01 values handed to `setChallenge`, and learns a certificate's facts, never
 * the certificate or its key.
 *
 * Issuance is one ACME order (RFC 8555) with DNS-01 challenges, answered through the callbacks the
 * caller wires to Frameleaf Cloud's TXT API, then a CSR signed with a new P-256 key made here.
 */
@Injectable()
export class EdgeCertificateRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(EdgeCertificateRepository.name);
  }

  directory(identityDir: string) {
    return join(identityDir, EDGE_DIRECTORY);
  }

  /** The ACME account key, created once (P-256) and kept 0600. */
  async accountKey(identityDir: string): Promise<string> {
    const file = join(this.directory(identityDir), ACCOUNT_KEY_FILE);
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
    const key = (await acmeCrypto.createPrivateEcdsaKey('P-256')).toString();
    await this.writePrivate(identityDir, ACCOUNT_KEY_FILE, key);
    return key;
  }

  async read(identityDir: string, kind: EdgeCertificateKind): Promise<EdgeCertificatePair | null> {
    const dir = this.directory(identityDir);
    try {
      const [certificate, key] = await Promise.all([
        readFile(join(dir, certificateFile(kind)), 'utf8'),
        readFile(join(dir, keyFile(kind)), 'utf8'),
      ]);
      return { certificate, key };
    } catch (error) {
      if (missing(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Replace a certificate and its key; each file is written aside and renamed into place. */
  async write(identityDir: string, kind: EdgeCertificateKind, pair: EdgeCertificatePair) {
    await this.writePrivate(identityDir, keyFile(kind), pair.key);
    await this.writePrivate(identityDir, certificateFile(kind), pair.certificate);
  }

  /** Remove certificates and their keys (remote access turned off, or the server unlinked). */
  async remove(identityDir: string, kinds: EdgeCertificateKind[] = ['wildcard', 'custom']) {
    const dir = this.directory(identityDir);
    for (const kind of kinds) {
      await rm(join(dir, keyFile(kind)), { force: true });
      await rm(join(dir, certificateFile(kind)), { force: true });
    }
  }

  /** The ACME client for a directory and account key. Specs replace this with a fake CA. */
  client(directoryUrl: string, accountKey: string): AcmeClient {
    return new AcmeLibraryClient({ directoryUrl, accountKey });
  }

  /** A new P-256 key and a CSR for `names`; the key stays in this process until it is written 0600. */
  async createCsr(names: string[]): Promise<{ key: string; csr: Buffer }> {
    const key = await acmeCrypto.createPrivateEcdsaKey('P-256');
    const [, csr] = await acmeCrypto.createCsr({ commonName: names[0], altNames: names }, key);
    return { key: key.toString(), csr };
  }

  /**
   * One ACME order for `names` with DNS-01. Every value published is removed again, whether the order
   * succeeds or not. Throws with the CA's or the TXT API's message when anything fails.
   */
  async issue(identityDir: string, request: AcmeIssueRequest): Promise<AcmeIssueResult> {
    const client = this.client(request.directoryUrl, await this.accountKey(identityDir));
    await client.createAccount({ termsOfServiceAgreed: true });
    const accountUrl = client.getAccountUrl();
    await request.onAccount?.(accountUrl);

    const order = await client.createOrder({
      identifiers: request.names.map((value) => ({ type: 'dns', value })),
      ...(request.profile && { profile: request.profile }),
    } as Parameters<AcmeClient['createOrder']>[0]);

    const published: string[] = [];
    try {
      const authorizations = await client.getAuthorizations(order);
      const pending: Array<Parameters<AcmeClient['completeChallenge']>[0]> = [];
      for (const authorization of authorizations) {
        if (authorization.status === 'valid') {
          continue;
        }
        const challenge = authorization.challenges.find((candidate) => candidate.type === 'dns-01');
        if (!challenge) {
          throw new Error(`The certificate authority offered no DNS challenge for ${authorization.identifier.value}`);
        }
        // for DNS-01 this is already the record value: base64url SHA-256 of the key authorization
        const value = await client.getChallengeKeyAuthorization(challenge);
        await request.setChallenge(value);
        published.push(value);
        pending.push(challenge);
      }
      for (const challenge of pending) {
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
      }

      const { key, csr } = await this.createCsr(request.names);
      const finalized = await client.finalizeOrder(order, csr);
      const certificate = await client.getCertificate(finalized);
      return { certificate, key, accountUrl };
    } finally {
      for (const value of published) {
        await request.removeChallenge(value).catch((error: unknown) => {
          // the cloud removes challenge values on its own after an hour
          this.logger.warn(`A certificate challenge record could not be removed: ${error}`);
        });
      }
    }
  }

  private async writePrivate(identityDir: string, name: string, content: string) {
    const dir = this.directory(identityDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const file = join(dir, name);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
