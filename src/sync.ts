// 吊装方案修订合并引擎。
// 吊装步骤、会签意见、角色签字挂在同一修订号上；断网操作回网后按修订号合并：
// 同一字段或同一角色签字两版并存时先到者生效、后到者留裁决；
// 载荷率 / 净空 / 风速一经变化，既有签字失效需重确认；
// 同步重试按原操作号幂等，不重复写签字或意见。

export type StepStatus = 'pending' | 'passed' | 'blocked';

export interface LiftStep {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
}

export interface PlanComment {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
}

export type RoleId = 'general' | 'equipment' | 'safety' | 'engineering';

export interface RoleMeta {
  id: RoleId;
  name: string;
  team: string;
  scope: string;
  label: string;
}

export const ROLES: RoleMeta[] = [
  { id: 'general', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', label: '总包' },
  { id: 'equipment', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', label: '设备' },
  { id: 'safety', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', label: '安全' },
  { id: 'engineering', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', label: '方案' }
];

export const CRITICAL_FIELDS = ['loadRate', 'clearance', 'wind'] as const;
export type StepField = 'title' | 'time' | 'loadRate' | 'clearance' | 'wind' | 'radius' | 'boom' | 'status' | 'note';

export const FIELD_LABELS: Record<StepField, string> = {
  title: '步骤名称',
  time: '计划时间',
  loadRate: '荷载率',
  clearance: '最小净空',
  wind: '风速',
  radius: '作业半径',
  boom: '臂长',
  status: '步骤结论',
  note: '现场控制说明'
};

interface OperationBase {
  opId: string;
  baseRevision: number;
  actor: string;
  role: RoleId;
  createdAt: string;
}

export interface StepUpdateOp extends OperationBase {
  kind: 'step.update';
  stepId: string;
  fields: Partial<Pick<LiftStep, StepField>>;
}

export interface CommentAddOp extends OperationBase {
  kind: 'comment.add';
  stepId: string;
  content: string;
}

export interface CommentResolveOp extends OperationBase {
  kind: 'comment.resolve';
  commentId: string;
}

export interface SignOp extends OperationBase {
  kind: 'sign';
}

export type Operation = StepUpdateOp | CommentAddOp | CommentResolveOp | SignOp;

export interface Signature {
  role: RoleId;
  signer: string;
  revision: number;
  digest: string;
  opId: string;
  signedAt: string;
}

interface FieldWrite {
  opId: string;
  actor: string;
  value: unknown;
}

export interface Arbitration {
  id: string;
  revision: number;
  kind: 'field' | 'signature';
  key: string;
  label: string;
  kept: { opId: string; actor: string; summary: string };
  incoming: { op: Operation; actor: string; summary: string };
  status: 'pending' | 'resolved';
  resolution?: 'keep' | 'override';
}

export interface AuthorityState {
  revision: number;
  locked: boolean;
  steps: LiftStep[];
  comments: PlanComment[];
  signatures: Signature[];
  arbitrations: Arbitration[];
  appliedOpIds: string[];
  fieldWrites: Record<string, FieldWrite>;
}

export type ApplyResult =
  | { outcome: 'applied' }
  | { outcome: 'duplicate' }
  | { outcome: 'rejected'; reason: string };

/** 关键参数摘要：载荷率、净空、风速任一变化都会改变摘要，从而使旧签字失效。 */
export function paramsDigest(steps: LiftStep[]): string {
  return steps.map((step) => `${step.id}:${step.loadRate}|${step.clearance}|${step.wind}`).join(';');
}

export function roleLabel(role: RoleId): string {
  return ROLES.find((item) => item.id === role)?.label ?? role;
}

export function createAuthority(steps: LiftStep[], comments: PlanComment[], revision: number): AuthorityState {
  return {
    revision,
    locked: false,
    steps: structuredClone(steps),
    comments: structuredClone(comments),
    signatures: [],
    arbitrations: [],
    appliedOpIds: [],
    fieldWrites: {}
  };
}

function formatFieldValue(field: string, value: unknown): string {
  if (field === 'loadRate') return `${value}%`;
  if (field === 'clearance') return `${value}m`;
  if (field === 'wind') return `${value}m/s`;
  if (field === 'status') return value === 'passed' ? '通过' : value === 'blocked' ? '阻断' : '待复核';
  return String(value);
}

function applyStepUpdate(auth: AuthorityState, op: StepUpdateOp): void {
  const step = auth.steps.find((item) => item.id === op.stepId);
  if (!step) return;
  for (const [field, value] of Object.entries(op.fields) as [StepField, LiftStep[StepField]][]) {
    const key = `${auth.revision}:${op.stepId}.${field}`;
    const prior = auth.fieldWrites[key];
    if (prior && prior.actor !== op.actor && prior.value !== value) {
      // 同一字段两版并存：先到者生效，后到者留裁决
      auth.arbitrations.push({
        id: `ARB-${op.opId}-${field}`,
        revision: auth.revision,
        kind: 'field',
        key: `${op.stepId}.${field}`,
        label: `${op.stepId} · ${FIELD_LABELS[field]}`,
        kept: { opId: prior.opId, actor: prior.actor, summary: formatFieldValue(field, prior.value) },
        incoming: { op, actor: op.actor, summary: formatFieldValue(field, value) },
        status: 'pending'
      });
      continue;
    }
    step[field] = value as never;
    auth.fieldWrites[key] = { opId: op.opId, actor: op.actor, value };
  }
}

function applySign(auth: AuthorityState, op: SignOp): void {
  const digest = paramsDigest(auth.steps);
  const existing = auth.signatures.find((sig) => sig.role === op.role && sig.revision === auth.revision);
  if (existing) {
    const stale = existing.digest !== digest;
    if (stale) {
      // 旧签字已因关键参数变化失效：本次为重确认，直接替换
      Object.assign(existing, { signer: op.actor, digest, opId: op.opId, signedAt: op.createdAt });
      return;
    }
    if (existing.signer === op.actor) return; // 同人同意图，幂等收敛
    // 同一角色两版签字并存：先到者生效，后到者留裁决
    const meta = ROLES.find((item) => item.id === op.role);
    auth.arbitrations.push({
      id: `ARB-${op.opId}-sign`,
      revision: auth.revision,
      kind: 'signature',
      key: op.role,
      label: `${meta?.team ?? op.role} 角色签字`,
      kept: { opId: existing.opId, actor: existing.signer, summary: `${existing.signer} 签于 ${existing.signedAt}` },
      incoming: { op, actor: op.actor, summary: `${op.actor} 签于 ${op.createdAt}` },
      status: 'pending'
    });
    return;
  }
  auth.signatures.push({ role: op.role, signer: op.actor, revision: auth.revision, digest, opId: op.opId, signedAt: op.createdAt });
}

/** 应用一条操作到权威修订。按 opId 幂等：同一操作号重复到达不产生重复签字或意见。 */
export function applyOperation(auth: AuthorityState, op: Operation): ApplyResult {
  if (auth.appliedOpIds.includes(op.opId)) return { outcome: 'duplicate' };
  if (auth.locked) return { outcome: 'rejected', reason: '方案已锁定，拒绝写入' };
  switch (op.kind) {
    case 'step.update':
      applyStepUpdate(auth, op);
      break;
    case 'comment.add':
      auth.comments.unshift({
        id: `C-${op.opId}`,
        author: op.actor,
        role: roleLabel(op.role),
        content: op.content,
        status: 'open',
        stepId: op.stepId
      });
      break;
    case 'comment.resolve': {
      const comment = auth.comments.find((item) => item.id === op.commentId);
      if (comment) comment.status = 'resolved';
      break;
    }
    case 'sign':
      applySign(auth, op);
      break;
  }
  auth.appliedOpIds.push(op.opId);
  return { outcome: 'applied' };
}

/** 裁决：保留先到者，或采用后到版本覆盖。 */
export function resolveArbitration(auth: AuthorityState, arbitrationId: string, decision: 'keep' | 'override'): void {
  const arb = auth.arbitrations.find((item) => item.id === arbitrationId);
  if (!arb || arb.status !== 'pending') return;
  arb.status = 'resolved';
  arb.resolution = decision;
  if (decision !== 'override') return;
  if (arb.kind === 'field') {
    const op = arb.incoming.op as StepUpdateOp;
    const field = arb.key.split('.').pop() as StepField;
    const step = auth.steps.find((item) => item.id === op.stepId);
    const value = op.fields[field];
    if (step && value !== undefined) {
      step[field] = value as never;
      auth.fieldWrites[`${auth.revision}:${arb.key}`] = { opId: op.opId, actor: op.actor, value };
    }
  } else {
    const op = arb.incoming.op as SignOp;
    const sig = auth.signatures.find((item) => item.role === arb.key && item.revision === auth.revision);
    if (sig) Object.assign(sig, { signer: op.actor, opId: op.opId, signedAt: op.createdAt, digest: paramsDigest(auth.steps) });
  }
}

/** 发布门禁：当前修订须收齐全部角色有效签字、无待裁决意见，且无规则冲突与未关闭意见。 */
export function lockBlockers(auth: AuthorityState, extras: { conflicts: number; openComments: number }): string[] {
  if (auth.locked) return ['方案已锁定发布'];
  const blockers: string[] = [];
  const digest = paramsDigest(auth.steps);
  for (const role of ROLES) {
    const sig = auth.signatures.find((item) => item.role === role.id && item.revision === auth.revision);
    if (!sig) blockers.push(`缺少${role.team}（${role.name}）签字`);
    else if (sig.digest !== digest) blockers.push(`${role.team}（${role.name}）签字已失效，需重确认`);
  }
  const pending = auth.arbitrations.filter((item) => item.status === 'pending').length;
  if (pending > 0) blockers.push(`${pending} 条冲突意见待裁决`);
  if (extras.conflicts > 0) blockers.push(`${extras.conflicts} 项规则冲突未处理`);
  if (extras.openComments > 0) blockers.push(`${extras.openComments} 条会签意见未关闭`);
  return blockers;
}
