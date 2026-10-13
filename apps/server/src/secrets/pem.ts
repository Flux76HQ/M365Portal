// PEM text from DER (RFC 7468): the frame lines and a base64 body in lines of 64 characters. The only
// use is the certificate material that leaves the process for the Exchange worker (certificate-material.ts).
export type PemLabel = 'CERTIFICATE' | 'PRIVATE KEY';

export function pemFromDer(label: PemLabel, der: Uint8Array): string {
  const lines =
    Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
