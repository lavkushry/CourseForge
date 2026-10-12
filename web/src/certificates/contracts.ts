import { ContractError } from '../validation';

export interface Certificate {
  issued: true;
  certificate_id: string;
  verification_code: string;
  student_name: string;
  course: string;
  completed_at: string;
  verify_url: string;
}

export interface CertificateReadiness {
  issued: false;
  eligible: boolean;
  reason?: string | undefined;
  total_lessons: number;
  completed_lessons: number;
  passed_quizzes: number;
  remaining_lessons: number;
  remaining_quizzes: number;
}

export type CertificateResponse = Certificate | CertificateReadiness;

export interface VerificationResult {
  valid: boolean;
  student_name: string;
  course: string;
  completed_at: string;
  verification_code: string;
  status: string;
}

export function parseCertificateResponse(value: unknown): CertificateResponse {
  if (!value || typeof value !== 'object') throw new ContractError('certificate response');
  const d = value as Record<string, unknown>;
  if (d.issued === true) {
    return {
      issued: true,
      certificate_id: String(d.certificate_id || ''),
      verification_code: String(d.verification_code || ''),
      student_name: String(d.student_name || ''),
      course: String(d.course || ''),
      completed_at: String(d.completed_at || ''),
      verify_url: String(d.verify_url || `/verify/${d.verification_code || ''}`),
    };
  }
  return {
    issued: false,
    eligible: Boolean(d.eligible),
    reason: typeof d.reason === 'string' ? d.reason : undefined,
    total_lessons: Number(d.total_lessons || 0),
    completed_lessons: Number(d.completed_lessons || 0),
    passed_quizzes: Number(d.passed_quizzes || 0),
    remaining_lessons: Number(d.remaining_lessons || 0),
    remaining_quizzes: Number(d.remaining_quizzes || 0),
  };
}

export function parseVerification(value: unknown): VerificationResult {
  if (!value || typeof value !== 'object') throw new ContractError('verification response');
  const d = value as Record<string, unknown>;
  return {
    valid: Boolean(d.valid),
    student_name: String(d.student_name || ''),
    course: String(d.course || ''),
    completed_at: String(d.completed_at || ''),
    verification_code: String(d.verification_code || ''),
    status: String(d.status || ''),
  };
}
