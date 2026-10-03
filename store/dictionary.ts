import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  AuditRecord, DictionaryEntry, DictionarySnapshot, DuplicatePair, EntryStatus,
  EntryTombstone, KeptDeletion, MergeReport, PendingMerge, ReviewComment, SyncBundle, VersionRecord
} from '~/types/dictionary';
import { findDuplicates } from '~/utils/dictionary';
import {
  computeMerge, createReplicaId, newFieldRevision, validateBundle,
  vvCopy, vvInc, type MergePlan, type ScalarField
} from '~/utils/sync';

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const REPLICA_KEY = 'sologsb-1021-replica-v1';

const ensureReplica = (): { id: string; name: string } => {
  let id = '';
  let name = '';
  try {
    const raw = localStorage.getItem(REPLICA_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: string; name?: string };
      id = parsed.id ?? '';
      name = parsed.name ?? '';
    }
  } catch { /* ignore */ }
  if (!id) id = createReplicaId();
  if (!name) name = `田野副本-${id.slice(-4)}`;
  try { localStorage.setItem(REPLICA_KEY, JSON.stringify({ id, name })); } catch { /* ignore */ }
  return { id, name };
};

/** 为旧版数据（无版本向量）补齐合并所需字段。 */
const normalizeEntry = (entry: DictionaryEntry, replicaId: string): DictionaryEntry => {
  const normalized: DictionaryEntry = {
    ...entry,
    dialectVariants: clone(entry.dialectVariants ?? []),
    examples: clone(entry.examples ?? []),
    sources: clone(entry.sources ?? []),
    synonyms: clone(entry.synonyms ?? []),
    reviewerComments: clone(entry.reviewerComments ?? []),
    vv: clone(entry.vv ?? {}),
    fieldRevisions: clone(entry.fieldRevisions ?? {})
  };
  if (!normalized.vv[replicaId]) normalized.vv[replicaId] = 1;
  const baseAt = normalized.updatedAt || normalized.createdAt || now();
  (['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes', 'synonyms', 'status'] as ScalarField[]).forEach((field) => {
    if (!normalized.fieldRevisions[field]) {
      normalized.fieldRevisions[field] = { vv: vvCopy(normalized.vv), by: 'legacy-seed', byName: '初始记录', at: baseAt };
    }
  });
  return normalized;
};

const seedEntries = (replicaId: string): DictionaryEntry[] => ([
  {
    id: 'entry-001', headword: 'ŋgɨ³³', pronunciation: 'ŋgɨ˧˧（低平调）', partOfSpeech: '名词', definition: '山间常年不涸的小水潭；也用来比喻安静而可靠的人。',
    dialectVariants: [
      { id: 'v-1', dialect: '北坡话', form: 'ŋgɨ³³ tsha⁵⁵', pronunciation: 'ŋgɨ tsha', note: '强调泉水源头' },
      { id: 'v-2', dialect: '河谷话', form: 'a³³ ŋgɨ³³', pronunciation: 'a ŋgɨ', note: '前缀形式' }
    ],
    examples: [
      { id: 'ex-1', text: 'a³³ ŋgɨ³³ ma³³ ʔmɨ⁵⁵.', translation: '这个小水潭是甜的。', source: '民间故事·寻找水源' },
      { id: 'ex-2', text: 'ŋgɨ³³ tɕi⁵⁵ dza³³.', translation: '山泉到了冬天也不会干。', source: '访谈录音 2018-04' }
    ],
    sources: [
      { id: 'src-1', title: '北坡方言词汇表', citation: '李某某记录，1987，手稿第 42 页', url: '' },
      { id: 'src-2', title: '嘎木村发音人访谈', citation: '录音 A-2018-04-17，00:12:31', url: '' }
    ],
    synonyms: ['水潭', '泉水'], status: 'confirmed', notes: '声调标音经两位发音人复核。', createdAt: '2024-08-11T04:00:00.000Z', updatedAt: '2025-03-09T06:12:00.000Z', reviewerComments: [], vv: {}, fieldRevisions: {}
  },
  {
    id: 'entry-002', headword: 'dʑa⁵⁵', pronunciation: 'dʑa˥（高平调）', partOfSpeech: '动词', definition: '把谷物摊开晾晒；引申为耐心等待事情成熟。',
    dialectVariants: [{ id: 'v-3', dialect: '东南村话', form: 'dʑa⁵⁵ ka³³', pronunciation: 'dʑa ka', note: '带结果补语 habitual 形式' }],
    examples: [{ id: 'ex-3', text: 'kho⁵⁵ dʑa⁵⁵ tɕhi³³.', translation: '谷子已经摊开晒了。', source: '田野记录 2023-09-12' }],
    sources: [{ id: 'src-3', title: '东南村生产词调查', citation: '王某某，2023，词条 071', url: '' }],
    synonyms: ['晒', '等待'], status: 'review', notes: '“等待”的引申义需由审校人确认。', createdAt: '2024-10-01T06:00:00.000Z', updatedAt: '2025-02-18T02:00:00.000Z',
    reviewerComments: [{ id: 'c-1', field: 'definition', author: '主审·和老师', message: '“等待”是短语层面的临时义还是固定引申义？请补充一条例句。', status: 'open', createdAt: '2025-02-18T02:00:00.000Z', replies: [] }],
    vv: {}, fieldRevisions: {}
  },
  {
    id: 'entry-003', headword: 'dʑa³³', pronunciation: 'dʑa˧（中调）', partOfSpeech: '动词', definition: '摊晒谷物，使水分蒸发。', dialectVariants: [], examples: [{ id: 'ex-4', text: 'dʑa³³ ko⁵⁵ kho⁵⁵.', translation: '把粮食拿去晒。', source: '语音调查 M-12' }], sources: [{ id: 'src-4', title: '方言调查卡片', citation: '1992，卡片 M-12', url: '' }], synonyms: ['晒粮'], status: 'disputed', notes: '与 dʑa⁵⁵ 可能是同一词条的声调变体。', createdAt: '2024-12-01T06:00:00.000Z', updatedAt: '2025-02-20T03:00:00.000Z', reviewerComments: [], vv: {}, fieldRevisions: {}
  },
  {
    id: 'entry-004', headword: 'ʔma³³', pronunciation: 'ʔma˧', partOfSpeech: '名词', definition: '母亲；也可用于称呼年长女性亲属。', dialectVariants: [{ id: 'v-4', dialect: '河西话', form: 'ma³³', pronunciation: 'ma', note: '喉塞音弱化' }], examples: [{ id: 'ex-5', text: 'ʔma³³, ŋa⁵⁵ tɕi³³ lo³³.', translation: '妈妈，我要回家了。', source: '日常生活会话 01' }], sources: [{ id: 'src-5', title: '亲缘称谓调查', citation: '赵某某，2011，表 3', url: '' }], synonyms: ['妈妈', '母亲'], status: 'draft', notes: '需补充敬称形式。', createdAt: '2025-01-11T04:00:00.000Z', updatedAt: '2025-01-11T04:00:00.000Z', reviewerComments: [], vv: {}, fieldRevisions: {}
  },
  {
    id: 'entry-005', headword: 'lo³³', pronunciation: 'lo˧', partOfSpeech: '方向词', definition: '表示向说话者所在位置移动，常与位移动词搭配。', dialectVariants: [], examples: [{ id: 'ex-6', text: 'a³³ mɨ⁵⁵ lo³³.', translation: '到这里来。', source: '语法调查句表 03' }], sources: [{ id: 'src-6', title: '动词方向范畴笔记', citation: '陈某某，2005，第 18 页', url: '' }], synonyms: ['来'], status: 'confirmed', notes: '', createdAt: '2024-09-18T02:00:00.000Z', updatedAt: '2025-01-04T02:00:00.000Z', reviewerComments: [], vv: {}, fieldRevisions: {}
  },
  {
    id: 'entry-006', headword: 'tsha⁵⁵', pronunciation: 'tsha˥', partOfSpeech: '名词', definition: '水源；泉水涌出的地方。', dialectVariants: [], examples: [{ id: 'ex-7', text: 'tsha⁵⁵ ʔmɨ⁵⁵ ma³³.', translation: '泉眼在这个地方。', source: '地名调查 2022-07' }], sources: [{ id: 'src-7', title: '村落地名调查', citation: '录音 C-2022-07，00:22:08', url: '' }], synonyms: ['泉眼', '水潭'], status: 'review', notes: '', createdAt: '2025-02-01T02:00:00.000Z', updatedAt: '2025-02-25T02:00:00.000Z',
    reviewerComments: [{ id: 'c-2', field: 'sources', author: '审校·罗老师', message: '请把录音中发言人姓名补到资料来源。', status: 'open', createdAt: '2025-02-25T02:00:00.000Z', replies: [{ id: 'r-1', author: '编辑·阿木', message: '已向调查员索取授权信息，暂以录音编号占位。', createdAt: '2025-02-26T01:00:00.000Z' }] }],
    vv: {}, fieldRevisions: {}
  }
] as DictionaryEntry[]).map((entry) => normalizeEntry(entry, replicaId));

export const useDictionaryStore = defineStore('dictionary', () => {
  const initialReplica = (() => {
    try { return ensureReplica(); } catch { return { id: createReplicaId(), name: '田野副本' }; }
  })();

  const revision = ref(1);
  const replicaId = ref(initialReplica.id);
  const replicaName = ref(initialReplica.name);
  const entries = reactive<DictionaryEntry[]>(seedEntries(initialReplica.id));
  const tombstones = reactive<EntryTombstone[]>([]);
  const keptDeletions = reactive<KeptDeletion[]>([]);
  const versions = reactive<VersionRecord[]>([]);
  const audit = reactive<AuditRecord[]>([{
    id: 'audit-seed', at: now(), action: '载入工作区', detail: '初始化 6 个词条、2 条待回复审校意见和 1 组疑似重复词条', entryIds: []
  }]);
  const mergeReports = reactive<MergeReport[]>([]);
  const pendingMerge = ref<PendingMerge | null>(null);
  /** 当前已读取、等待编辑裁决的合并方案。 */
  const activePlan = ref<MergePlan | null>(null);
  const selectedId = ref(entries[0]?.id ?? '');
  const hydrated = ref(false);
  const undoStack = ref<DictionarySnapshot[]>([]);
  const redoStack = ref<DictionarySnapshot[]>([]);
  const query = ref('');
  const statusFilter = ref<EntryStatus | 'all'>('all');
  const dialectFilter = ref('all');
  const fieldReplyDrafts = reactive<Record<string, string>>({});
  /** 模拟断网/中断用的失败阶段开关（演示：失败后保留本地改动和失败位置）。 */
  const failStage = ref('');

  const selectedEntry = computed(() => entries.find((entry) => entry.id === selectedId.value) ?? entries[0]);
  const persistableSnapshot = computed<DictionarySnapshot>(() => ({
    revision: revision.value,
    replicaId: replicaId.value,
    replicaName: replicaName.value,
    entries: clone(entries),
    tombstones: clone(tombstones),
    keptDeletions: clone(keptDeletions),
    pendingMerge: pendingMerge.value ? clone(pendingMerge.value) : null,
    mergeReports: clone(mergeReports),
    versions: clone(versions),
    audit: clone(audit)
  }));
  const duplicates = computed<DuplicatePair[]>(() => findDuplicates(entries));
  const openComments = computed(() => entries.reduce((sum, entry) => sum + entry.reviewerComments.filter((comment) => comment.status === 'open').length, 0));
  const filteredEntries = computed(() => {
    const term = query.value.trim().toLowerCase();
    return entries.filter((entry) => {
      if (statusFilter.value !== 'all' && entry.status !== statusFilter.value) return false;
      if (dialectFilter.value !== 'all' && !entry.dialectVariants.some((variant) => variant.dialect === dialectFilter.value)) return false;
      if (!term) return true;
      const haystack = [entry.headword, entry.definition, entry.partOfSpeech, entry.pronunciation, ...entry.synonyms, ...entry.sources.map((source) => source.title)].join(' ').toLowerCase();
      return haystack.includes(term);
    });
  });
  const dialects = computed(() => [...new Set(entries.flatMap((entry) => entry.dialectVariants.map((variant) => variant.dialect)))].sort());

  function snapshot(): DictionarySnapshot {
    return {
      revision: revision.value,
      replicaId: replicaId.value,
      replicaName: replicaName.value,
      entries: clone(entries),
      tombstones: clone(tombstones),
      keptDeletions: clone(keptDeletions),
      pendingMerge: pendingMerge.value ? clone(pendingMerge.value) : null,
      mergeReports: clone(mergeReports),
      versions: clone(versions),
      audit: clone(audit)
    };
  }

  function restore(value: Partial<DictionarySnapshot>) {
    revision.value = value.revision ?? 1;
    const sourceEntries = (value.entries ?? []).map((entry) => normalizeEntry(entry, replicaId.value));
    entries.splice(0, entries.length, ...sourceEntries);
    tombstones.splice(0, tombstones.length, ...clone(value.tombstones ?? []));
    keptDeletions.splice(0, keptDeletions.length, ...clone(value.keptDeletions ?? []));
    versions.splice(0, versions.length, ...clone(value.versions ?? []));
    audit.splice(0, audit.length, ...clone(value.audit ?? []));
    mergeReports.splice(0, mergeReports.length, ...clone(value.mergeReports ?? []));
    pendingMerge.value = value.pendingMerge ? clone(value.pendingMerge) : null;
    activePlan.value = null;
    if (value.replicaId && value.replicaId !== replicaId.value) replicaId.value = value.replicaId;
    if (value.replicaName) replicaName.value = value.replicaName;
    if (!entries.some((entry) => entry.id === selectedId.value)) selectedId.value = entries[0]?.id ?? '';
  }

  /** 普通本地编辑提交：为实际变化的字段盖上“来源副本 + 时间”的修订戳。 */
  function commit(action: string, detail: string, entryIds: string[], mutation: () => void) {
    undoStack.value = [...undoStack.value.slice(-49), snapshot()];
    redoStack.value = [];
    const before = clone(entries);
    const beforeComments = new Map(entryIds.map((id) => {
      const entry = entries.find((item) => item.id === id);
      return [id, entry?.reviewerComments.map((comment) => ({ id: comment.id, status: comment.status })) ?? []];
    }));
    mutation();
    revision.value += 1;
    const stamp = now();
    entryIds.forEach((id) => {
      const after = entries.find((entry) => entry.id === id);
      const oldEntry = before.find((entry) => entry.id === id);
      if (!after || !oldEntry) return;
      const scalarChanged = (['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes', 'synonyms', 'status'] as ScalarField[])
        .some((field) => JSON.stringify(after[field]) !== JSON.stringify(oldEntry[field]));
      const collectionsChanged = ['dialectVariants', 'examples', 'sources'].some((field) =>
        JSON.stringify(after[field as keyof DictionaryEntry]) !== JSON.stringify(oldEntry[field as keyof DictionaryEntry]));
      const commentsChanged = JSON.stringify(after.reviewerComments) !== JSON.stringify(oldEntry.reviewerComments);
      if (!scalarChanged && !collectionsChanged && !commentsChanged) return;
      after.vv = vvInc(after.vv, replicaId.value);
      after.updatedAt = stamp;
      if (scalarChanged) {
        (['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes', 'synonyms', 'status'] as ScalarField[]).forEach((field) => {
          if (JSON.stringify(after[field]) !== JSON.stringify(oldEntry[field])) {
            after.fieldRevisions[field] = newFieldRevision(replicaId.value, replicaName.value, stamp, after.vv);
          }
        });
      }
      // 审校意见的解决/重开需要版本向量保护（旧副本不能覆盖）。
      if (commentsChanged) {
        const prior = new Map((beforeComments.get(id) ?? []).map((item) => [item.id, item.status]));
        after.reviewerComments.forEach((comment) => {
          if (prior.get(comment.id) && prior.get(comment.id) !== comment.status) {
            comment.vv = vvInc(comment.vv ?? oldEntry.vv, replicaId.value);
            comment.updatedAt = stamp;
          }
        });
      }
    });
    versions.unshift({ id: uid('version'), at: stamp, action, detail, entryId: entryIds[0], before: before.map((entry) => clone(entry)), beforeTombstones: clone(tombstones) });
    versions.splice(120);
    audit.unshift({ id: uid('audit'), at: stamp, action, detail, entryIds });
    audit.splice(300);
  }

  function createEntry() {
    const stamp = now();
    const entry: DictionaryEntry = {
      id: uid('entry'), headword: '新词条', pronunciation: '', partOfSpeech: '', definition: '', dialectVariants: [], examples: [], sources: [], synonyms: [], status: 'draft', notes: '', createdAt: stamp, updatedAt: stamp, reviewerComments: [],
      vv: { [replicaId.value]: 1 }, fieldRevisions: {}
    };
    (['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes', 'synonyms', 'status'] as ScalarField[]).forEach((field) => {
      entry.fieldRevisions[field] = newFieldRevision(replicaId.value, replicaName.value, stamp, entry.vv);
    });
    undoStack.value = [...undoStack.value.slice(-49), snapshot()];
    redoStack.value = [];
    entries.unshift(entry);
    revision.value += 1;
    versions.unshift({ id: uid('version'), at: stamp, action: '新建词条', detail: '创建草稿词条', entryId: entry.id, before: [], beforeTombstones: clone(tombstones) });
    audit.unshift({ id: uid('audit'), at: stamp, action: '新建词条', detail: '创建草稿词条', entryIds: [entry.id] });
    selectedId.value = entry.id;
  }

  function updateField<K extends keyof DictionaryEntry>(entryId: string, field: K, value: DictionaryEntry[K], label = String(field)) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry || JSON.stringify(entry[field]) === JSON.stringify(value)) return;
    commit('编辑字段', `${label}发生更新`, [entryId], () => { entry[field] = value; });
  }

  function setStatus(entryId: string, status: EntryStatus) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry || entry.status === status) return;
    const labels: Record<EntryStatus, string> = { draft: '草稿', review: '待审', disputed: '争议', confirmed: '已确认' };
    commit('变更状态', `词条状态改为“${labels[status]}”`, [entryId], () => { entry.status = status; });
  }

  function addVariant(entryId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    const variant = { id: uid('variant'), dialect: '', form: '', pronunciation: '', note: '' };
    commit('新增方言变体', '添加一条方言变体', [entryId], () => entry.dialectVariants.push(variant));
  }

  function updateVariant(entryId: string, variantId: string, field: 'dialect' | 'form' | 'pronunciation' | 'note', value: string) {
    const entry = entries.find((item) => item.id === entryId);
    const variant = entry?.dialectVariants.find((item) => item.id === variantId);
    if (!entry || !variant || variant[field] === value) return;
    commit('编辑方言变体', `${field}发生更新`, [entryId], () => { variant[field] = value; });
  }

  function removeVariant(entryId: string, variantId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    commit('删除方言变体', '移除一条方言变体', [entryId], () => {
      const index = entry.dialectVariants.findIndex((variant) => variant.id === variantId);
      if (index >= 0) entry.dialectVariants.splice(index, 1);
    });
  }

  function addExample(entryId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    commit('新增例句', '添加一条例句', [entryId], () => entry.examples.push({ id: uid('example'), text: '', translation: '', source: '' }));
  }

  function updateExample(entryId: string, exampleId: string, field: 'text' | 'translation' | 'source', value: string) {
    const entry = entries.find((item) => item.id === entryId);
    const example = entry?.examples.find((item) => item.id === exampleId);
    if (!entry || !example || example[field] === value) return;
    commit('编辑例句', `${field}发生更新`, [entryId], () => { example[field] = value; });
  }

  function removeExample(entryId: string, exampleId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    commit('删除例句', '移除一条例句', [entryId], () => {
      const index = entry.examples.findIndex((item) => item.id === exampleId);
      if (index >= 0) entry.examples.splice(index, 1);
    });
  }

  function addSource(entryId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    commit('新增来源', '添加一条文献或录音来源', [entryId], () => entry.sources.push({ id: uid('source'), title: '', citation: '', url: '' }));
  }

  function updateSource(entryId: string, sourceId: string, field: 'title' | 'citation' | 'url', value: string) {
    const entry = entries.find((item) => item.id === entryId);
    const source = entry?.sources.find((item) => item.id === sourceId);
    if (!entry || !source || source[field] === value) return;
    commit('编辑来源', `${field}发生更新`, [entryId], () => { source[field] = value; });
  }

  function removeSource(entryId: string, sourceId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    commit('删除来源', '移除一条来源', [entryId], () => {
      const index = entry.sources.findIndex((source) => source.id === sourceId);
      if (index >= 0) entry.sources.splice(index, 1);
    });
  }

  function setSynonyms(entryId: string, synonyms: string[]) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    commit('编辑同义词', `同义词更新为 ${synonyms.join('、') || '（空）'}`, [entryId], () => { entry.synonyms = synonyms; });
  }

  function addComment(entryId: string, field: string, message: string, author = '主审·和老师') {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry || !message.trim()) return;
    const comment: ReviewComment = { id: uid('comment'), field, author, message: message.trim(), status: 'open', createdAt: now(), replies: [], origin: replicaName.value };
    commit('新增审校意见', `对“${field}”添加审校意见`, [entryId], () => entry.reviewerComments.unshift(comment));
  }

  function replyComment(entryId: string, commentId: string, message: string, author = '编辑·阿木') {
    const entry = entries.find((item) => item.id === entryId);
    const comment = entry?.reviewerComments.find((item) => item.id === commentId);
    if (!entry || !comment || !message.trim()) return;
    commit('回复审校意见', `回复“${comment.field}”字段意见`, [entryId], () => comment.replies.push({ id: uid('reply'), author, message: message.trim(), createdAt: now() }));
  }

  function toggleComment(entryId: string, commentId: string) {
    const entry = entries.find((item) => item.id === entryId);
    const comment = entry?.reviewerComments.find((item) => item.id === commentId);
    if (!entry || !comment) return;
    commit('处理审校意见', comment.status === 'open' ? '标记为已解决' : '重新打开意见', [entryId], () => {
      comment.status = comment.status === 'open' ? 'resolved' : 'open';
    });
  }

  function deleteEntry(entryId: string) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return;
    undoStack.value = [...undoStack.value.slice(-49), snapshot()];
    redoStack.value = [];
    const before = clone(entries);
    const beforeTombstones = clone(tombstones);
    const stamp = now();
    // 撤下生成墓碑：随同步包传播，旧副本不会把它悄悄带回来；审校意见保留在墓碑中。
    tombstones.unshift({
      id: uid('tomb'), entryId: entry.id, headword: entry.headword || '未命名词条',
      deletedAt: stamp, deletedBy: replicaId.value, deletedByName: replicaName.value,
      vv: vvInc(entry.vv, replicaId.value), reviewerComments: clone(entry.reviewerComments)
    });
    const index = entries.findIndex((item) => item.id === entryId);
    if (index >= 0) entries.splice(index, 1);
    revision.value += 1;
    if (selectedId.value === entryId) selectedId.value = entries[0]?.id ?? '';
    versions.unshift({
      id: uid('version'), at: stamp, action: '删除词条', detail: `撤下“${entry.headword}”（保留墓碑，合并时不会被旧副本恢复）`,
      entryId, before, beforeTombstones
    });
    versions.splice(120);
    audit.unshift({ id: uid('audit'), at: stamp, action: '删除词条', detail: `撤下“${entry.headword}”`, entryIds: [entryId] });
    audit.splice(300);
  }

  function mergeEntries(targetId: string, sourceIds: string[], selected: Record<string, 'target' | 'source' | 'combine'>) {
    const target = entries.find((entry) => entry.id === targetId);
    const sources = entries.filter((entry) => sourceIds.includes(entry.id));
    if (!target || !sources.length) return;
    commit('合并重复词条', `将 ${sources.length} 个重复词条合并到“${target.headword}”`, [targetId, ...sourceIds], () => {
      sources.forEach((source) => {
        const layers: Array<keyof DictionaryEntry> = ['dialectVariants', 'examples', 'sources', 'synonyms', 'reviewerComments'];
        layers.forEach((field) => {
          const targetValue = target[field] as unknown[];
          const sourceValue = source[field] as unknown[];
          targetValue.push(...clone(sourceValue));
        });
      });
      (['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes'] as const).forEach((field) => {
        const choice = selected[field] ?? 'target';
        if (choice === 'source') target[field] = sources[0]![field];
        if (choice === 'combine' && target[field] !== sources[0]![field]) target[field] = `${target[field]}；${sources[0]![field]}`;
      });
      target.status = 'disputed';
      sourceIds.forEach((id) => {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index >= 0) entries.splice(index, 1);
      });
    });
  }

  function undo() {
    const value = undoStack.value.at(-1);
    if (!value) return;
    redoStack.value = [...redoStack.value, snapshot()];
    undoStack.value = undoStack.value.slice(0, -1);
    restore(value);
  }

  function redo() {
    const value = redoStack.value.at(-1);
    if (!value) return;
    undoStack.value = [...undoStack.value, snapshot()];
    redoStack.value = redoStack.value.slice(0, -1);
    restore(value);
  }

  function restoreVersion(versionId: string) {
    const version = versions.find((item) => item.id === versionId);
    if (!version) return;
    undoStack.value = [...undoStack.value.slice(-49), snapshot()];
    redoStack.value = [];
    const stamp = now();
    revision.value += 1;
    entries.splice(0, entries.length, ...clone(version.before));
    if (version.beforeTombstones) tombstones.splice(0, tombstones.length, ...clone(version.beforeTombstones));
    if (!entries.some((entry) => entry.id === selectedId.value)) selectedId.value = entries[0]?.id ?? '';
    versions.unshift({
      id: uid('version'), at: stamp, action: '恢复版本',
      detail: `恢复 ${new Date(version.at).toLocaleString('zh-CN')} 之前的版本${version.mergeFrom ? `（该版本来自与“${version.mergeFrom.peerName}”副本的合并）` : ''}`,
      before: clone(entries), beforeTombstones: clone(tombstones)
    });
    versions.splice(120);
    audit.unshift({ id: uid('audit'), at: stamp, action: '恢复版本', detail: version.detail, entryIds: [] });
    audit.splice(300);
  }

  /* ---------------------------- 离线副本合并 ---------------------------- */

  const recordReport = (report: MergeReport) => {
    mergeReports.unshift(report);
    mergeReports.splice(50);
  };

  const failHere = (stage: string): string | null => {
    if (failStage.value && failStage.value === stage) {
      return `${stage}：模拟断网或写入中断，本地改动保持不变，同步包与已裁决内容已保留`;
    }
    return null;
  };

  function buildSyncBundle(): SyncBundle {
    return {
      kind: 'sologsb-dictionary-sync', schema: 1, exportedAt: now(),
      replicaId: replicaId.value, replicaName: replicaName.value,
      entries: clone(entries), tombstones: clone(tombstones)
    };
  }

  /** 读取同事同步包：校验并生成合并方案；失败位置会记录并保留同步包。 */
  function receiveSyncFile(file: File): Promise<{ ok: boolean; error?: string }> {
    return file.text().then((text) => {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const checked = validateBundle(parsed, replicaId.value);
      if (!checked.ok) {
        recordReport({
          id: uid('merge'), at: now(), ok: false, stage: '校验同步包', failurePoint: checked.error,
          peerId: (parsed as SyncBundle | null)?.replicaId ?? 'unknown', peerName: (parsed as SyncBundle | null)?.replicaName ?? '未知副本',
          detail: '同步包校验未通过，未改动任何本地数据', stats: { added: 0, updated: 0, fieldsAutoRemote: 0, conflictsResolved: 0, tombstonesApplied: 0, resurrectionsBlocked: 0, deletionsKept: 0, commentsImported: 0 }
        });
        return { ok: false, error: checked.error };
      }
      const bundle = checked.bundle;
      const failure = failHere('读取同步包');
      const pending: PendingMerge = {
        id: uid('pending'), savedAt: now(),
        stage: failure ? '读取同步包' : '字段冲突裁决',
        failurePoint: failure ?? undefined,
        bundle: clone(bundle), decisions: {}, deleteDecisions: {}
      };
      pendingMerge.value = pending;
      if (failure) {
        activePlan.value = null;
        recordReport({
          id: uid('merge'), at: now(), ok: false, stage: '读取同步包', failurePoint: failure,
          peerId: bundle.replicaId, peerName: bundle.replicaName, detail: '合并在读取阶段中断，可恢复后再次合并', stats: { added: 0, updated: 0, fieldsAutoRemote: 0, conflictsResolved: 0, tombstonesApplied: 0, resurrectionsBlocked: 0, deletionsKept: 0, commentsImported: 0 }
        });
        return { ok: false, error: failure };
      }
      const { plan } = computeMerge({ entries: clone(entries), tombstones: clone(tombstones), keptDeletions: clone(keptDeletions) }, bundle, { id: replicaId.value, name: replicaName.value });
      activePlan.value = plan;
      return { ok: true };
    });
  }

  /** 从持久化的失败合并恢复并重新生成方案。 */
  function resumePendingMerge(): { ok: boolean; error?: string } {
    if (!pendingMerge.value) return { ok: false, error: '没有待恢复的合并' };
    const failure = failHere('恢复待合并');
    if (failure) {
      pendingMerge.value.failedAt = now();
      pendingMerge.value.stage = '恢复待合并';
      pendingMerge.value.failurePoint = failure;
      recordReport({
        id: uid('merge'), at: now(), ok: false, stage: '恢复待合并', failurePoint: failure,
        peerId: pendingMerge.value.bundle.replicaId, peerName: pendingMerge.value.bundle.replicaName,
        detail: '恢复合并再次失败，本地改动仍然保留', stats: { added: 0, updated: 0, fieldsAutoRemote: 0, conflictsResolved: 0, tombstonesApplied: 0, resurrectionsBlocked: 0, deletionsKept: 0, commentsImported: 0 }
      });
      return { ok: false, error: failure };
    }
    const { bundle } = pendingMerge.value;
    const { plan } = computeMerge({ entries: clone(entries), tombstones: clone(tombstones), keptDeletions: clone(keptDeletions) }, bundle, { id: replicaId.value, name: replicaName.value });
    activePlan.value = plan;
    pendingMerge.value.stage = '字段冲突裁决';
    pendingMerge.value.failurePoint = undefined;
    return { ok: true };
  }

  function setDecision(key: string, choice: 'local' | 'remote' | 'combine') {
    if (!pendingMerge.value) return;
    pendingMerge.value.decisions[key] = choice;
  }

  function setDeleteDecision(key: string, choice: 'keep' | 'remove') {
    if (!pendingMerge.value) return;
    pendingMerge.value.deleteDecisions[key] = choice;
  }

  function cancelMerge() {
    pendingMerge.value = null;
    activePlan.value = null;
  }

  /** 放弃待处理合并时保留一条审计：对方同步包可重新导入。 */
  function discardPendingMerge() {
    if (!pendingMerge.value) return;
    const { replicaName: peerName } = pendingMerge.value.bundle;
    audit.unshift({ id: uid('audit'), at: now(), action: '放弃合并', detail: `放弃来自“${peerName}”的待处理合并，本地数据未改动`, entryIds: [] });
    pendingMerge.value = null;
    activePlan.value = null;
  }

  function applyPendingMerge(): { ok: boolean; error?: string } {
    const pending = pendingMerge.value;
    const plan = activePlan.value;
    if (!pending || !plan) return { ok: false, error: '没有待应用的合并方案' };

    let failure = failHere('字段冲突裁决');
    if (!failure) {
      const { apply } = computeMerge({ entries: clone(entries), tombstones: clone(tombstones), keptDeletions: clone(keptDeletions) }, pending.bundle, { id: replicaId.value, name: replicaName.value });
      const trial = apply(pending.decisions, pending.deleteDecisions, now());
      if (trial.unresolvedFields.length || trial.unresolvableDeletes.length) {
        failure = `字段冲突裁决：仍有 ${trial.unresolvedFields.length + trial.unresolvableDeletes.length} 处冲突未选择事实版本`;
      }
    }
    if (failure) {
      pending.failedAt = now();
      pending.stage = '字段冲突裁决';
      pending.failurePoint = failure;
      recordReport({
        id: uid('merge'), at: now(), ok: false, stage: '字段冲突裁决', failurePoint: failure,
        peerId: pending.bundle.replicaId, peerName: pending.bundle.replicaName,
        detail: '合并未完成：本地改动保持不变，裁决进度已保存，可恢复并继续', stats: plan.previewStats
      });
      return { ok: false, error: failure };
    }

    failure = failHere('写入合并结果');
    if (failure) {
      pending.failedAt = now();
      pending.stage = '写入合并结果';
      pending.failurePoint = failure;
      recordReport({
        id: uid('merge'), at: now(), ok: false, stage: '写入合并结果', failurePoint: failure,
        peerId: pending.bundle.replicaId, peerName: pending.bundle.replicaName,
        detail: '写入阶段中断，已裁决内容保留，可再次合并', stats: plan.previewStats
      });
      return { ok: false, error: failure };
    }

    // 全部检查通过后才落地：失败路径在上面返回，绝不动本地数据。
    const stamp = now();
    const { apply } = computeMerge({ entries: clone(entries), tombstones: clone(tombstones), keptDeletions: clone(keptDeletions) }, pending.bundle, { id: replicaId.value, name: replicaName.value });
    const outcome = apply(pending.decisions, pending.deleteDecisions, stamp);

    undoStack.value = [...undoStack.value.slice(-49), snapshot()];
    redoStack.value = [];
    const before = clone(entries);
    const beforeTombstones = clone(tombstones);

    entries.splice(0, entries.length, ...outcome.entries);
    tombstones.splice(0, tombstones.length, ...outcome.tombstones);
    keptDeletions.splice(0, keptDeletions.length, ...outcome.keptDeletions);
    revision.value += 1;
    if (!entries.some((entry) => entry.id === selectedId.value)) selectedId.value = entries[0]?.id ?? '';

    const s = outcome.stats;
    const detail = `与副本“${pending.bundle.replicaName}”合并：新增 ${s.added}、更新 ${s.updated} 个词条，自动接收 ${s.fieldsAutoRemote} 个较新字段，裁决 ${s.conflictsResolved} 处字段冲突，应用 ${s.tombstonesApplied} 处撤下，拦下 ${s.resurrectionsBlocked} 处可能复活，保留意见回复 ${s.commentsImported} 条`;
    versions.unshift({
      id: uid('version'), at: stamp, action: '合并同事副本',
      detail, entryId: undefined, before, beforeTombstones,
      mergeFrom: { bundleAt: pending.bundle.exportedAt, peerId: pending.bundle.replicaId, peerName: pending.bundle.replicaName }
    });
    versions.splice(120);
    audit.unshift({
      id: uid('audit'), at: stamp, action: '合并同事副本',
      detail: `来自副本“${pending.bundle.replicaName}”（导出于 ${new Date(pending.bundle.exportedAt).toLocaleString('zh-CN')}）：${detail}`,
      entryIds: outcome.entries.map((entry) => entry.id)
    });
    audit.splice(300);
    recordReport({
      id: uid('merge'), at: stamp, ok: true, stage: '完成', peerId: pending.bundle.replicaId, peerName: pending.bundle.replicaName,
      detail, stats: s
    });
    pendingMerge.value = null;
    activePlan.value = null;
    return { ok: true };
  }

  /** 对复活保护留痕的事后裁决：撤下或保留。 */
  function resolveKeptDeletion(keptId: string, choice: 'keep' | 'remove') {
    const kept = keptDeletions.find((item) => item.id === keptId);
    if (!kept) return;
    if (choice === 'remove') {
      const entry = entries.find((item) => item.id === kept.entryId);
      if (entry) deleteEntry(entry.id);
      keptDeletions.splice(keptDeletions.findIndex((item) => item.id === keptId), 1);
      audit.unshift({ id: uid('audit'), at: now(), action: '确认撤下', detail: `复核后确认撤下“${kept.headword}”（原撤下副本：${kept.deletedByName}）`, entryIds: [kept.entryId] });
    } else {
      keptDeletions.splice(keptDeletions.findIndex((item) => item.id === keptId), 1);
      audit.unshift({ id: uid('audit'), at: now(), action: '确认保留', detail: `复核后保留“${kept.headword}”，撤下请求不予恢复`, entryIds: [kept.entryId] });
    }
  }

  function setReplicaName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === replicaName.value) return;
    replicaName.value = trimmed;
    try { localStorage.setItem(REPLICA_KEY, JSON.stringify({ id: replicaId.value, name: trimmed })); } catch { /* ignore */ }
    audit.unshift({ id: uid('audit'), at: now(), action: '重命名副本', detail: `本副本改名为“${trimmed}”`, entryIds: [] });
  }

  function hydrateFromBrowser() {
    try {
      const raw = localStorage.getItem('sologsb-1021-dictionary-v1');
      if (raw) restore(JSON.parse(raw) as DictionarySnapshot);
    } catch {
      localStorage.removeItem('sologsb-1021-dictionary-v1');
    } finally {
      hydrated.value = true;
    }
  }

  function exportPackage() {
    return JSON.stringify({ exportedAt: now(), ...persistableSnapshot.value }, null, 2);
  }

  return {
    revision, replicaId, replicaName, entries, tombstones, keptDeletions, versions, audit, mergeReports,
    pendingMerge, activePlan, selectedId, hydrated, query, statusFilter, dialectFilter, fieldReplyDrafts, failStage,
    selectedEntry, filteredEntries, dialects, duplicates, openComments, persistableSnapshot,
    canUndo: computed(() => undoStack.value.length > 0), canRedo: computed(() => redoStack.value.length > 0),
    createEntry, updateField, setStatus, addVariant, updateVariant, removeVariant, addExample, updateExample, removeExample,
    addSource, updateSource, removeSource, setSynonyms, addComment, replyComment, toggleComment, deleteEntry, mergeEntries,
    undo, redo, restoreVersion, hydrateFromBrowser, exportPackage,
    buildSyncBundle, receiveSyncFile, resumePendingMerge, applyPendingMerge, cancelMerge, discardPendingMerge,
    setDecision, setDeleteDecision, resolveKeptDeletion, setReplicaName
  };
});
