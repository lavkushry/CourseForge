import { describe, expect, it } from 'vitest';
import { adminDeniedCopy, canAccessAdmin } from '../../src/admin/rbac';
import { settingsAiPanelCopy, settingsPrivacyCopy } from '../../src/settings/status';

describe('Phase 4 admin RBAC honesty', () => {
  it('admits only admin roles on the client gate', () => {
    expect(canAccessAdmin('admin')).toBe(true);
    expect(canAccessAdmin('student')).toBe(false);
    expect(canAccessAdmin(undefined)).toBe(false);
    expect(adminDeniedCopy().description).toMatch(/Non-admin/i);
  });
});

describe('Phase 4 settings AI honesty', () => {
  it('never invents Ollama online from missing status', () => {
    expect(settingsAiPanelCopy(null).ready).toBe(false);
    expect(settingsAiPanelCopy({ ollama_online: false, pgvector_active: false, transcript_chunks: 3 }).ready).toBe(
      false,
    );
    expect(
      settingsAiPanelCopy({
        ollama_online: true,
        pgvector_active: true,
        transcript_chunks: 10,
        ollama_chat_model: 'llama',
      }).ready,
    ).toBe(true);
    expect(settingsPrivacyCopy()).toMatch(/never started/i);
  });
});
