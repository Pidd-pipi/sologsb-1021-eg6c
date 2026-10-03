<script setup lang="ts">
import { computed } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();

const grouped = computed(() => {
  const groups = new Map<string, { entryHeadword: string; items: typeof store.conflicts }>();
  store.conflicts.forEach((conflict) => {
    const group = groups.get(conflict.entryId) ?? { entryHeadword: conflict.entryHeadword, items: [] as typeof store.conflicts };
    group.items.push(conflict);
    groups.set(conflict.entryId, group);
  });
  return [...groups.values()];
});

const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN');
</script>

<template>
  <t-drawer v-model:visible="visible" header="合并冲突 · 逐字段选择事实版本" size="640px" :footer="false">
    <div class="conflict-drawer">
      <div class="conflict-intro">
        <strong>{{ store.conflicts.length }}</strong><span>处待选择冲突</span>
        <p>同一词条在两边都改过的字段会保留两版，按来源副本和修改时间标明。选择前词条保持本地版本，审校意见与已确认内容不会被旧副本覆盖。</p>
        <div v-if="store.conflicts.length" class="batch-actions">
          <t-button size="small" variant="outline" @click="store.resolveAllConflicts('local')">全部保留本地</t-button>
          <t-button size="small" variant="outline" @click="store.resolveAllConflicts('remote')">全部采用对方副本</t-button>
        </div>
      </div>

      <section v-for="group in grouped" :key="group.entryHeadword" class="conflict-group">
        <h3>{{ group.entryHeadword }}</h3>
        <article v-for="conflict in group.items" :key="conflict.id" class="conflict-card">
          <header>
            <t-tag size="small" variant="light" :theme="conflict.kind === 'restore' ? 'danger' : 'warning'">{{ conflict.fieldLabel }}</t-tag>
            <span>合并自「{{ conflict.sourceName }}」 · {{ formatTime(conflict.mergedAt) }}</span>
          </header>
          <div class="conflict-compare">
            <div class="conflict-side">
              <div class="side-head"><strong>本地副本</strong><time>{{ formatTime(conflict.localAt) }}</time></div>
              <pre>{{ conflict.localText }}</pre>
              <t-button size="small" variant="outline" @click="store.resolveConflict(conflict.id, 'local')">采用本地</t-button>
            </div>
            <div class="conflict-side remote">
              <div class="side-head"><strong>副本 · {{ conflict.sourceName }}</strong><time>{{ formatTime(conflict.remoteAt) }}</time></div>
              <pre>{{ conflict.remoteText }}</pre>
              <t-button size="small" variant="outline" @click="store.resolveConflict(conflict.id, 'remote')">{{ conflict.kind === 'restore' ? '恢复该词条' : '采用对方' }}</t-button>
            </div>
          </div>
        </article>
      </section>

      <t-empty v-if="!store.conflicts.length" description="没有待处理的合并冲突；合并副本时两边都改过的字段会出现在这里" />
    </div>
  </t-drawer>
</template>
