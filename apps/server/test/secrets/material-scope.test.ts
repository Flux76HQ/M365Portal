// Phase D step D1 (GD1-0 amendment 1): the certificate material has ONE door. This is the structural
// control for it: which source files may name the accessor, the PEM writer and the members that carry the
// key as text. A new file that does is a decision, so this list is where it shows up.
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '@m365portal/shared/testing';
import { CertificateHolder } from '../../src/secrets/certificate-holder.js';
import { SecretsRuntime } from '../../src/secrets/state.js';
import { SecretStore } from '../../src/secrets/secret-store.js';
import { readServerSources, stripComments, type SourceFile } from '../helpers/source-files.js';

/** Files (below `src`) that may contain a pattern; any other file that matches fails the guard. */
const RULES: readonly {
  readonly name: string;
  readonly pattern: RegExp;
  readonly allowed: readonly string[];
}[] = [
  {
    name: 'the accessor is defined in the runtime and called by nothing else',
    pattern: /withCertificateMaterial\s*[(<]/,
    allowed: ['secrets/state.ts'],
  },
  {
    name: 'the service-level reader is used only by the runtime accessor',
    pattern: /\.withMaterial\s*[(<]/,
    allowed: ['secrets/state.ts'],
  },
  {
    name: 'the PEM writer is used only by the certificate service',
    pattern: /\bpemFromDer\b/,
    allowed: ['secrets/pem.ts', 'secrets/certificate-service.ts'],
  },
  {
    name: 'the key as text is named only where the material is made and carried',
    pattern: /\bprivateKeyPem\b/,
    allowed: ['secrets/certificate-material.ts', 'secrets/certificate-service.ts'],
  },
  {
    name: 'the label of a private key PEM is named only by the PEM writer and its one caller',
    pattern: /PRIVATE KEY/,
    allowed: ['secrets/pem.ts', 'secrets/certificate-service.ts'],
  },
];

function violations(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = stripComments(file.text);
    for (const rule of RULES) {
      if (rule.pattern.test(text) && !rule.allowed.includes(file.path)) {
        found.push(`${file.path}: ${rule.name}`);
      }
    }
  }
  return found;
}

function checkScope(files: readonly SourceFile[]): void {
  const found = violations(files);
  if (found.length > 0)
    throw new Error(`certificate material outside its door:\n${found.join('\n')}`);
}

describe('the certificate material has one door', () => {
  it('names the accessor, the PEM writer and the key as text only in the listed files', () => {
    checkScope(readServerSources());
  });

  it('negative: a new file that asks for the material, or writes a PEM frame, fails the guard', () => {
    const base = readServerSources();
    const extra = (path: string, text: string): SourceFile[] => [...base, { path, text }];
    expectGuardFails(
      checkScope,
      extra('http/leak.ts', 'await secrets.withCertificateMaterial("x", f);'),
      {
        name: 'a route calls the accessor',
        reason: 'certificate material outside its door',
      },
    );
    expectGuardFails(
      checkScope,
      extra('setup/leak.ts', 'const key = svc.withMaterial(db, "active", f);'),
      {
        name: 'a service call',
        reason: 'certificate material outside its door',
      },
    );
    expectGuardFails(
      checkScope,
      extra('http/pem.ts', 'const text = "-----BEGIN PRIVATE KEY-----";'),
      {
        name: 'a PEM frame',
        reason: 'certificate material outside its door',
      },
    );
    expectGuardFails(checkScope, extra('http/key.ts', 'return credential.privateKeyPem;'), {
      name: 'the key as text',
      reason: 'certificate material outside its door',
    });
  });

  it('negative: a mention in a comment is not a use, and the guard sees the real files', () => {
    expect(
      violations([{ path: 'http/note.ts', text: '// withCertificateMaterial( is the door' }]),
    ).toEqual([]);
    const files = readServerSources();
    expect(files.some((file) => file.path === 'secrets/state.ts')).toBe(true);
    expect(violations(files.filter((file) => file.path !== 'secrets/state.ts'))).toEqual([]);
  });
});

describe('what the secrets objects expose', () => {
  const names = (prototype: object): string[] => Object.getOwnPropertyNames(prototype).sort();

  it('the holder has no member that returns the key, a PEM or a PKCS#8 export (Phase B stays true)', () => {
    expect(names(CertificateHolder.prototype)).toEqual(
      expect.not.arrayContaining([
        'privateKey',
        'privateKeyPem',
        'export',
        'exportKey',
        'pem',
        'pkcs8',
      ]),
    );
    expect(
      names(CertificateHolder.prototype).filter((name) => /key|pem|pkcs|export/i.test(name)),
    ).toEqual([]);
  });

  it('the runtime has exactly one member that releases the material, and the store opens only by row id', () => {
    expect(
      names(SecretsRuntime.prototype).filter((name) => /material|pem|key/i.test(name)),
    ).toEqual(['setMaterialAccessLog', 'withCertificateMaterial']);
    expect(names(SecretStore.prototype).filter((name) => /pem/i.test(name))).toEqual([]);
  });
});
