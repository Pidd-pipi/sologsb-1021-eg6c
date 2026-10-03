<script setup lang="ts">
import { ref, watch } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';
import type { MergeReport } from '~/types/dictionary';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();
const sourceName = ref('');
const payload = ref('');
const fileName = ref('');
const report = ref<MergeReport | null>(null);
const failed = ref(false);

watch(visible, (open) => {
  if (!open) return;
  sourceName.value = '';
  payload.value = '';
  fileName.value = '';
  report.value = null;
  failed.value = false;
});

const pickFile = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  if (!sourceName.value) sourceName.value = file.name.replace(/\.json$/i, '');
  file.text().then((text) => { payload.value = text; });
};

const runMerge = () => {
  if (!payload.value.trim()) return;
  const result = store.importAndMerge(payload.value, sourceName.value);
  report.value = result;
  failed.value = !result;
};

const retry = () => {
  const result = store.retryMerge();
  report.value = result;
  failed.value = !result;
};

const editAndRetry = () => {
  payload.value = store.mergeFailure?.payload ?? payload.value;
  sourceName.value = store.mergeFailure?.sourceName ?? sourceName.value;
  failed.value = false;
  report.value = null;
};

const close = () => { visible.value = false; };
</script>

<template>
  <t-dialog v-model:visible="visible" header="合并同事副本" width="720px" :footer="false">
    <div v-if="!report && !failed" class="copy-merge">
      <p class="merge-hint">选择同事导出的备份 JSON，或直接把文件内容粘贴到下方。合并逐字段比对：两边都改过的字段会保留两版并标注来源与时间，由编辑选择事实版本。</p>
      <div class="merge-form">
        <label class="field-block"><span>副本名称（写入版本记录，标明合并来源）</span>
          <t-input v-model="sourceName" placeholder="例如：和老师的副本 · 2026-10" />
        </label>
        <label class="file-picker">
          <input type="file" accept=".json,application/json" @change="pickFile" />
          <span>{{ fileName || '选择备份文件…' }}</span>
        </label>
        <t-textarea v-model="payload" :autosize="{ minRows: 8, maxRows: 14 }" placeholder='粘贴同事副本的 JSON 内容（{"entries": [...]}）' />
      </div>
      <div class="dialog-actions">
        <t-button variant="outline" @click="close">取消</t-button>
        <t-button theme="primary" :disabled="!payload.trim()" @click="runMerge">开始合并</t-button>
      </div>
    </div>

    <div v-else-if="failed" class="copy-merge">
      <t-alert theme="error" :message="`合并失败：${store.mergeFailure?.error ?? '未知错误'}`" />
      <div class="failure-detail">
        <div><strong>失败位置</strong><span>{{ store.mergeFailure?.position }}</span></div>
        <div><strong>副本</strong><span>{{ store.mergeFailure?.sourceName }}</span></div>
        <div><strong>时间</strong><span>{{ store.mergeFailure ? new Date(store.mergeFailure.at).toLocaleString('zh-CN') : '' }}</span></div>
      </div>
      <p class="merge-hint">本地改动已完整保留，未应用任何部分结果。修正副本文件后可以重新合并，失败记录会保留到成功或手动放弃为止。</p>
      <div class="dialog-actions">
        <t-button variant="outline" theme="danger" @click="store.discardMergeFailure(); close">放弃这次合并</t-button>
        <t-button variant="outline" @click="editAndRetry">修改后重试</t-button>
        <t-button theme="primary" @click="retry">按原内容重试</t-button>
      </div>
    </div>

    <div v-else-if="report" class="copy-merge">
      <t-alert theme="success" :message="`已合并来自「${report.sourceName}」的副本，版本记录已注明来源`" />
      <div class="report-grid">
        <div><strong>{{ report.added }}</strong><span>新增词条</span></div>
        <div><strong>{{ report.merged }}</strong><span>共同词条</span></div>
        <div><strong>{{ report.conflicts }}</strong><span>待选择冲突</span></div>
        <div><strong>{{ report.protectedNotes.length }}</strong><span>保护性保留</span></div>
      </div>
      <div v-if="report.protectedNotes.length" class="report-notes">
        <h4>保护性保留（审校意见与已确认内容未被旧副本覆盖）</h4>
        <p v-for="note in report.protectedNotes" :key="note">{{ note }}</p>
      </div>
      <div v-if="report.withdrawnNotes.length" class="report-notes">
        <h4>撤下记录</h4>
        <p v-for="note in report.withdrawnNotes" :key="note">{{ note }}</p>
      </div>
      <p v-if="report.conflicts" class="merge-hint">冲突字段已保留两版并标注来源与时间，请在“合并冲突”面板中逐字段选择事实版本。</p>
      <div class="dialog-actions">
        <t-button theme="primary" @click="close">完成</t-button>
      </div>
    </div>
  </t-dialog>
</template>
