/* 合并引擎端到端逻辑测试：node --import jiti/register scripts/test-merge.mjs */
import { assert } from 'node:console';
import {
  computeMerge, validateBundle, vvInc, newFieldRevision,
  type ScalarField
} from '../utils/sync.ts';
import type { DictionaryEntry, SyncBundle, EntryStatus } from '../types/dictionary.ts';

let passed = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1; }
  else { passed += 1; console.log(`✓ ${name}`); }
};

const A = 'replica-A';
const B = 'replica-B';
const AN = '田野甲';
const BN = '田野乙';
let clock = 0;
const tick = () => new Date(Date.UTC(2026, 0, 1, 0, clock++, 0)).toISOString();

const makeEntry = (id: string, replica: string, patch: Partial<DictionaryEntry> = {}): DictionaryEntry => {
  const at = tick();
  const entry: DictionaryEntry = {
    id, headword: 'h', pronunciation: '', partOfSpeech: '名词', definition: '原释义',
    dialectVariants: [], examples: [], sources: [], synonyms: [], status: 'draft',
    notes: '', createdAt: at, updatedAt: at, reviewerComments: [],
    vv: { [replica]: 1 }, fieldRevisions: {}, ...patch
  };
  (['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes', 'synonyms', 'status'] as ScalarField[]).forEach((field) => {
    entry.fieldRevisions[field] = newFieldRevision(replica, replica === A ? AN : BN, at, entry.vv);
  });
  return entry;
};

/** 模拟某副本编辑字段（版本向量递增 + 修订戳）。 */
const editScalar = (entry: DictionaryEntry, replica: string, name: string, field: ScalarField, value: unknown) => {
  entry.vv = vvInc(entry.vv, replica);
  (entry as Record<string, unknown>)[field] = value;
  entry.fieldRevisions[field] = newFieldRevision(replica, name, tick(), entry.vv);
  entry.updatedAt = tick();
};

const bundleOf = (replicaId: string, name: string, entries: DictionaryEntry[], tombstones: SyncBundle['tombstones'] = []): SyncBundle =>
  ({ kind: 'sologsb-dictionary-sync', schema: 1, exportedAt: tick(), replicaId, replicaName: name, entries: JSON.parse(JSON.stringify(entries)), tombstones: JSON.parse(JSON.stringify(tombstones)) });

const deep = (v: unknown) => JSON.parse(JSON.stringify(v));

/* 场景 1：只有远程改 → 自动接收 */
{
  const local = [makeEntry('e1', A, { headword: '甲' })];
  const remote = [deep(local[0])];
  editScalar(remote[0], B, BN, 'definition', '乙改的释义');
  const { plan, apply } = computeMerge({ entries: deep(local), tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  check('场景1 无字段冲突', plan.fieldConflicts.length === 0);
  check('场景1 自动接收远程字段', apply({}, {}, tick()).entries[0].definition === '乙改的释义');
}

/* 场景 2：只有本地改、远程是旧副本 → 本地保留 */
{
  const base = makeEntry('e1', A, { headword: '甲' });
  const local = deep(base);
  editScalar(local, A, AN, 'definition', '甲本地新释义');
  const remote = [deep(base)]; // 乙基于旧版本，未改此字段
  const { plan, apply } = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  const out = apply({}, {}, tick());
  check('场景2 无冲突', plan.fieldConflicts.length === 0);
  check('场景2 本地修改不被旧副本覆盖', out.entries[0].definition === '甲本地新释义');
}

/* 场景 3：两边分叉改不同字段 → 都自动保留 */
{
  const base = makeEntry('e1', A, { headword: '甲' });
  const local = deep(base); editScalar(local, A, AN, 'headword', '甲改词形');
  const remote = [deep(base)]; editScalar(remote[0], B, BN, 'notes', '乙改备注');
  const { plan, apply } = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  const out = apply({}, {}, tick());
  check('场景3 不同字段无冲突', plan.fieldConflicts.length === 0);
  check('场景3 双方修改都保留', out.entries[0].headword === '甲改词形' && out.entries[0].notes === '乙改备注');
}

/* 场景 4：两边分叉改同一字段 → 冲突，两版保留，可选择 local/remote/combine */
{
  const base = makeEntry('e1', A, { headword: '甲' });
  const local = deep(base); editScalar(local, A, AN, 'definition', '甲的版本');
  const remote = [deep(base)]; editScalar(remote[0], B, BN, 'definition', '乙的版本');
  const engine = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  check('场景4 产生 1 个字段冲突', engine.plan.fieldConflicts.length === 1);
  const c = engine.plan.fieldConflicts[0];
  check('场景4 冲突保留两版内容', c.localValue === '甲的版本' && c.remoteValue === '乙的版本');
  check('场景4 冲突标明双方来源', !!c.localRev?.byName.includes('甲') && !!c.remoteRev?.byName.includes('乙'));
  check('场景4 未裁决时合并停在裁决阶段', engine.apply({}, {}, tick()).unresolvedFields.length === 1);
  check('场景4 选本地', engine.apply({ [c.key]: 'local' }, {}, tick()).entries[0].definition === '甲的版本');
  check('场景4 选对方', engine.apply({ [c.key]: 'remote' }, {}, tick()).entries[0].definition === '乙的版本');
  check('场景4 拼接两版', engine.apply({ [c.key]: 'combine' }, {}, tick()).entries[0].definition === '甲的版本；乙的版本');
}

/* 场景 5：已确认状态不被旧副本覆盖 */
{
  const base = makeEntry('e1', A, { status: 'review' });
  const local = deep(base); editScalar(local, A, AN, 'status', 'confirmed' as EntryStatus);
  const remote = [deep(base)]; // 乙停留在 review，没有改状态
  const { plan, apply } = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  check('场景5 状态无冲突', plan.fieldConflicts.length === 0);
  check('场景5 已确认不被旧副本改回待审', apply({}, {}, tick()).entries[0].status === 'confirmed');
}

/* 场景 5b：审校意见已解决，旧副本不能改回 open */
{
  const base = makeEntry('e1', A);
  const comment = { id: 'c1', field: 'definition', author: '审校', message: '请核对', status: 'resolved' as const, createdAt: tick(), updatedAt: tick(), vv: { [A]: 2 }, replies: [] };
  base.reviewerComments = [deep(comment)];
  const local = deep(base);
  // 乙的旧副本里意见仍是 open，vv 更旧
  const remoteComment = deep(comment); remoteComment.status = 'open'; delete remoteComment.vv;
  const remote = [deep(base)]; remote[0].reviewerComments = [remoteComment];
  const { apply } = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  check('场景5b 已解决意见不被旧副本改回待处理', apply({}, {}, tick()).entries[0].reviewerComments[0].status === 'resolved');
}

/* 场景 6：撤下随同步包传播，旧副本不恢复词条 */
{
  const base = makeEntry('e1', A, { headword: '待删词' });
  // 甲撤下了词条（墓碑 vv 严格新于乙手里的旧词条）
  const local = [] as DictionaryEntry[];
  const tomb = { id: 't1', entryId: 'e1', headword: '待删词', deletedAt: tick(), deletedBy: A, deletedByName: AN, vv: vvInc(base.vv, A), reviewerComments: deep(base.reviewerComments) };
  // 乙的旧副本仍带着词条
  const remote = [deep(base)];
  const { plan, apply } = computeMerge({ entries: local, tombstones: [deep(tomb)], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  const out = apply({}, {}, tick());
  check('场景6 旧副本带回词条不产生冲突', plan.deleteConflicts.length === 0);
  check('场景6 撤下不被悄悄恢复', !out.entries.some((e) => e.id === 'e1'));
  check('场景6 墓碑仍在', out.tombstones.some((t) => t.entryId === 'e1'));
}

/* 场景 7：甲撤下后，乙在分叉后继续编辑 → 复活保护，默认拦下并要求显式选择 */
{
  const base = makeEntry('e1', A, { headword: '词' });
  const tomb = { id: 't1', entryId: 'e1', headword: '词', deletedAt: tick(), deletedBy: A, deletedByName: AN, vv: vvInc(base.vv, A), reviewerComments: [] };
  const local = [] as DictionaryEntry[];
  const remote = [deep(base)];
  editScalar(remote[0], B, BN, 'definition', '乙在删除后新补的释义');
  const { plan, apply } = computeMerge({ entries: local, tombstones: [deep(tomb)], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  check('场景7 产生删除冲突', plan.deleteConflicts.length === 1);
  check('场景7 本地撤下默认确认撤下', plan.deleteConflicts[0].defaultChoice === 'remove');
  const kept = apply({}, {}, tick());
  check('场景7 默认撤下（不悄悄恢复乙的版本）', !kept.entries.some((e) => e.id === 'e1'));
  const restored = apply({}, { 'del:e1': 'keep' }, tick());
  check('场景7 显式保留时乙的编辑回到词条', restored.entries.some((e) => e.id === 'e1' && e.definition === '乙在删除后新补的释义'));
  check('场景7 保留产生留痕', restored.keptDeletions.some((k) => k.entryId === 'e1'));
}

/* 场景 8：乙撤下、甲在分叉后继续编辑 → 默认保留词条，撤下不悄悄生效 */
{
  const base = makeEntry('e1', A, { headword: '词' });
  const local = [deep(base)];
  editScalar(local[0], A, AN, 'definition', '甲本地继续编辑');
  const remote = [] as DictionaryEntry[];
  const tomb = { id: 't2', entryId: 'e1', headword: '词', deletedAt: tick(), deletedBy: B, deletedByName: BN, vv: vvInc(base.vv, B), reviewerComments: [] };
  const { plan, apply } = computeMerge({ entries: local, tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote, [tomb]), { id: A, name: AN });
  check('场景8 产生删除冲突', plan.deleteConflicts.length === 1);
  check('场景8 默认保留本地编辑', plan.deleteConflicts[0].defaultChoice === 'keep');
  const out = apply({}, {}, tick());
  check('场景8 本地词条默认未被撤下', out.entries.some((e) => e.id === 'e1' && e.definition === '甲本地继续编辑'));
  check('场景8 统计拦下复活', out.stats.resurrectionsBlocked === 1);
  check('场景8 显式确认可撤下', !apply({}, { 'del:e1': 'remove' }, tick()).entries.some((e) => e.id === 'e1'));
}

/* 场景 9：双方数组内容并集，对方条目标注来源 */
{
  const base = makeEntry('e1', A);
  const local = deep(base);
  local.dialectVariants = [{ id: 'v1', dialect: '北坡话', form: 'a', pronunciation: '', note: '' }];
  const remote = [deep(base)];
  remote[0].dialectVariants = [
    { id: 'v1', dialect: '北坡话', form: 'a', pronunciation: '', note: '' },
    { id: 'v2', dialect: '河谷话', form: 'b', pronunciation: '', note: '' }
  ];
  const { apply } = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  const variants = apply({}, {}, tick()).entries[0].dialectVariants;
  check('场景9 子对象并集保留', variants.length === 2);
  check('场景9 对方带来的条目标注来源副本', variants.find((v) => v.id === 'v2')?.origin === BN);
}

/* 场景 10：审校意见与回复双向合并 */
{
  const base = makeEntry('e1', A);
  const local = deep(base);
  local.reviewerComments = [{ id: 'c1', field: 'definition', author: '审校', message: '意见1', status: 'open', createdAt: tick(), replies: [{ id: 'r1', author: AN, message: '甲的回复', createdAt: tick() }] }];
  const remote = [deep(base)];
  remote[0].reviewerComments = [
    { id: 'c1', field: 'definition', author: '审校', message: '意见1', status: 'open', createdAt: tick(), replies: [{ id: 'r2', author: BN, message: '乙的回复', createdAt: tick() }] },
    { id: 'c2', field: 'notes', author: '审校乙', message: '新增意见', status: 'open', createdAt: tick(), replies: [] }
  ];
  const out = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN }).apply({}, {}, tick());
  const comments = out.entries[0].reviewerComments;
  check('场景10 意见按 id 合并、新意见导入', comments.length === 2);
  check('场景10 双方回复都保留', comments.find((c) => c.id === 'c1')!.replies.length === 2);
  check('场景10 导入评论计数', out.stats.commentsImported === 1);
}

/* 场景 11：远程独有词条被收入；远程撤下一条本地没有的词 → 墓碑并入 */
{
  const local = [makeEntry('e1', A)];
  const remote = [makeEntry('e2', B, { headword: '乙新词' })];
  const tomb = { id: 't9', entryId: 'e3', headword: '乙删掉的词', deletedAt: tick(), deletedBy: B, deletedByName: BN, vv: { [B]: 3 }, reviewerComments: [] };
  const out = computeMerge({ entries: local, tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote, [tomb]), { id: A, name: AN }).apply({}, {}, tick());
  check('场景11 远程新词收入', out.entries.some((e) => e.id === 'e2'));
  check('场景11 远程墓碑并入', out.tombstones.some((t) => t.entryId === 'e3'));
}

/* 场景 12：同义词分叉冲突 combine 为去重并集 */
{
  const base = makeEntry('e1', A, { synonyms: ['水潭'] });
  const local = deep(base); editScalar(local, A, AN, 'synonyms', ['水潭', '泉水']);
  const remote = [deep(base)]; editScalar(remote[0], B, BN, 'synonyms', ['水潭', '泉眼']);
  const engine = computeMerge({ entries: [local], tombstones: [], keptDeletions: [] }, bundleOf(B, BN, remote), { id: A, name: AN });
  const key = engine.plan.fieldConflicts[0]?.key;
  const out = engine.apply({ [key]: 'combine' }, {}, tick());
  check('场景12 同义词拼接为去重并集', JSON.stringify(out.entries[0].synonyms) === JSON.stringify(['水潭', '泉水', '泉眼']));
}

/* 场景 13：同步包校验 */
{
  check('场景13 拒绝非同步包', validateBundle({ foo: 1 }, A).ok === false);
  check('场景13 拒绝自己的包', validateBundle(bundleOf(A, AN, []), A).ok === false);
  check('场景13 接受对方的包', validateBundle(bundleOf(B, BN, []), A).ok === true);
}

console.log(`\n${passed} 项通过`);
