import { createHash } from 'node:crypto';
import { assertWorkflowTransition, WorkflowStatus } from '../domain/booking';
import { SecurityQrPassService } from '../domain/qr-pass';
import { EventPublisher, RegistrationRepository } from './ports';

export class RegistrationService {
  constructor(private readonly repository: RegistrationRepository, private readonly passes: SecurityQrPassService, private readonly events: EventPublisher) {}

  create(input: { projectId: string; residentId: string; apartmentId: string; type: string; payload: Record<string, unknown>; idempotencyKey: string }) {
    return this.repository.create(input);
  }

  transition(input: { projectId: string; requestId: string; currentStatus: WorkflowStatus; expectedVersion: number; nextStatus: WorkflowStatus; approverId?: string; comment?: string }) {
    assertWorkflowTransition(input.currentStatus, input.nextStatus, input.approverId);
    return this.repository.transition(input);
  }

  async issuePass(input: { projectId: string; requestId: string; residentId: string; type: string; ttlMs: number }) {
    const issued = this.passes.issue({ projectId: input.projectId, requestId: input.requestId, residentId: input.residentId, type: input.type, ttlMs: input.ttlMs });
    const payloadHash = createHash('sha256').update(issued.token, 'utf8').digest('hex');
    await this.repository.issueSecurityPass({ projectId: input.projectId, requestId: input.requestId, residentId: input.residentId, type: input.type, payloadHash, validFrom: new Date(issued.payload.validFrom), expiresAt: new Date(issued.payload.expiresAt), jti: issued.payload.jti });
    return issued;
  }

  async verifyPass(token: string) {
    const payload = this.passes.verify(token);
    if (!(await this.repository.isPassUsable(payload.jti, new Date()))) throw new Error('Security pass is revoked or already used');
    return payload;
  }

  revokePass(jti: string) { return this.repository.revokeSecurityPass(jti); }
}
