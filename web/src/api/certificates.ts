import type { CertificateResponse, VerificationResult } from '../certificates/contracts';
import { parseCertificateResponse, parseVerification } from '../certificates/contracts';
import type { HttpClient } from './http';

export function certificateStatus(
  client: HttpClient,
  courseId: string,
  signal?: AbortSignal,
): Promise<CertificateResponse> {
  return client
    .request(`/courses/${encodeURIComponent(courseId)}/certificate`, signal ? { signal } : {})
    .then(parseCertificateResponse);
}

export function issueCertificate(
  client: HttpClient,
  courseId: string,
  signal?: AbortSignal,
): Promise<CertificateResponse> {
  return client
    .request(`/courses/${encodeURIComponent(courseId)}/certificate`, {
      method: 'POST',
      body: {},
      idempotencyKey: crypto.randomUUID(),
      ...(signal ? { signal } : {}),
    })
    .then(parseCertificateResponse);
}

export function verifyCertificate(
  client: HttpClient,
  code: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  return client
    .request(`/certificates/verify/${encodeURIComponent(code)}`, signal ? { signal } : {})
    .then(parseVerification);
}
