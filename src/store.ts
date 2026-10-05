import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import { LiftServer } from './server';
import { SyncQueue, OutboxEntry } from './sync';
import {
  Adjudication,
  applyOpToDraft,
  Comment,
  computeConflicts,
  CURRENT_USER,
  DraftState,
  LiftStep,
  Op,
  RoleId,
  ROLES,
  Signature
} from './domain';

const cacheKey = 'yy58-lift-plan-draft';

// 权威服务器与同步队列（模块级单例，刷新后从本地快照恢复）
const server = new LiftServer();
const queue = new SyncQueue(server);

function buildOp(type: Op['type'], payload: Op['payload'], overrides: Partial<Op> = {}): Op {
  return {
    opId: `OP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    baseRevision: server.revision,
    type,
    payload,
    author: CURRENT_USER.name,
    role: CURRENT_USER.role,
    createdAt: Date.now(),
    clientId: 'local',
    ...overrides
  };
}

type Persisted = {
  server?: ReturnType<LiftServer['serialize']>;
  outbox?: OutboxEntry[];
  online?: boolean;
  selectedStepId?: string;
  viewBookmarks?: string[];
  activeBookmark?: string;
};

function loadPersisted(): Persisted | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(cacheKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

const saved = loadPersisted();
if (saved?.server) server.restore(saved.server);
if (saved?.outbox) {
  for (const entry of saved.outbox) queue.outbox.push(entry);
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    draft: server.pull() as DraftState,
    outbox: queue.outbox as OutboxEntry[],
    online: (saved?.online as boolean) ?? true,
    syncing: false,
    failNext: false,
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    viewBookmarks: (saved?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景'
  }),
  getters: {
    steps(state): LiftStep[] {
      return state.draft.steps;
    },
    comments(state): Comment[] {
      return state.draft.comments;
    },
    signatures(state): Record<RoleId, Signature | null> {
      return state.draft.signatures;
    },
    adjudications(state): Adjudication[] {
      return state.draft.adjudications;
    },
    revision(state): number {
      return state.draft.revision;
    },
    safetyRevision(state): number {
      return state.draft.safetyRevision;
    },
    locked(state): boolean {
      return state.draft.locked;
    },
    selectedStep(state): LiftStep {
      return state.draft.steps.find((step) => step.id === state.selectedStepId) ?? state.draft.steps[0];
    },
    conflicts(state) {
      return computeConflicts(state.draft.steps);
    },
    openComments(state) {
      return state.draft.comments.filter((comment) => comment.status === 'open');
    },
    pendingCount(state): number {
      return state.outbox.filter((e) => e.status === 'pending' || e.status === 'failed').length;
    },
    failedCount(state): number {
      return state.outbox.filter((e) => e.status === 'failed').length;
    },
    pendingAdjudications(state): Adjudication[] {
      return state.draft.adjudications.filter((a) => a.status === 'pending');
    },
    signedCount(state): number {
      return ROLES.filter((r) => {
        const sig = state.draft.signatures[r.id];
        return sig && sig.safetyRev === state.draft.safetyRevision;
      }).length;
    },
    // 发布门禁：当前修订收齐所有签字、无待裁决意见、意见全部关闭、规则冲突清零
    releaseReady(state): boolean {
      if (state.draft.locked) return false;
      const allSigned = ROLES.every((r) => {
        const sig = state.draft.signatures[r.id];
        return sig && sig.safetyRev === state.draft.safetyRevision;
      });
      const noPendingAdj = state.draft.adjudications.every((a) => a.status !== 'pending');
      const noOpenComments = state.draft.comments.every((c) => c.status !== 'open');
      const noConflicts = computeConflicts(state.draft.steps).length === 0;
      return allSigned && noPendingAdj && noOpenComments && noConflicts;
    },
    readiness(state): number {
      const passedChecks = state.draft.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.draft.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.draft.steps.length) * 100 - commentPenalty));
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep>) {
      if (this.draft.locked) return;
      const op = buildOp('STEP_PATCH', { stepId: this.selectedStepId, patch });
      this.enqueue(op);
    },
    addComment(content: string) {
      if (!content.trim() || this.draft.locked) return;
      const comment: Comment = {
        id: `C-${Date.now()}`,
        author: CURRENT_USER.name,
        role: CURRENT_USER.role,
        content,
        status: 'open',
        stepId: this.selectedStepId
      };
      const op = buildOp('COMMENT_ADD', { comment });
      this.enqueue(op);
    },
    resolveComment(id: string) {
      if (this.draft.locked) return;
      const op = buildOp('COMMENT_RESOLVE', { commentId: id });
      this.enqueue(op);
    },
    sign(roleId: RoleId) {
      if (this.draft.locked) return;
      const roleDef = ROLES.find((r) => r.id === roleId)!;
      const op = buildOp('SIGN', {}, { roleId, author: roleDef.name, role: roleDef.team });
      this.enqueue(op);
    },
    enqueue(op: Op) {
      queue.enqueue(op);
      // 离线时乐观应用到本地草稿；回网后以服务器合并结果为准
      applyOpToDraft(this.draft, op);
      this.persist();
      if (this.online) void this.flush();
    },
    async flush() {
      if (!this.online) return;
      this.syncing = true;
      await queue.flush();
      this.syncing = false;
      this.draft = server.pull();
      this.outbox = [...queue.outbox];
      this.persist();
    },
    retry(opId: string) {
      queue.retry(opId);
      this.draft = server.pull();
      this.outbox = [...queue.outbox];
      this.persist();
    },
    retryAll() {
      queue.retryAll();
      this.draft = server.pull();
      this.outbox = [...queue.outbox];
      this.persist();
    },
    setOnline(value: boolean) {
      this.online = value;
      queue.online = value;
      if (value) void this.flush();
      this.persist();
    },
    setFailNext(value: boolean) {
      this.failNext = value;
      queue.failNextFlush = value;
    },
    clearProcessed() {
      queue.removeProcessed();
      this.outbox = [...queue.outbox];
      this.persist();
    },
    // 模拟另一名会签人（周工）断网改完回传：其操作直接送达服务器，先到者生效
    simulatePeer() {
      if (this.draft.locked) return;
      const base = this.draft.revision;
      const overrides = { author: '周工', role: '安全', clientId: 'peer-zhou', baseRevision: base };
      const ops: Op[] = [
        buildOp('STEP_PATCH', { stepId: 'S-02', patch: { clearance: 1.1, loadRate: 72 } }, overrides),
        buildOp('COMMENT_ADD', {
          comment: {
            id: `C-peer-${Date.now()}`,
            author: '周工',
            role: '安全',
            content: 'S-02 净空复测 1.1m，已设警戒区，建议降低臂架回转速度。',
            status: 'open',
            stepId: 'S-02'
          }
        }, overrides),
        buildOp('SIGN', {}, { ...overrides, roleId: 'anquan' })
      ];
      server.applyOps(ops);
      this.draft = server.pull();
      this.persist();
    },
    adjudicate(adjId: string, accept: boolean) {
      server.resolveAdjudication(adjId, accept);
      this.draft = server.pull();
      this.persist();
    },
    lockPlan() {
      if (!this.releaseReady) return;
      server.lockPlan();
      this.draft = server.pull();
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: 'LP-2026-0918',
            name: '东塔转换桁架吊装',
            revision: this.draft.revision,
            status: 'LOCKED',
            steps: this.draft.steps.map((s) => ({ id: s.id, name: s.title, loadRate: s.loadRate, clearance: s.clearance }))
          }
        }
      });
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    persist() {
      if (typeof localStorage === 'undefined') return;
      const data = {
        server: server.serialize(),
        outbox: queue.outbox,
        online: this.online,
        selectedStepId: this.selectedStepId,
        viewBookmarks: this.viewBookmarks,
        activeBookmark: this.activeBookmark,
        draftSavedAt: new Date().toISOString()
      };
      localStorage.setItem(cacheKey, JSON.stringify(data));
    }
  }
});
