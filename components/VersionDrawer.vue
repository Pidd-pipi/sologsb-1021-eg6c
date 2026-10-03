<script setup lang="ts">
import { computed } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();
const revisions = computed(() => store.versions);
const diff = (before: typeof store.entries) => {
  const beforeMap = new Map(before.map((entry) => [entry.id, entry]));
  const afterMap = new Map(store.entries.map((entry) => [entry.id, entry]));
  let changed = 0;
  afterMap.forEach((entry, id) => {
    const old = beforeMap.get(id);
    if (!old || JSON.stringify(old) !== JSON.stringify(entry)) changed += 1;
  });
  const removed = before.filter((entry) => !afterMap.has(entry.id)).length;
  return { changed, removed, added: store.entries.filter((entry) => !beforeMap.has(entry.id)).length };
};
</script>

<template>
  <t-drawer v-model:visible="visible" header="版本记录" size="560px" :footer="false">
    <div class="version-drawer">
      <div class="version-intro"><strong>{{ revisions.length }}</strong><span>个可恢复版本</span><p>每次字段编辑、状态变更、合并或删除都会在提交前保存完整快照。</p></div>
      <div class="version-list">
        <article v-for="version in revisions" :key="version.id" class="version-item" :class="{ 'merge-version': version.mergeFrom }">
          <div class="version-line"><span class="version-dot" :class="{ merge: version.mergeFrom }" /><time>{{ new Date(version.at).toLocaleString('zh-CN') }}</time></div>
          <strong>{{ version.action }}</strong>
          <p>{{ version.detail }}</p>
          <div v-if="version.mergeFrom" class="merge-origin-line">
            本次合并来自副本：<strong>{{ version.mergeFrom.peerName }}</strong>
            <span>（对方导出于 {{ new Date(version.mergeFrom.bundleAt).toLocaleString('zh-CN') }} · id {{ version.mergeFrom.peerId }}）</span>
          </div>
          <div class="diff-line"><span>新增 {{ diff(version.before).added }}</span><span>修改 {{ diff(version.before).changed }}</span><span>删除 {{ diff(version.before).removed }}</span></div>
          <t-button size="small" variant="outline" @click="store.restoreVersion(version.id); visible = false">恢复到此版本</t-button>
        </article>
        <t-empty v-if="!revisions.length" description="编辑词条后，版本记录会出现在这里" />
      </div>
      <div class="audit-section">
        <h3>最近操作</h3>
        <div v-for="item in store.audit.slice(0, 12)" :key="item.id" class="audit-line"><time>{{ new Date(item.at).toLocaleString('zh-CN') }}</time><div><strong>{{ item.action }}</strong><span>{{ item.detail }}</span></div></div>
      </div>
    </div>
  </t-drawer>
</template>
