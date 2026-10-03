<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useDictionaryStore } from '~/store/dictionary';
import type { MergeReportStats } from '~/types/dictionary';
import ConflictMergeDialog from '~/components/ConflictMergeDialog.vue';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();
const fileInput = ref<HTMLInputElement | null>(null);
const editingName = ref(false);
const nameDraft = ref(store.replicaName);
const conflictOpen = ref(false);

const statsText = (stats: Readonly<MergeReportStats>) =>
  `新增 ${stats.added} · 更新 ${stats.updated} · 字段冲突 ${stats.conflictsResolved} · 撤下 ${stats.tombstonesApplied} · 拦下复活 ${stats.resurrectionsBlocked}`;

const exportSyncBundle = () => {
  const bundle = store.buildSyncBundle();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `同事同步包-${store.replicaName}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  MessagePlugin.success('同步包已导出，可通过 U 盘或网络发给同事');
};

const pickFile = () => fileInput.value?.click();

const onFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const result = await store.receiveSyncFile(file);
  if (result.ok) {
    const plan = store.activePlan!;
    MessagePlugin.success(`已读取副本“${plan.bundle.replicaName}”的同步包：${plan.fieldConflicts.length} 处字段冲突、${plan.deleteConflicts.length} 处删除冲突待裁决`);
    conflictOpen.value = true;
  } else {
    MessagePlugin.error(result.error ?? '同步包读取失败');
  }
};

const resume = () => {
  const result = store.resumePendingMerge();
  if (result.ok) conflictOpen.value = true;
  else MessagePlugin.error(result.error ?? '恢复失败');
};

const saveName = () => {
  store.setReplicaName(nameDraft.value);
  nameDraft.value = store.replicaName;
  editingName.value = false;
};

const toggleFailStage = (stage: string) => {
  store.failStage = store.failStage === stage ? '' : stage;
};

const pendingSince = computed(() => store.pendingMerge ? new Date(store.pendingMerge.savedAt).toLocaleString('zh-CN') : '');
</script>

<template>
  <t-dialog v-model:visible="visible" header="离线副本同步中心" width="760px" :footer="false">
    <div class="sync-center">
      <section class="sync-section replica-card">
        <div class="sync-section-head">
          <div>
            <span class="eyebrow">REPLICA IDENTITY · 副本身份</span>
            <h3 v-if="!editingName">{{ store.replicaName }}</h3>
            <div v-else class="rename-row">
              <t-input v-model="nameDraft" size="small" maxlength="24" />
              <t-button size="small" theme="primary" @click="saveName">保存</t-button>
              <t-button size="small" variant="text" @click="editingName = false; nameDraft = store.replicaName">取消</t-button>
            </div>
            <p>副本标识 {{ store.replicaId }} · 用于在版本向量中标明每处修改的来源，合并后可追溯到具体副本。</p>
          </div>
          <t-button v-if="!editingName" size="small" variant="outline" @click="editingName = true; nameDraft = store.replicaName">重命名副本</t-button>
        </div>
      </section>

      <section class="sync-section">
        <div class="sync-section-head compact">
          <div><h3>① 离线外出：导出同步包</h3><p>田野断网期间把本副本的词条与撤下墓碑打包；回来后同事导入即可逐字段合并。</p></div>
          <t-button theme="primary" @click="exportSyncBundle">导出同事同步包</t-button>
        </div>
      </section>

      <section class="sync-section">
        <div class="sync-section-head compact">
          <div><h3>② 回到网络：读入同事同步包</h3><p>同一词条两边都改过的字段会并排保留两版；审校意见、已确认内容不会被旧副本覆盖。</p></div>
          <t-button variant="outline" @click="pickFile">选择同事的同步包</t-button>
          <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
        </div>
      </section>

      <t-alert v-if="store.pendingMerge" theme="warning" class="pending-alert" :title="`存在未完成的合并（来自副本“${store.pendingMerge.bundle.replicaName}”）`">
        <template #default>
          <div class="pending-box">
            <p>保存于 {{ pendingSince }} · 当前阶段：{{ store.pendingMerge.stage }}<template v-if="store.pendingMerge.failurePoint"><br />失败位置：{{ store.pendingMerge.failurePoint }}</template></p>
            <div class="pending-actions">
              <t-button size="small" theme="primary" @click="resume">恢复并再次合并</t-button>
              <t-button size="small" variant="outline" @click="store.discardPendingMerge()">放弃（本地数据不动）</t-button>
            </div>
          </div>
        </template>
      </t-alert>

      <section v-if="store.keptDeletions.length" class="sync-section">
        <h3>撤下复核</h3>
        <p class="section-hint">这些撤下请求与本地（或对方）的继续编辑冲突，已被拦下，词条没有被悄悄恢复或删除。</p>
        <div v-for="kept in store.keptDeletions" :key="kept.id" class="kept-row">
          <div>
            <strong>{{ kept.headword }}</strong>
            <span>{{ kept.direction === 'remote-deletes-local-edited' ? `对方“${kept.deletedByName}”撤下，本地有继续编辑` : `本地撤下后，对方“${kept.deletedByName}”仍有编辑` }} · 撤下于 {{ new Date(kept.deletedAt).toLocaleString('zh-CN') }}</span>
          </div>
          <div class="kept-choices">
            <t-button size="small" theme="danger" variant="outline" @click="store.resolveKeptDeletion(kept.id, 'remove')">确认撤下</t-button>
            <t-button size="small" theme="success" variant="outline" @click="store.resolveKeptDeletion(kept.id, 'keep')">保留词条</t-button>
          </div>
        </div>
      </section>

      <section class="sync-section">
        <h3>合并记录</h3>
        <div v-if="!store.mergeReports.length" class="report-empty">还没有合并记录。</div>
        <div v-for="report in store.mergeReports.slice(0, 8)" :key="report.id" class="report-row" :class="{ failed: !report.ok }">
          <div class="report-dot" :class="report.ok ? 'ok' : 'fail'" />
          <div class="report-body">
            <header>
              <strong>{{ report.ok ? '合并完成' : `合并失败 · ${report.stage}` }}</strong>
              <span>来自副本 {{ report.peerName }}</span>
              <time>{{ new Date(report.at).toLocaleString('zh-CN') }}</time>
            </header>
            <p>{{ report.detail }}</p>
            <small v-if="report.ok">{{ statsText(report.stats) }}</small>
            <small v-else class="failure-point">失败位置：{{ report.failurePoint }}</small>
          </div>
        </div>
      </section>

      <section class="sync-section demo-section">
        <h3>断网/中断演练</h3>
        <p class="section-hint">选择一个阶段后再导入同步包，可模拟该阶段失败：本地改动与失败位置会保留，随时恢复重试。</p>
        <t-radio-group v-model="store.failStage" size="small" variant="default-filled">
          <t-radio-button value="">不模拟失败</t-radio-button>
          <t-radio-button value="读取同步包">读取时断网</t-radio-button>
          <t-radio-button value="字段冲突裁决">裁决中断开</t-radio-button>
          <t-radio-button value="写入合并结果">写入时失败</t-radio-button>
          <t-radio-button value="恢复待合并">恢复时再失败</t-radio-button>
        </t-radio-group>
      </section>
    </div>

    <ConflictMergeDialog v-model="conflictOpen" />
  </t-dialog>
</template>
