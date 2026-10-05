<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { ROLES, useLiftStore, type StepStatus } from './store';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
// 步骤编辑草稿：保存时合并为一条同步操作，避免滑块连续变化刷爆操作队列
const stepDraft = ref({ loadRate: 0, clearance: 0, wind: 0, status: 'pending' as StepStatus, note: '' });
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

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

watch(
  () => store.selectedStep,
  (step) => {
    if (!step) return;
    stepDraft.value = { loadRate: step.loadRate, clearance: step.clearance, wind: step.wind, status: step.status, note: step.note };
  },
  { immediate: true, deep: true }
);

function saveStep() {
  store.updateStep({ ...stepDraft.value });
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function signatureBadge(roleId: (typeof ROLES)[number]['id']) {
  if (store.pendingSignRoles.includes(roleId)) return { label: '待同步', color: 'info' };
  const status = store.signatureStatus(roleId);
  if (status === 'valid') return { label: '已签署', color: 'positive' };
  if (status === 'stale') return { label: '已失效待重签', color: 'warning' };
  return { label: '待签署', color: 'grey' };
}

function outcomeLabel(outcome: string) {
  return outcome === 'applied' ? '已合并' : outcome === 'duplicate' ? '重复操作已忽略' : '被拒绝';
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
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }}</span>
        </div>
        <q-space />
        <q-badge :color="store.online ? 'teal' : 'grey-6'" outline class="status-badge">
          {{ store.online ? '在线' : '离线编辑中' }}
        </q-badge>
        <q-badge v-if="store.outbox.length > 0" color="warning" outline class="status-badge">
          待同步 {{ store.outbox.length }}
        </q-badge>
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
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
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="store.online ? 'cloud_done' : 'cloud_off'" :color="store.online ? 'teal' : 'grey-6'" />
        <span>{{ store.online ? '草稿已自动保存' : `离线中 · ${store.outbox.length} 条操作待同步` }}<br /><small>{{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small></span>
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
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '版本已锁定' : '确认并锁定'" :disable="store.locked || !store.canLock" @click="store.lockPlan" />
          </div>
        </header>

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
            <q-slider v-model="stepDraft.loadRate" :min="0" :max="120" color="primary" :disable="store.locked" />
            <div class="form-row">
              <q-input v-model.number="stepDraft.clearance" type="number" label="最小净空 / m" outlined dense :disable="store.locked" />
              <q-input v-model.number="stepDraft.wind" type="number" label="风速 / m/s" outlined dense :disable="store.locked" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="stepDraft.status"
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
            <q-input v-model="stepDraft.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" :disable="store.locked" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改" :disable="store.locked" @click="saveStep" />
            <p class="save-hint">保存即生成一条同步操作；载荷率、净空、风速变化会使已有签字失效。</p>
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
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁 · 修订 V{{ store.revision }}</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>
          <div class="review-grid">
            <article v-for="role in ROLES" :key="role.id" class="review-card">
              <div class="review-head">
                <strong>{{ role.name }}</strong>
                <q-badge :color="signatureBadge(role.id).color">{{ signatureBadge(role.id).label }}</q-badge>
              </div>
              <span>{{ role.team }}</span>
              <p>{{ role.scope }}</p>
              <q-btn
                outline
                no-caps
                :loading="false"
                :disable="store.locked || store.signatureStatus(role.id) === 'valid' || store.pendingSignRoles.includes(role.id)"
                :label="store.signatureStatus(role.id) === 'stale' ? '重新确认签署' : store.signatureStatus(role.id) === 'valid' ? '已签署' : '接受方案并签署'"
                @click="store.sign(role.id)"
              />
            </article>
          </div>

          <div class="sync-section">
            <div class="sync-panel">
              <div class="sync-head">
                <strong>同步与离线队列</strong>
                <q-toggle :model-value="store.online" color="teal" :label="store.online ? '在线' : '离线'" @update:model-value="store.setOnline" />
              </div>
              <div v-if="store.outbox.length === 0" class="empty-state slim">本机无待同步操作。</div>
              <div v-for="entry in store.outbox" :key="entry.op.opId" class="outbox-row">
                <q-icon :name="entry.status === 'failed' ? 'error_outline' : 'schedule'" :color="entry.status === 'failed' ? 'negative' : 'grey-6'" />
                <div>
                  <strong>{{ entry.op.opId }}</strong>
                  <small>{{ entry.status === 'failed' ? `同步失败 · ${entry.lastError ?? '待重试'}` : '排队中' }} · 已试 {{ entry.attempts }} 次</small>
                </div>
              </div>
              <div class="sync-actions">
                <q-btn outline no-caps icon="sync" label="重试同步" :disable="store.outbox.length === 0 || !store.online" @click="store.flushOutbox" />
                <q-btn outline no-caps icon="cloud_upload" label="模拟会签人回传" :disable="store.locked" @click="store.simulateRemoteReturn" />
              </div>
              <p class="save-hint">先修改当前步骤的净空或风速，再点“模拟会签人回传”，可看到同字段两版并存时先到者生效、后到者进入裁决。</p>
              <div v-if="store.syncLog.length > 0" class="sync-log">
                <div v-for="entry in store.syncLog" :key="entry.opId + entry.at" class="sync-log-row">
                  <span>{{ entry.at }}</span>
                  <strong>{{ entry.summary }}</strong>
                  <em :class="entry.outcome">{{ outcomeLabel(entry.outcome) }}</em>
                </div>
              </div>
            </div>

            <div class="sync-panel">
              <div class="sync-head"><strong>待裁决意见</strong><q-badge color="warning">{{ store.pendingArbitrations.length }}</q-badge></div>
              <div v-if="store.pendingArbitrations.length === 0" class="empty-state slim">无待裁决项，当前修订内容一致。</div>
              <div v-for="arb in store.pendingArbitrations" :key="arb.id" class="arb-row">
                <div class="arb-title">{{ arb.label }}</div>
                <div class="arb-versions">
                  <div><span>先到生效</span><strong>{{ arb.kept.actor }}：{{ arb.kept.summary }}</strong></div>
                  <div><span>后到待裁决</span><strong>{{ arb.incoming.actor }}：{{ arb.incoming.summary }}</strong></div>
                </div>
                <div class="arb-actions">
                  <q-btn dense outline no-caps label="保留先到" @click="store.resolveArbitration(arb.id, 'keep')" />
                  <q-btn dense outline no-caps color="primary" label="采用后到" @click="store.resolveArbitration(arb.id, 'override')" />
                </div>
              </div>
            </div>
          </div>

          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span v-if="store.canLock">当前修订已收齐全部角色签字且无待裁决意见，可锁定发布。</span>
                <span v-else>{{ store.lockBlockersList.join('；') }}</span>
              </div>
            </div>
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? `V${store.revision} 已锁定发布` : `锁定并发布 V${store.revision}`" :disable="store.locked || !store.canLock" @click="store.lockPlan" />
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
