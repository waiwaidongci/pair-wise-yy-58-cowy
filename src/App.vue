<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import { ROLES, fieldLabel, formatFieldValue } from './domain';
import { OutboxEntry } from './sync';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');
const hasSyncActivity = computed(() => store.pendingCount > 0 || store.failedCount > 0 || store.pendingAdjudications.length > 0);

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function opDescription(entry: OutboxEntry): string {
  switch (entry.type) {
    case 'STEP_PATCH': {
      const fields = Object.keys(entry.payload.patch ?? {});
      const fieldText = fields.map((f) => fieldLabel(f)).join('、');
      return `${entry.payload.stepId} · ${fieldText || '参数'}修改`;
    }
    case 'COMMENT_ADD':
      return `${entry.payload.comment?.stepId ?? ''} · 会签意见`;
    case 'COMMENT_RESOLVE':
      return '意见关闭';
    case 'SIGN': {
      const role = ROLES.find((r) => r.id === entry.roleId);
      return `${role?.name ?? ''} · ${role?.team ?? ''}签字`;
    }
    default:
      return '操作';
  }
}

function opStatusLabel(status: OutboxEntry['status']): string {
  switch (status) {
    case 'pending': return '待同步';
    case 'failed': return '同步失败';
    case 'synced': return '已同步';
    case 'parked': return '已留裁决';
  }
}

function signatureState(roleId: string) {
  const sig = store.signatures[roleId as keyof typeof store.signatures];
  if (!sig) return { label: '待确认', color: 'grey', signed: false, invalid: false };
  if (sig.safetyRev === store.safetyRevision) return { label: '已接受', color: 'positive', signed: true, invalid: false };
  return { label: '已失效', color: 'warning', signed: false, invalid: true };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }} · 安全修订 S{{ store.safetyRevision }}</span>
        </div>
        <q-space />
        <q-btn
          dense
          flat
          :icon="store.online ? 'cloud_done' : 'cloud_off'"
          :color="store.online ? 'teal' : 'negative'"
          :label="store.online ? '在线' : '离线'"
          no-caps
          @click="store.setOnline(!store.online)"
        />
        <q-btn dense flat round icon="sync" aria-label="同步队列" @click="store.flush()">
          <q-badge v-if="store.pendingCount > 0" floating color="orange">{{ store.pendingCount }}</q-badge>
        </q-btn>
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
          <q-item-section v-if="item.path === '/review' && store.pendingAdjudications.length > 0" side>
            <q-badge color="warning">{{ store.pendingAdjudications.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="store.online ? 'cloud_done' : 'cloud_off'" :color="store.online ? 'teal' : 'orange'" />
        <span>
          {{ store.online ? '草稿已同步' : '离线草稿箱' }}<br />
          <small>基于修订 V{{ store.revision }} · {{ store.pendingCount }} 项待回传</small>
        </span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="cloud_sync" label="模拟周工离线回传" @click="store.simulatePeer()" />
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定' : '确认并锁定'"
              :disable="store.locked || !store.releaseReady"
              @click="store.lockPlan"
            />
          </div>
        </header>

        <!-- 同步与裁决中心 -->
        <section v-if="hasSyncActivity" class="content-panel sync-center">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">SYNC & ADJUDICATION</span>
              <h2>同步队列与修订裁决</h2>
            </div>
            <div class="sync-actions">
              <q-btn
                v-if="store.failedCount > 0"
                size="sm"
                color="negative"
                outline
                no-caps
                icon="replay"
                :label="`全部重试 (${store.failedCount})`"
                @click="store.retryAll()"
              />
              <q-btn
                v-if="store.pendingCount > 0 && store.online"
                size="sm"
                color="primary"
                no-caps
                icon="sync"
                label="立即回传"
                @click="store.flush()"
              />
              <q-btn
                v-if="store.outbox.some(e => e.status === 'synced' || e.status === 'parked')"
                size="sm"
                flat
                no-caps
                label="清理已处理"
                @click="store.clearProcessed()"
              />
            </div>
          </div>

          <!-- 待裁决：两版并存，先到者生效，后到留裁决 -->
          <div v-if="store.pendingAdjudications.length > 0" class="adjudication-block">
            <div class="block-title"><q-icon name="gavel" /> 待裁决（两版并存 · 先到者生效）</div>
            <div v-for="adj in store.pendingAdjudications" :key="adj.id" class="adjudication-item">
              <div class="adj-target">{{ adj.targetLabel }}</div>
              <div class="adj-versions">
                <div class="adj-version winner">
                  <span class="adj-tag">先到 · 已生效</span>
                  <strong>{{ adj.kind === 'field' ? formatFieldValue(adj.existingValue, adj.target.split('.')[1]) : adj.existingValue }}</strong>
                  <small>{{ adj.incomingAuthor === '周工' ? '周工' : '先到版本' }}</small>
                </div>
                <div class="adj-vs">VS</div>
                <div class="adj-version loser">
                  <span class="adj-tag">后到 · 留裁决</span>
                  <strong>{{ adj.kind === 'field' ? formatFieldValue(adj.incomingValue, adj.target.split('.')[1]) : adj.incomingValue }}</strong>
                  <small>{{ adj.incomingAuthor }} · {{ adj.incomingRole }}</small>
                </div>
              </div>
              <div class="adj-decisions">
                <q-btn size="sm" outline no-caps label="维持先到" @click="store.adjudicate(adj.id, false)" />
                <q-btn size="sm" color="primary" no-caps label="采纳后到" @click="store.adjudicate(adj.id, true)" />
              </div>
            </div>
          </div>

          <!-- 同步队列 -->
          <div v-if="store.outbox.length > 0" class="outbox-block">
            <div class="block-title"><q-icon name="pending_actions" /> 操作队列（按原操作号重试，不重复写签字/意见）</div>
            <div v-for="entry in store.outbox" :key="entry.opId" class="outbox-item" :class="entry.status">
              <div class="outbox-main">
                <span class="outbox-op">{{ opDescription(entry) }}</span>
                <small>操作号 {{ entry.opId }} · 基于修订 V{{ entry.baseRevision }} · {{ formatTime(entry.createdAt) }}</small>
              </div>
              <div class="outbox-status">
                <q-badge :color="entry.status === 'failed' ? 'negative' : entry.status === 'synced' ? 'positive' : entry.status === 'parked' ? 'warning' : 'grey'">
                  {{ opStatusLabel(entry.status) }}
                </q-badge>
                <q-btn v-if="entry.status === 'failed'" size="sm" color="negative" flat no-caps icon="replay" label="重试" @click="store.retry(entry.opId)" />
              </div>
              <div v-if="entry.status === 'failed' && entry.lastError" class="outbox-error">{{ entry.lastError }}</div>
            </div>
          </div>

          <div class="demo-switch">
            <q-toggle v-model="store.failNext" label="演示：下次回传注入网络失败" @update:model-value="store.setFailNext($event)" />
            <span class="hint">失败后操作保留原操作号，重试不会重复写签字或意见。</span>
          </div>
        </section>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 滚轮缩放由设备手势控制</div>
            </div>
            <div class="timeline">
              <button
                v-for="(step, index) in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率</label>
            <q-slider v-model="store.selectedStep.loadRate" :min="0" :max="120" color="primary" :disable="store.locked" />
            <div class="form-row">
              <q-input v-model.number="store.selectedStep.clearance" type="number" label="最小净空 / m" outlined dense :disable="store.locked" />
              <q-input v-model.number="store.selectedStep.wind" type="number" label="风速 / m/s" outlined dense :disable="store.locked" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="store.selectedStep.status"
              spread
              no-caps
              toggle-color="primary"
              :disable="store.locked"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="store.selectedStep.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" :disable="store.locked" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改" :disable="store.locked" @click="store.updateStep({})" />
            <p class="safety-hint">荷载率、净空或风速变更后，已签字角色需重新确认。</p>
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项待处理</q-badge>
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId)">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter(c => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" :disable="store.locked" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" :disable="store.locked" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.signedCount }}/4</strong><span>已收签字</span></div>
          </div>
          <div class="review-grid">
            <article v-for="role in ROLES" :key="role.id" class="review-card">
              <div class="review-head">
                <strong>{{ role.name }}</strong>
                <q-badge :color="signatureState(role.id).color">{{ signatureState(role.id).label }}</q-badge>
              </div>
              <span>{{ role.team }}</span>
              <p>{{ role.scope }}</p>
              <template v-if="!store.locked">
                <q-btn v-if="signatureState(role.id).signed" disable no-caps label="已签署" />
                <q-btn v-else-if="signatureState(role.id).invalid" color="warning" no-caps icon="history" label="重新确认签字" @click="store.sign(role.id)" />
                <q-btn v-else outline no-caps label="接受方案并签字" @click="store.sign(role.id)" />
              </template>
              <q-btn v-else disable no-caps label="版本已锁定" />
            </article>
          </div>

          <div class="release-gate">
            <div class="gate-requirements">
              <div class="gate-title"><q-icon name="verified_user" size="30px" /><strong>发布前门禁</strong></div>
              <ul class="gate-list">
                <li :class="{ met: store.conflicts.length === 0 }">
                  <q-icon :name="store.conflicts.length === 0 ? 'check_circle' : 'radio_button_unchecked'" />
                  规则冲突清零（{{ store.conflicts.length }} 项）
                </li>
                <li :class="{ met: store.openComments.length === 0 }">
                  <q-icon :name="store.openComments.length === 0 ? 'check_circle' : 'radio_button_unchecked'" />
                  会签意见全部关闭（{{ store.openComments.length }} 项待处理）
                </li>
                <li :class="{ met: store.pendingAdjudications.length === 0 }">
                  <q-icon :name="store.pendingAdjudications.length === 0 ? 'check_circle' : 'radio_button_unchecked'" />
                  无待裁决意见（{{ store.pendingAdjudications.length }} 项）
                </li>
                <li :class="{ met: store.signedCount === 4 }">
                  <q-icon :name="store.signedCount === 4 ? 'check_circle' : 'radio_button_unchecked'" />
                  四角色完成签署（{{ store.signedCount }}/4）
                </li>
              </ul>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定发布' : `锁定并发布 V${store.revision + 1}`"
              :disable="store.locked || !store.releaseReady"
              @click="store.lockPlan"
            />
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
