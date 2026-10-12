import type { ApiClient } from '../api';
import type { CertificateResponse, Certificate } from './contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

function button(text: string, action: () => void, cls = 'button'): HTMLButtonElement {
  const n = el('button', cls, text);
  n.type = 'button';
  n.addEventListener('click', action);
  return n;
}

export class CertificatesView {
  constructor(
    private readonly api: ApiClient,
    private readonly notice: (msg: string, error?: boolean) => void,
  ) {}

  async renderStatus(container: HTMLElement, courseId: string, signal?: AbortSignal): Promise<void> {
    container.replaceChildren(el('p', 'muted', 'Checking course certificate status…'));
    try {
      const resp = await this.api.certificateStatus(courseId, signal);
      container.replaceChildren();
      if (resp.issued) {
        const badge = el('div', 'cert-banner');
        badge.append(
          el('span', 'cert-badge-icon', '🏆'),
          el('strong', '', 'Certificate of Completion Issued!'),
          el('p', 'muted', `Issued on ${new Date(resp.completed_at).toLocaleDateString()}`),
          button('View Certificate', () => this.showCertificateModal(resp), 'button primary cert-view-btn')
        );
        container.append(badge);
      } else {
        const wrap = el('div', 'cert-readiness');
        const heading = el('div', 'cert-readiness-head');
        heading.append(
          el('h3', '', 'Course Certificate'),
          el('span', 'cert-eligible-tag', resp.eligible ? 'Eligible to Claim' : 'In Progress')
        );
        const stats = el('div', 'cert-progress-grid');
        stats.append(
          el('div', 'cert-stat', `Lessons: ${resp.completed_lessons} / ${resp.total_lessons}`),
          el('div', 'cert-stat', `Quizzes Passed: ${resp.passed_quizzes}`),
        );
        wrap.append(heading, stats);
        if (resp.eligible) {
          const claimBtn = button('Claim Certificate of Completion 🎓', async () => {
            claimBtn.disabled = true;
            try {
              const cert = await this.api.issueCertificate(courseId);
              if (cert.issued) {
                this.notice('Certificate claimed successfully!');
                await this.renderStatus(container, courseId);
                this.showCertificateModal(cert);
              }
            } catch (err) {
              claimBtn.disabled = false;
              this.notice(err instanceof Error ? err.message : 'Could not issue certificate', true);
            }
          }, 'button primary cert-claim-btn');
          wrap.append(claimBtn);
        } else if (resp.reason) {
          wrap.append(el('p', 'muted cert-reason', resp.reason));
        }
        container.append(wrap);
      }
    } catch (err) {
      container.replaceChildren(el('p', 'muted', 'Certificate status unavailable for this course.'));
    }
  }

  showCertificateModal(cert: Certificate): void {
    const dialog = el('dialog', 'cert-dialog');
    const inner = el('div', 'cert-card');

    const top = el('div', 'cert-card-top');
    top.append(
      el('span', 'cert-gold-seal', '★ COURSEFORGE CERTIFIED ★'),
      button('✕ Close', () => dialog.close(), 'button quiet cert-close-btn')
    );

    const body = el('div', 'cert-card-body');
    body.append(
      el('h1', 'cert-title', 'Certificate of Completion'),
      el('p', 'cert-recipient-label', 'This verifies that'),
      el('h2', 'cert-student', cert.student_name),
      el('p', 'cert-course-label', 'has successfully mastered and completed'),
      el('h3', 'cert-course', cert.course),
      el('p', 'cert-date', `Completed on ${new Date(cert.completed_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`)
    );

    const footer = el('div', 'cert-card-footer');
    const codeWrap = el('div', 'cert-code-wrap');
    codeWrap.append(
      el('span', 'muted', 'Verification Code: '),
      el('code', 'cert-code', cert.verification_code)
    );
    const actions = el('div', 'cert-actions');
    actions.append(
      button('Copy Verification Code', () => {
        void navigator.clipboard.writeText(cert.verification_code).then(() => {
          this.notice('Verification code copied to clipboard!');
        });
      }, 'button quiet'),
      button('Print / Save PDF', () => {
        window.print();
      }, 'button')
    );
    footer.append(codeWrap, actions);

    inner.append(top, body, footer);
    dialog.append(inner);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
  }
}
