/* store 端到端：合并失败保留本地改动与失败位置，恢复后再次合并；版本记录注明来源副本。
   运行：node scripts/test-store.mjs（jiti 负责加载 TS 与 ~ 别名） */
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
const jiti = createJiti(fileURLToPath(import.meta.url), { alias: { '~': process.cwd() } });
const { useDictionaryStore } = jiti('../store/dictionary.ts');
const { vvInc, newFieldRevision } = jiti('../utils/sync.ts');
const { createPinia, setActivePinia } = jiti('pinia');

let passed = 0;
const check = (name, cond, extra = '') => {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1; }
  else { passed += 1; console.log(`✓ ${name}`); }
};

/* ---- 浏览器 localStorage 桩 ---- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

const freshStore = () => {
  setActivePinia(createPinia());
  const store = useDictionaryStore();
  store.hydrateFromBrowser();
  return store;
};

const jsonFile = (value) => ({ text: async () => JSON.stringify(value) });
const later = new Date(Date.now() + 3600_000).toISOString();

/* 构造“同事副本”：基于共同基点包分叉，改同一字段 + 带新词条 + 不撤下任何词。 */
const buildRemote = (baseBundle, localReplica) => {
  const remote = JSON.parse(JSON.stringify(baseBundle));
  remote.replicaId = 'replica-REMOTE';
  remote.replicaName = '同事丙';
  const e1 = remote.entries.find((e) => e.id === 'entry-001');
  e1.vv = vvInc(e1.vv, 'replica-REMOTE');
  e1.definition = '同事丙改的释义';
  e1.fieldRevisions.definition = newFieldRevision('replica-REMOTE', '同事丙', later, e1.vv);
  e1.updatedAt = later;
  const vv = { 'replica-REMOTE': 1 };
  const mk = (field, value) => newFieldRevision('replica-REMOTE', '同事丙', later, vv);
  remote.entries.push({
    id: 'entry-remote-1', headword: '远方新词', pronunciation: '', partOfSpeech: '名词',
    definition: '同事离线期间新调查的词条', dialectVariants: [], examples: [], sources: [],
    synonyms: [], status: 'draft', notes: '', createdAt: later, updatedAt: later, reviewerComments: [],
    vv, fieldRevisions: {
      headword: mk('headword'), pronunciation: mk('pronunciation'), partOfSpeech: mk('partOfSpeech'),
      definition: mk('definition'), notes: mk('notes'), synonyms: mk('synonyms'), status: mk('status')
    }
  });
  return remote;
};

/* ================= 场景 A：写入失败 → 恢复 → 再合并成功 ================= */
{
  const store = freshStore();
  const localReplica = store.replicaId;

  // 共同基点（下田出发时两份副本一致）。
  const baseBundle = JSON.parse(JSON.stringify(store.buildSyncBundle()));

  // 本地继续工作：改释义 + 撤下 entry-002。
  store.updateField('entry-001', 'definition', '本地调查员改的释义', '释义');
  store.deleteEntry('entry-002');
  const localDefBefore = store.entries.find((e) => e.id === 'entry-001').definition;
  const localEntryCount = store.entries.length;

  const remote = buildRemote(baseBundle, localReplica);
  const received = await store.receiveSyncFile(jsonFile(remote));
  check('A 读取对方同步包成功', received.ok === true);
  check('A 检出同一字段分叉冲突', store.activePlan.fieldConflicts.some((c) => c.entryId === 'entry-001' && c.field === 'definition'));
  check('A 冲突两版均保留并标明来源', store.activePlan.fieldConflicts.some((c) => c.localValue.includes('本地') && c.remoteValue.includes('同事丙')));
  check('A 撤下不触发复活冲突（远程是旧副本）', !store.activePlan.deleteConflicts.some((c) => c.entryId === 'entry-002'));

  const conflict = store.activePlan.fieldConflicts.find((c) => c.entryId === 'entry-001' && c.field === 'definition');
  store.setDecision(conflict.key, 'remote');

  // 写入阶段失败（模拟断网/写入中断）。
  store.failStage = '写入合并结果';
  const failed = store.applyPendingMerge();
  check('A 写入失败有返回', failed.ok === false);
  check('A 失败后本地改动原样保留', store.entries.find((e) => e.id === 'entry-001').definition === localDefBefore);
  check('A 失败后词条数量不变', store.entries.length === localEntryCount);
  check('A 失败位置被记录', store.pendingMerge?.failurePoint?.includes('写入合并结果'));
  check('A 失败阶段被记录', store.pendingMerge?.stage === '写入合并结果');
  check('A 失败后仍有未完成合并', !!store.pendingMerge);
  check('A 已裁决内容随未完成合并保留', store.pendingMerge.decisions[conflict.key] === 'remote');
  check('A 合并报告标记失败', store.mergeReports[0]?.ok === false && store.mergeReports[0].stage === '写入合并结果');

  // 网络恢复：恢复并再次合并（裁决进度还在）。
  store.failStage = '';
  const resumed = store.resumePendingMerge();
  check('A 恢复未完成合并成功', resumed.ok === true);
  const done = store.applyPendingMerge();
  check('A 再次合并成功', done.ok === true);
  check('A 采用了对方字段版本', store.entries.find((e) => e.id === 'entry-001').definition === '同事丙改的释义');
  check('A 远程新词收入', store.entries.some((e) => e.id === 'entry-remote-1'));
  check('A 撤下的词条没有悄悄恢复', !store.entries.some((e) => e.id === 'entry-002'));
  check('A 未完成合并已清空', store.pendingMerge === null);
  check('A 版本记录注明合并来自哪个副本', store.versions[0].action === '合并同事副本' && store.versions[0].mergeFrom?.peerName === '同事丙');
  check('A 版本记录保留对方导出时间', !!store.versions[0].mergeFrom.bundleAt);
  check('A 成功合并报告', store.mergeReports[0]?.ok === true);
  check('A 审计记录说明来源副本', store.audit[0].detail.includes('同事丙'));
}

/* ================= 场景 B：读取阶段失败后恢复 ================= */
{
  const store = freshStore();
  const baseBundle = JSON.parse(JSON.stringify(store.buildSyncBundle()));
  store.updateField('entry-003', 'notes', '本地补充');
  const remote = buildRemote(baseBundle, store.replicaId);
  store.failStage = '读取同步包';
  const r1 = await store.receiveSyncFile(jsonFile(remote));
  check('B 读取阶段失败', r1.ok === false);
  check('B 失败位置持久化', store.pendingMerge?.failurePoint?.includes('读取同步包'));
  check('B 本地数据未动', store.entries.find((e) => e.id === 'entry-003').notes === '本地补充');
  store.failStage = '';
  const r2 = store.resumePendingMerge();
  check('B 恢复后可继续裁决', r2.ok === true && !!store.activePlan);
  store.discardPendingMerge();
  check('B 放弃后无未完成合并', store.pendingMerge === null);
}

/* ================= 场景 C：校验失败不动本地 ================= */
{
  const store = freshStore();
  const count = store.entries.length;
  const own = store.buildSyncBundle(); // 自己的包
  const r = await store.receiveSyncFile(jsonFile(own));
  check('C 拒绝与自己的副本合并', r.ok === false);
  check('C 校验失败不产生未完成合并', store.pendingMerge === null);
  check('C 校验失败不改动本地', store.entries.length === count);
  check('C 失败仍留合并记录', store.mergeReports[0]?.ok === false && store.mergeReports[0].stage === '校验同步包');
}

console.log(`\n${passed} 项通过`);
