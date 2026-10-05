import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import {
  applyOperation,
  createAuthority,
  FIELD_LABELS,
  lockBlockers,
  paramsDigest,
  resolveArbitration as resolveArbitrationInEngine,
  ROLES,
  roleLabel,
  type ApplyResult,
  type AuthorityState,
  type LiftStep,
  type Operation,
  type PlanComment,
  type RoleId,
  type SignOp,
  type StepField,
  type StepStatus,
  type StepUpdateOp
} from './sync';

export type { LiftStep, PlanComment, StepStatus } from './sync';
export { ROLES } from './sync';

export interface OutboxEntry {
  op: Operation;
  status: 'queued' | 'failed';
  attempts: number;
  lastError?: string;
}

export interface SyncLogEntry {
  opId: string;
  summary: string;
  outcome: ApplyResult['outcome'];
  at: string;
}

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: PlanComment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

const LOCAL_ACTOR = '王工';
const LOCAL_ROLE: RoleId = 'engineering';

function seedAuthority(): AuthorityState {
  const auth = createAuthority(initialSteps, initialComments, 4);
  // 总包陈晓已在当前修订完成签署，作为初始基线
  applyOperation(auth, {
    opId: 'seed-sign-general',
    baseRevision: 4,
    kind: 'sign',
    actor: '陈晓',
    role: 'general',
    createdAt: new Date().toISOString()
  });
  return auth;
}

let opCounter = 0;
function newOpId(): string {
  opCounter += 1;
  return `op-${Date.now()}-${opCounter}`;
}

function opSummary(op: Operation): string {
  switch (op.kind) {
    case 'step.update':
      return `${op.actor} 更新 ${op.stepId}（${Object.keys(op.fields)
        .map((field) => FIELD_LABELS[field as StepField])
        .join('、')}）`;
    case 'comment.add':
      return `${op.actor} 提交 ${op.stepId} 会签意见`;
    case 'comment.resolve':
      return `${op.actor} 关闭意见 ${op.commentId}`;
    case 'sign':
      return `${op.actor} 签署${roleLabel(op.role)}角色`;
  }
}

function computeConflicts(steps: LiftStep[]) {
  return steps.flatMap((step) => {
    const issues: string[] = [];
    if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
    if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
    if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
    if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
    return issues.map((message, index) => ({ id: `${step.id}-${index}`, stepId: step.id, title: step.title, message, severity: step.status === 'blocked' ? 'high' : 'medium' }));
  });
}

const cacheKey = 'yy58-lift-plan-draft-v2';
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
const saved = stored ? JSON.parse(stored) : null;

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    // 本地草稿：UI 直接绑定；权威合并结果在 authority 中，回网后以其为准
    steps: (saved?.steps as LiftStep[]) ?? structuredClone(initialSteps),
    comments: (saved?.comments as PlanComment[]) ?? structuredClone(initialComments),
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    viewBookmarks: (saved?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景',
    authority: (saved?.authority as AuthorityState) ?? seedAuthority(),
    outbox: (saved?.outbox as OutboxEntry[]) ?? [],
    online: (saved?.online as boolean) ?? true,
    syncLog: (saved?.syncLog as SyncLogEntry[]) ?? []
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    revision(state): number {
      return state.authority.revision;
    },
    locked(state): boolean {
      return state.authority.locked;
    },
    conflicts(state) {
      return computeConflicts(state.steps);
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty));
    },
    signatures(state) {
      return state.authority.signatures;
    },
    /** 签字状态：关键参数（载荷率/净空/风速）变化导致摘要失配即为已失效 */
    signatureStatus(state) {
      return (role: RoleId): 'valid' | 'stale' | 'missing' => {
        const sig = state.authority.signatures.find((item) => item.role === role && item.revision === state.authority.revision);
        if (!sig) return 'missing';
        return sig.digest === paramsDigest(state.authority.steps) ? 'valid' : 'stale';
      };
    },
    pendingSignRoles(state): RoleId[] {
      return state.outbox.filter((entry) => entry.op.kind === 'sign').map((entry) => (entry.op as SignOp).role);
    },
    pendingArbitrations(state) {
      return state.authority.arbitrations.filter((item) => item.status === 'pending');
    },
    lockBlockersList(state): string[] {
      const openCount = state.comments.filter((item) => item.status === 'open').length;
      return lockBlockers(state.authority, { conflicts: computeConflicts(state.steps).length, openComments: openCount });
    },
    canLock(): boolean {
      return this.lockBlockersList.length === 0;
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    /** 统一入口：在线直接并入权威修订；离线写入本地草稿并留队列，回网后按修订号合并 */
    submitOp(op: Operation, optimistic?: () => void) {
      if (this.online) {
        const result = applyOperation(this.authority, op);
        this.recordSync(op, result);
        this.pullFromAuthority();
      } else {
        optimistic?.();
        this.outbox.push({ op, status: 'queued', attempts: 0 });
      }
      this.persist();
    },
    updateStep(patch: Partial<Pick<LiftStep, StepField>>) {
      const op: StepUpdateOp = {
        opId: newOpId(),
        baseRevision: this.authority.revision,
        kind: 'step.update',
        actor: LOCAL_ACTOR,
        role: LOCAL_ROLE,
        createdAt: new Date().toISOString(),
        stepId: this.selectedStepId,
        fields: patch
      };
      this.submitOp(op, () => {
        const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
        if (index >= 0) this.steps[index] = { ...this.steps[index], ...patch };
      });
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = LOCAL_ACTOR, role: RoleId = LOCAL_ROLE) {
      if (!content.trim()) return;
      const op: Operation = {
        opId: newOpId(),
        baseRevision: this.authority.revision,
        kind: 'comment.add',
        actor: author,
        role,
        createdAt: new Date().toISOString(),
        stepId: this.selectedStepId,
        content
      };
      this.submitOp(op, () => {
        this.comments.unshift({ id: `C-${op.opId}`, author, role: roleLabel(role), content, status: 'open', stepId: this.selectedStepId });
      });
    },
    resolveComment(id: string) {
      const op: Operation = {
        opId: newOpId(),
        baseRevision: this.authority.revision,
        kind: 'comment.resolve',
        actor: LOCAL_ACTOR,
        role: LOCAL_ROLE,
        createdAt: new Date().toISOString(),
        commentId: id
      };
      this.submitOp(op, () => {
        const item = this.comments.find((comment) => comment.id === id);
        if (item) item.status = 'resolved';
      });
    },
    sign(role: RoleId) {
      const meta = ROLES.find((item) => item.id === role);
      if (!meta) return;
      const op: SignOp = {
        opId: newOpId(),
        baseRevision: this.authority.revision,
        kind: 'sign',
        actor: meta.name,
        role,
        createdAt: new Date().toISOString()
      };
      // 签字不做本地乐观写入：以回网合并（先到者生效）结果为准
      this.submitOp(op);
    },
    resolveArbitration(id: string, decision: 'keep' | 'override') {
      resolveArbitrationInEngine(this.authority, id, decision);
      this.pullFromAuthority();
      this.persist();
    },
    setOnline(online: boolean) {
      this.online = online;
      if (online) this.flushOutbox();
      this.persist();
    },
    /** 回网 flush：按原操作号重试，权威端幂等，不会重复写签字或意见 */
    flushOutbox() {
      if (!this.online) {
        this.outbox.forEach((entry) => {
          if (entry.status === 'queued') {
            entry.status = 'failed';
            entry.lastError = '离线中，等待回网';
          }
        });
        this.persist();
        return;
      }
      const remaining: OutboxEntry[] = [];
      for (const entry of this.outbox) {
        entry.attempts += 1;
        const result = applyOperation(this.authority, entry.op);
        if (result.outcome === 'rejected') {
          entry.status = 'failed';
          entry.lastError = result.reason;
          remaining.push(entry);
        } else {
          this.recordSync(entry.op, result);
        }
      }
      this.outbox = remaining;
      this.pullFromAuthority();
      this.persist();
    },
    /** 模拟会签人断网修改后回传：直接落到权威端，与本机操作按同一修订号合并 */
    simulateRemoteReturn() {
      const step = this.selectedStep;
      const op: StepUpdateOp = {
        opId: newOpId(),
        baseRevision: this.authority.revision,
        kind: 'step.update',
        actor: '周工',
        role: 'safety',
        createdAt: new Date().toISOString(),
        stepId: step.id,
        fields: {
          clearance: Number((step.clearance + 0.4).toFixed(1)),
          wind: Number((step.wind + 0.6).toFixed(1))
        }
      };
      const result = applyOperation(this.authority, op);
      this.recordSync(op, result);
      this.pullFromAuthority();
      this.persist();
    },
    lockPlan() {
      if (!this.canLock) return;
      this.authority.locked = true;
      this.pullFromAuthority();
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: { liftPlan: { __typename: 'LiftPlan', id: 'LP-2026-0918', name: '东塔转换桁架吊装', revision: this.authority.revision, status: 'LOCKED', steps: this.authority.steps } }
      });
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    pullFromAuthority() {
      this.steps = structuredClone(this.authority.steps);
      this.comments = structuredClone(this.authority.comments);
    },
    recordSync(op: Operation, result: ApplyResult) {
      this.syncLog.unshift({ opId: op.opId, summary: opSummary(op), outcome: result.outcome, at: new Date().toLocaleTimeString('zh-CN') });
      if (this.syncLog.length > 12) this.syncLog.length = 12;
    },
    persist() {
      if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, JSON.stringify({ ...this.$state, draftSavedAt: new Date().toISOString() }));
    }
  }
});
