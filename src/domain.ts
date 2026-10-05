// 吊装方案领域模型：步骤、会签意见、角色签字与修订依据

export type RoleId = 'zongbao' | 'shebei' | 'anquan' | 'fangan';

export type RoleDef = {
  id: RoleId;
  name: string;
  team: string;
  scope: string;
};

// 四个会签角色，与现场公示牌一致
export const ROLES: RoleDef[] = [
  { id: 'zongbao', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交' },
  { id: 'shebei', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基' },
  { id: 'anquan', name: '周工', team: '安全监督', scope: '净空、风速与警戒区' },
  { id: 'fangan', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数' }
];

export const CURRENT_USER = { name: '王工', role: '方案' };

export type StepStatus = 'pending' | 'passed' | 'blocked';

export type LiftStep = {
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
};

export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
};

// 签字绑定到某一安全修订（safetyRevision），安全参数一变即失效
export type Signature = {
  roleId: RoleId;
  name: string;
  signedAt: number;
  opId: string;
  safetyRev: number;
};

export type AdjudicationKind = 'field' | 'sign';
export type AdjudicationStatus = 'pending' | 'accepted' | 'rejected';

// 两版并存时先到者生效、后到留裁决
export type Adjudication = {
  id: string;
  opId: string;
  kind: AdjudicationKind;
  target: string; // "S-02.clearance" 或 roleId
  targetLabel: string;
  existingValue: unknown; // 先到版本（当前生效）
  incomingValue: unknown; // 后到版本（留裁决）
  incomingAuthor: string;
  incomingRole: string;
  status: AdjudicationStatus;
  createdAt: number;
};

export type OpType = 'STEP_PATCH' | 'COMMENT_ADD' | 'COMMENT_RESOLVE' | 'SIGN';

export type Op = {
  opId: string;
  baseRevision: number; // 断网操作所依据的修订号
  type: OpType;
  payload: any;
  author: string;
  role: string;
  roleId?: RoleId;
  createdAt: number;
  clientId: string;
};

// 载荷率、净空、风速为安全字段，变更即作废既有签字
export const SAFETY_FIELDS = ['loadRate', 'clearance', 'wind'] as const;
export const isSafetyField = (field: string): boolean =>
  (SAFETY_FIELDS as readonly string[]).includes(field);

export const STEP_FIELDS = ['loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note', 'title', 'time'] as const;

export function fieldLabel(field: string): string {
  switch (field) {
    case 'loadRate': return '荷载率';
    case 'clearance': return '最小净空';
    case 'wind': return '风速';
    case 'radius': return '作业半径';
    case 'boom': return '臂长';
    case 'status': return '步骤状态';
    case 'note': return '现场控制说明';
    case 'title': return '步骤名称';
    case 'time': return '作业时间';
    default: return field;
  }
}

export function formatFieldValue(value: unknown, field: string): string {
  if (value === null || value === undefined) return '—';
  switch (field) {
    case 'loadRate': return `${value}%`;
    case 'clearance':
    case 'wind':
    case 'radius':
    case 'boom': return `${value}m`;
    case 'status': return value === 'passed' ? '通过' : value === 'blocked' ? '阻断' : '待复核';
    default: return String(value);
  }
}

export const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

export const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

export type Conflict = {
  id: string;
  stepId: string;
  title: string;
  message: string;
  severity: 'high' | 'medium';
};

// 规则引擎：由步骤参数驱动冲突
export function computeConflicts(steps: LiftStep[]): Conflict[] {
  return steps.flatMap((step) => {
    const issues: string[] = [];
    if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
    if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
    if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
    if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
    return issues.map((message, index) => ({
      id: `${step.id}-${index}`,
      stepId: step.id,
      title: step.title,
      message,
      severity: step.status === 'blocked' ? 'high' : 'medium'
    }));
  });
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// 离线时把操作乐观应用到本地草稿（不做冲突检测，冲突在回网合并时判定）
export type DraftState = {
  revision: number;
  safetyRevision: number;
  steps: LiftStep[];
  comments: Comment[];
  signatures: Record<RoleId, Signature | null>;
  adjudications: Adjudication[];
  locked: boolean;
};

export function applyOpToDraft(draft: DraftState, op: Op): void {
  switch (op.type) {
    case 'STEP_PATCH': {
      const step = draft.steps.find((s) => s.id === op.payload.stepId);
      if (step) {
        for (const [field, value] of Object.entries(op.payload.patch)) {
          (step as Record<string, unknown>)[field] = value;
          if (isSafetyField(field)) draft.safetyRevision += 1;
        }
      }
      break;
    }
    case 'COMMENT_ADD': {
      const comment = op.payload.comment as Comment;
      if (!draft.comments.some((c) => c.id === comment.id)) draft.comments.push(comment);
      break;
    }
    case 'COMMENT_RESOLVE': {
      const comment = draft.comments.find((c) => c.id === op.payload.commentId);
      if (comment) comment.status = 'resolved';
      break;
    }
    case 'SIGN': {
      const roleId = op.roleId as RoleId;
      draft.signatures[roleId] = {
        roleId,
        name: op.author,
        signedAt: op.createdAt,
        opId: op.opId,
        safetyRev: draft.safetyRevision
      };
      break;
    }
  }
}
