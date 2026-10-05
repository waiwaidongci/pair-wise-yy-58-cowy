// 模拟的权威服务器：维护 canonical 修订、按字段/角色签字合并、先到者生效、后到留裁决
import {
  Adjudication,
  AdjudicationStatus,
  clone,
  Comment,
  initialComments,
  initialSteps,
  isSafetyField,
  LiftStep,
  Op,
  RoleId,
  ROLES,
  Signature
} from './domain';

export type OpResult = {
  opId: string;
  status: 'applied' | 'parked' | 'duplicate';
  adjudicationId?: string;
};

export type ServerState = {
  revision: number;
  safetyRevision: number;
  steps: LiftStep[];
  comments: Comment[];
  signatures: Record<RoleId, Signature | null>;
  adjudications: Adjudication[];
  locked: boolean;
};

type Serialized = ServerState & {
  appliedOpIds: string[];
  fieldMods: Record<string, number>;
};

export class LiftServer {
  revision = 4;
  safetyRevision = 0;
  steps: LiftStep[];
  comments: Comment[];
  signatures: Record<RoleId, Signature | null>;
  adjudications: Adjudication[] = [];
  locked = false;
  appliedOpIds = new Set<string>();
  // 每个字段最后一次被写入时的修订号，用于按修订号判定并发冲突
  fieldMods: Record<string, number> = {};

  constructor() {
    this.steps = clone(initialSteps);
    this.comments = clone(initialComments);
    this.signatures = { zongbao: null, shebei: null, anquan: null, fangan: null };
    // 初始版本：总包陈晓已签（安全修订 0）
    this.signatures.zongbao = {
      roleId: 'zongbao',
      name: '陈晓',
      signedAt: Date.now() - 86400000,
      opId: 'seed-zongbao',
      safetyRev: 0
    };
    this.appliedOpIds.add('seed-zongbao');
    for (const step of this.steps) {
      for (const field of Object.keys(step) as (keyof LiftStep)[]) {
        this.fieldMods[`${step.id}.${field}`] = this.revision;
      }
    }
  }

  isSignatureValid(sig: Signature | null): boolean {
    return !!sig && sig.safetyRev === this.safetyRevision;
  }

  pull(): ServerState {
    return {
      revision: this.revision,
      safetyRevision: this.safetyRevision,
      steps: clone(this.steps),
      comments: clone(this.comments),
      signatures: { ...this.signatures },
      adjudications: clone(this.adjudications),
      locked: this.locked
    };
  }

  // 批量应用操作，逐条返回结果；按 opId 去重，重试不会重复写
  applyOps(ops: Op[]): OpResult[] {
    const results: OpResult[] = [];
    for (const op of ops) {
      results.push(this.applyOne(op));
    }
    return results;
  }

  private applyOne(op: Op): OpResult {
    if (this.appliedOpIds.has(op.opId)) {
      return { opId: op.opId, status: 'duplicate' };
    }
    this.appliedOpIds.add(op.opId);

    let parked = false;
    let adjudicationId: string | undefined;

    switch (op.type) {
      case 'STEP_PATCH': {
        const step = this.steps.find((s) => s.id === op.payload.stepId);
        if (step) {
          let safetyChanged = false;
          for (const [field, value] of Object.entries(op.payload.patch)) {
            const key = `${step.id}.${field}`;
            // 该字段在操作所依据的修订号之后被改过 → 两版并存，先到者生效
            if (this.fieldMods[key] !== undefined && this.fieldMods[key] > op.baseRevision) {
              const adj = this.parkField(op, step, field, value);
              parked = true;
              adjudicationId = adj.id;
              continue;
            }
            (step as Record<string, unknown>)[field] = value;
            this.fieldMods[key] = this.revision + 1;
            if (isSafetyField(field)) safetyChanged = true;
          }
          if (safetyChanged) this.safetyRevision += 1;
        }
        break;
      }
      case 'COMMENT_ADD': {
        const comment = op.payload.comment as Comment;
        if (!this.comments.some((c) => c.id === comment.id)) {
          this.comments.push(comment);
        }
        break;
      }
      case 'COMMENT_RESOLVE': {
        const comment = this.comments.find((c) => c.id === op.payload.commentId);
        if (comment) comment.status = 'resolved';
        break;
      }
      case 'SIGN': {
        const roleId = op.roleId as RoleId;
        const existing = this.signatures[roleId];
        if (this.isSignatureValid(existing)) {
          // 同一角色签字两版并存，先到者生效，后到留裁决
          const adj = this.parkSign(op);
          parked = true;
          adjudicationId = adj.id;
          break;
        }
        this.signatures[roleId] = {
          roleId,
          name: op.author,
          signedAt: op.createdAt,
          opId: op.opId,
          safetyRev: this.safetyRevision
        };
        break;
      }
    }

    this.revision += 1;
    if (parked) return { opId: op.opId, status: 'parked', adjudicationId };
    return { opId: op.opId, status: 'applied' };
  }

  private parkField(op: Op, step: LiftStep, field: string, incomingValue: unknown): Adjudication {
    const existingValue = (step as Record<string, unknown>)[field];
    const adj: Adjudication = {
      id: `ADJ-${this.adjudications.length + 1}-${op.opId}`,
      opId: op.opId,
      kind: 'field',
      target: `${step.id}.${field}`,
      targetLabel: `${step.id} · ${field}`,
      existingValue,
      incomingValue,
      incomingAuthor: op.author,
      incomingRole: op.role,
      status: 'pending',
      createdAt: op.createdAt
    };
    this.adjudications.push(adj);
    return adj;
  }

  private parkSign(op: Op): Adjudication {
    const roleId = op.roleId as RoleId;
    const roleDef = ROLES.find((r) => r.id === roleId)!;
    const existing = this.signatures[roleId]!;
    const adj: Adjudication = {
      id: `ADJ-${this.adjudications.length + 1}-${op.opId}`,
      opId: op.opId,
      kind: 'sign',
      target: roleId,
      targetLabel: `${roleDef.name}（${roleDef.team}）签字`,
      existingValue: existing.name,
      incomingValue: op.author,
      incomingAuthor: op.author,
      incomingRole: op.role,
      status: 'pending',
      createdAt: op.createdAt
    };
    this.adjudications.push(adj);
    return adj;
  }

  // 裁决：accept 采纳后到版本，reject 维持先到版本
  resolveAdjudication(adjId: string, accept: boolean): void {
    const adj = this.adjudications.find((a) => a.id === adjId);
    if (!adj || adj.status !== 'pending') return;
    adj.status = (accept ? 'accepted' : 'rejected') as AdjudicationStatus;
    if (accept) {
      if (adj.kind === 'field') {
        const [stepId, field] = adj.target.split('.');
        const step = this.steps.find((s) => s.id === stepId);
        if (step) {
          (step as Record<string, unknown>)[field] = adj.incomingValue;
          this.fieldMods[`${stepId}.${field}`] = this.revision + 1;
          if (isSafetyField(field)) this.safetyRevision += 1;
        }
      } else {
        const roleId = adj.target as RoleId;
        this.signatures[roleId] = {
          roleId,
          name: adj.incomingAuthor,
          signedAt: Date.now(),
          opId: adj.opId,
          safetyRev: this.safetyRevision
        };
      }
    }
    this.revision += 1;
  }

  lockPlan(): void {
    this.locked = true;
    this.revision += 1;
  }

  serialize(): Serialized {
    return {
      revision: this.revision,
      safetyRevision: this.safetyRevision,
      steps: clone(this.steps),
      comments: clone(this.comments),
      signatures: { ...this.signatures },
      adjudications: clone(this.adjudications),
      locked: this.locked,
      appliedOpIds: Array.from(this.appliedOpIds),
      fieldMods: { ...this.fieldMods }
    };
  }

  restore(data: Serialized): void {
    this.revision = data.revision;
    this.safetyRevision = data.safetyRevision;
    this.steps = clone(data.steps);
    this.comments = clone(data.comments);
    this.signatures = { ...data.signatures };
    this.adjudications = clone(data.adjudications);
    this.locked = data.locked;
    this.appliedOpIds = new Set(data.appliedOpIds);
    this.fieldMods = { ...data.fieldMods };
  }
}
