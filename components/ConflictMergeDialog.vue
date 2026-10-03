<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useDictionaryStore } from '~/store/dictionary';
import { FIELD_LABELS, formatRev } from '~/utils/sync';
import type { FieldConflict } from '~/utils/sync';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();

const local = computed(() => ({ id: store.replicaId, name: store.replicaName }));
const plan = computed(() => store.activePlan);
const pending = computed(() => store.pendingMerge);

// 对话框内的选择直接写回持久化的 pendingMerge，失败或关闭后裁决不丢。
const fieldChoice = (conflict: FieldConflict) => pending.value?.decisions[conflict.key];
const deleteChoice = (key: string) => pending.value?.deleteDecisions[key];

const groupedFields = computed(() => {
  const groups = new Map<string, { headword: string; items: FieldConflict[] }>();
  plan.value?.fieldConflicts.forEach((conflict) => {
    const group = groups.get(conflict.entryId) ?? { headword: conflict.headword, items: [] };
    group.items.push(conflict);
    groups.set(conflict.entryId, group);
  });
  return [...groups.entries()].map(([entryId, group]) => ({ entryId, ...group }));
});

// 字段冲突必须逐一显式选择；删除冲突有安全默认值（界面已预选），计入已裁决。
const fieldDecided = computed(() => (plan.value?.fieldConflicts ?? []).filter((conflict) => fieldChoice(conflict)).length);
const totalFieldConflicts = computed(() => plan.value?.fieldConflicts.length ?? 0);
const deleteDecided = computed(() => (plan.value?.deleteConflicts ?? []).filter((conflict) => deleteChoice(conflict.key)).length);
const totalDeleteConflicts = computed(() => plan.value?.deleteConflicts.length ?? 0);
const totalConflicts = computed(() => totalFieldConflicts.value + totalDeleteConflicts.value);
const decidedCount = computed(() => fieldDecided.value + deleteDecided.value + (totalDeleteConflicts.value - deleteDecided.value));

const chooseAll = (choice: 'local' | 'remote') => {
  plan.value?.fieldConflicts.forEach((conflict) => store.setDecision(conflict.key, choice));
};

const apply = () => {
  const result = store.applyPendingMerge();
  if (result.ok) {
    MessagePlugin.success('合并完成，版本记录已注明合并来源副本');
    visible.value = false;
  } else {
    MessagePlugin.error(result.error ?? '合并失败，本地改动已保留，可恢复重试');
    visible.value = false; // 回到同步中心，通过“恢复并再次合并”继续
  }
};

watch(visible, (open) => {
  if (open && pending.value && !plan.value) store.resumePendingMerge();
});
</script>

<template>
  <t-dialog v-model:visible="visible" header="合并冲突裁决：逐字段选择事实版本" width="1080px" :footer="false" :close-on-overlay-click="false">
    <div v-if="plan && pending" class="conflict-dialog">
      <div class="conflict-summary">
        <div class="conflict-peer">
          <span class="eyebrow">MERGE FROM</span>
          <strong>{{ plan.bundle.replicaName }}</strong>
          <small>同步包导出于 {{ new Date(plan.bundle.exportedAt).toLocaleString('zh-CN') }}</small>
        </div>
        <div class="conflict-stat"><strong>{{ plan.previewStats.added }}</strong><span>新增词条</span></div>
        <div class="conflict-stat"><strong>{{ plan.previewStats.fieldsAutoRemote }}</strong><span>自动接收较新字段</span></div>
        <div class="conflict-stat"><strong>{{ plan.previewStats.tombstonesApplied }}</strong><span>应用撤下</span></div>
        <div class="conflict-stat"><strong>{{ plan.previewStats.resurrectionsBlocked }}</strong><span>拦下悄悄复活</span></div>
        <div class="conflict-stat warn"><strong>{{ totalConflicts }}</strong><span>待裁决冲突（{{ decidedCount }}/{{ totalConflicts }}）</span></div>
      </div>

      <t-alert v-if="!totalConflicts" theme="success" title="没有分叉冲突，双方修改处于同一条因果线上" class="conflict-alert">
        旧副本的内容不会覆盖新修改；可以直接完成合并。
      </t-alert>

      <div class="conflict-scroll">
        <section v-if="plan.deleteConflicts.length" class="conflict-group">
          <h3><span class="group-tag danger">撤下冲突</span> 撤下与继续编辑同时发生（{{ plan.deleteConflicts.length }}）</h3>
          <article v-for="conflict in plan.deleteConflicts" :key="conflict.key" class="delete-conflict-card">
            <div class="delete-conflict-head">
              <strong>{{ conflict.headword }}</strong>
              <t-tag size="small" theme="warning" variant="light">
                {{ conflict.direction === 'remote-deletes-local-edited' ? '对方撤下 · 本地仍在编辑' : '本地撤下 · 对方仍在编辑' }}
              </t-tag>
            </div>
            <div class="delete-conflict-detail">
              <p>撤下请求：{{ conflict.deletedByName }} 于 {{ new Date(conflict.deletedAt).toLocaleString('zh-CN') }} 撤下此词条</p>
              <p v-if="conflict.editedByName">继续编辑：{{ conflict.editedByName }} 最后修改于 {{ conflict.editedAt ? new Date(conflict.editedAt).toLocaleString('zh-CN') : '—' }}</p>
            </div>
            <t-radio-group :model-value="deleteChoice(conflict.key) ?? conflict.defaultChoice" variant="default-filled" size="small" @change="(value: string | number) => store.setDeleteDecision(conflict.key, value as 'keep' | 'remove')">
              <t-radio-button value="keep">保留词条（撤下不生效）</t-radio-button>
              <t-radio-button value="remove">确认撤下（不恢复）</t-radio-button>
            </t-radio-group>
          </article>
        </section>

        <section v-if="groupedFields.length" class="conflict-group">
          <div class="field-group-head">
            <h3><span class="group-tag">字段冲突</span> 两边都改过同一字段，两版均已保留（{{ plan.fieldConflicts.length }}）</h3>
            <div class="bulk-actions">
              <t-button size="small" variant="text" @click="chooseAll('local')">全部采用本副本</t-button>
              <t-button size="small" variant="text" @click="chooseAll('remote')">全部采用对方</t-button>
            </div>
          </div>

          <article v-for="group in groupedFields" :key="group.entryId" class="entry-conflict-card">
            <header><strong>{{ group.headword }}</strong><span>{{ group.items.length }} 个字段分叉</span></header>
            <div v-for="conflict in group.items" :key="conflict.key" class="field-conflict-row">
              <div class="conflict-field-name"><strong>{{ FIELD_LABELS[conflict.field] ?? conflict.field }}</strong><small>按来源副本与修改时间并列两版</small></div>
              <div class="conflict-version local" :class="{ picked: fieldChoice(conflict) === 'local' }">
                <label><input type="radio" :name="conflict.key" :checked="fieldChoice(conflict) === 'local'" @change="store.setDecision(conflict.key, 'local')" />
                  <span class="version-meta">本副本 · {{ formatRev(conflict.localRev) }}</span></label>
                <p>{{ conflict.localValue || '（空）' }}</p>
              </div>
              <div class="conflict-version remote" :class="{ picked: fieldChoice(conflict) === 'remote' }">
                <label><input type="radio" :name="conflict.key" :checked="fieldChoice(conflict) === 'remote'" @change="store.setDecision(conflict.key, 'remote')" />
                  <span class="version-meta">{{ plan.bundle.replicaName }} · {{ formatRev(conflict.remoteRev) }}</span></label>
                <p>{{ conflict.remoteValue || '（空）' }}</p>
              </div>
              <div v-if="conflict.canCombine" class="conflict-version combine" :class="{ picked: fieldChoice(conflict) === 'combine' }">
                <label><input type="radio" :name="conflict.key" :checked="fieldChoice(conflict) === 'combine'" @change="store.setDecision(conflict.key, 'combine')" />
                  <span class="version-meta">两版拼接（同义词自动去重并集）</span></label>
                <p>{{ conflict.localValue }}<template v-if="conflict.localValue && conflict.remoteValue">；</template>{{ conflict.remoteValue }}</p>
              </div>
              <div v-else class="conflict-version combine disabled"><span class="version-meta">枚举字段不支持拼接，请二选一</span></div>
            </div>
          </article>
        </section>
      </div>

      <div class="conflict-footer">
        <p>选择会随未完成合并一起保存在浏览器；若此时断网或写入失败，可用“恢复并再次合并”继续。</p>
        <div class="dialog-actions">
          <t-button variant="outline" @click="store.cancelMerge(); visible = false">取消</t-button>
          <t-button theme="primary" :disabled="fieldDecided < totalFieldConflicts" @click="apply">
            {{ totalFieldConflicts ? `完成合并（字段冲突已裁决 ${fieldDecided}/${totalFieldConflicts}）` : '无字段冲突，直接合并' }}
          </t-button>
        </div>
      </div>
    </div>
    <t-empty v-else description="没有待裁决的合并方案" />
  </t-dialog>
</template>
