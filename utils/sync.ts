import type {
  DictionaryEntry, EntryStatus, EntryTombstone, FieldRevision, KeptDeletion,
  MergeReportStats, ReviewComment, SyncBundle, VersionVector
} from '~/types/dictionary';

/* ------------------------------------------------------------------ */
/* 版本向量：判断两个副本的修改是因果先后，还是各自分叉（并发冲突）。 */
/* ------------------------------------------------------------------ */

export const vvCopy = (vv: VersionVector = {}): VersionVector => ({ ...vv });

export const vvEqual = (a: VersionVector = {}, b: VersionVector = {}) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? 0) === (b[key] ?? 0));
};

/** a 是否“知道” b 的全部修改（a 是 b 的后代，含相等）。 */
export const vvDominates = (a: VersionVector = {}, b: VersionVector = {}) =>
  Object.entries(b).every(([key, value]) => (a[key] ?? 0) >= value);

export const vvStrictlyDominates = (a: VersionVector = {}, b: VersionVector = {}) =>
  vvDominates(a, b) && !vvEqual(a, b);

export const vvConcurrent = (a: VersionVector = {}, b: VersionVector = {}) =>
  !vvDominates(a, b) && !vvDominates(b, a);

export const vvMax = (a: VersionVector = {}, b: VersionVector = {}): VersionVector => {
  const out = vvCopy(a);
  Object.entries(b).forEach(([key, value]) => { out[key] = Math.max(out[key] ?? 0, value); });
  return out;
};

export const vvInc = (vv: VersionVector, replicaId: string): VersionVector =>
  ({ ...vv, [replicaId]: (vv[replicaId] ?? 0) + 1 });

export const createReplicaId = () =>
  `replica-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;

export const newFieldRevision = (replicaId: string, replicaName: string, at: string, vv: VersionVector): FieldRevision =>
  ({ vv: vvCopy(vv), by: replicaId, byName: replicaName, at });

/* ------------------------------------------------------------------ */
/* 字段标签与取值渲染（冲突对话框与编辑器共用）。                       */
/* ------------------------------------------------------------------ */

export const SCALAR_FIELDS = ['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes', 'synonyms', 'status'] as const;
export type ScalarField = typeof SCALAR_FIELDS[number];

export const STATUS_LABELS: Record<EntryStatus, string> = {
  draft: '草稿', review: '待审', disputed: '争议', confirmed: '已确认'
};

export const FIELD_LABELS: Record<string, string> = {
  headword: '词形', pronunciation: '发音说明', partOfSpeech: '词性', definition: '释义',
  notes: '编者备注', synonyms: '同义词', status: '词条状态',
  dialectVariants: '方言变体', examples: '例句', sources: '来源', reviewerComments: '审校意见'
};

/** 词性、状态这类枚举字段不存在“拼接两版”。 */
const NO_COMBINE = new Set<ScalarField>(['partOfSpeech', 'status']);

export const fieldText = (entry: DictionaryEntry, field: ScalarField): string => {
  const value = entry[field];
  if (field === 'synonyms') return (value as string[]).join('、');
  if (field === 'status') return STATUS_LABELS[value as EntryStatus] ?? String(value);
  return String(value ?? '');
};

export const isSameValue = (entry: DictionaryEntry, other: DictionaryEntry, field: ScalarField) =>
  JSON.stringify(entry[field]) === JSON.stringify(other[field]);

export const formatRev = (rev: FieldRevision | null | undefined) =>
  rev ? `${rev.byName} · ${new Date(rev.at).toLocaleString('zh-CN')}` : '原始记录';

const latestFieldRev = (entry: DictionaryEntry): FieldRevision | null =>
  Object.values(entry.fieldRevisions).filter(Boolean).sort((a, b) => b!.at.localeCompare(a!.at))[0] ?? null;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* ------------------------------------------------------------------ */
/* 同步包校验。                                                         */
/* ------------------------------------------------------------------ */

export const validateBundle = (raw: unknown, localReplicaId: string): { ok: true; bundle: SyncBundle } | { ok: false; error: string } => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '文件内容不是有效的 JSON 对象' };
  const bundle = raw as SyncBundle;
  if (bundle.kind !== 'sologsb-dictionary-sync') return { ok: false, error: '缺少同步包标识（kind 不匹配），可能导出的是备份而非同事同步包' };
  if (bundle.schema !== 1) return { ok: false, error: `不支持的同步包版本 schema=${String(bundle.schema)}` };
  if (!bundle.replicaId || typeof bundle.replicaId !== 'string') return { ok: false, error: '同步包缺少来源副本标识' };
  if (bundle.replicaId === localReplicaId) return { ok: false, error: '这是本副本自己导出的同步包，不能与自己合并；恢复备份请使用“导入备份”' };
  if (!Array.isArray(bundle.entries) || !Array.isArray(bundle.tombstones)) return { ok: false, error: '同步包缺少词条或墓碑数据' };
  return { ok: true, bundle };
};

/* ------------------------------------------------------------------ */
/* 冲突描述。                                                           */
/* ------------------------------------------------------------------ */

export interface FieldConflict {
  key: string;
  entryId: string;
  headword: string;
  field: ScalarField;
  canCombine: boolean;
  localValue: string;
  remoteValue: string;
  localRev: FieldRevision | null;
  remoteRev: FieldRevision | null;
}

export interface DeleteConflict {
  key: string;
  entryId: string;
  headword: string;
  direction: KeptDeletion['direction'];
  deletedByName: string;
  deletedAt: string;
  editedByName: string | null;
  editedAt: string | null;
  /** 复活保护的建议选择：本地有编辑时建议保留，仅远程带回旧内容时建议撤下。 */
  defaultChoice: 'keep' | 'remove';
}

export interface MergePlan {
  bundle: SyncBundle;
  fieldConflicts: FieldConflict[];
  deleteConflicts: DeleteConflict[];
  previewStats: Readonly<MergeReportStats>;
}

export interface MergeOutcome {
  entries: DictionaryEntry[];
  tombstones: EntryTombstone[];
  keptDeletions: KeptDeletion[];
  stats: MergeReportStats;
  /** 仍未裁决的冲突键 —— 存在即说明合并不能在“裁决字段冲突”阶段完成。 */
  unresolvedFields: string[];
  unresolvableDeletes: string[];
}

interface MergeInput {
  entries: DictionaryEntry[];
  tombstones: EntryTombstone[];
  keptDeletions: KeptDeletion[];
}

const emptyStats = (): MergeReportStats => ({
  added: 0, updated: 0, fieldsAutoRemote: 0, conflictsResolved: 0,
  tombstonesApplied: 0, resurrectionsBlocked: 0, deletionsKept: 0, commentsImported: 0
});

const chooseTombstone = (a: EntryTombstone, b: EntryTombstone): EntryTombstone => {
  if (vvStrictlyDominates(a.vv, b.vv)) return a;
  if (vvStrictlyDominates(b.vv, a.vv)) return b;
  // 并发的两次撤下：保留评论更全、时间更晚的那一座墓碑。
  if (a.reviewerComments.length !== b.reviewerComments.length) return a.reviewerComments.length > b.reviewerComments.length ? a : b;
  return a.deletedAt >= b.deletedAt ? a : b;
};

const mergeComments = (local: ReviewComment[], remote: ReviewComment[], peerName: string, stats: MergeReportStats): ReviewComment[] => {
  const known = new Map(local.map((comment) => [comment.id, comment]));
  remote.forEach((incoming) => {
    const existing = known.get(incoming.id);
    if (!existing) {
      const brought = clone({ ...incoming, origin: incoming.origin ?? peerName });
      known.set(brought.id, brought);
      stats.commentsImported += 1;
      return;
    }
    // 回复按 id 合并，双方新增的回复都保留。
    const replyIds = new Set(existing.replies.map((reply) => reply.id));
    incoming.replies.forEach((reply) => { if (!replyIds.has(reply.id)) existing.replies.push(clone(reply)); });
    existing.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // 已解决状态受版本向量保护：旧副本不能把已解决意见改回待处理；并发时已解决优先。
    const lvv = existing.vv ?? {};
    const rvv = incoming.vv ?? {};
    if (vvDominates(rvv, lvv) && incoming.status === 'resolved') {
      existing.status = 'resolved';
      existing.updatedAt = incoming.updatedAt;
      existing.vv = vvCopy(rvv);
    } else if (vvConcurrent(lvv, rvv) && existing.status !== 'resolved' && incoming.status === 'resolved') {
      existing.status = 'resolved';
      existing.updatedAt = incoming.updatedAt ?? existing.updatedAt;
      existing.vv = vvMax(lvv, rvv);
    }
  });
  return [...known.values()];
};

/** 子对象数组按 id 取并集；同一子对象两边都改过则两版都保留，对方版本标注来源副本。 */
const unionItems = <T extends { id: string; origin?: string }>(local: T[], remote: T[], peerName: string): T[] => {
  const byId = new Map<string, T>(local.map((item) => [item.id, item]));
  remote.forEach((item) => {
    const existing = byId.get(item.id);
    if (!existing) byId.set(item.id, clone({ ...item, origin: item.origin ?? peerName }));
    else if (JSON.stringify(existing) !== JSON.stringify(item)) {
      byId.set(`${item.id}__remote_${peerName}`, clone({ ...item, id: `${item.id}__remote_${peerName}`, origin: peerName }));
    }
  });
  return [...byId.values()];
};

/**
 * 三方合并核心：base 由版本向量推出，不在向量上保留对象快照。
 * 因果上更新的一版直接胜出（旧副本无法覆盖新内容）；分叉的修改生成显式冲突。
 */
export const computeMerge = (input: MergeInput, bundle: SyncBundle, replica: { id: string; name: string }) => {
  const peer = { id: bundle.replicaId, name: bundle.replicaName || bundle.replicaId };
  const localMap = new Map(input.entries.map((entry) => [entry.id, entry]));
  const remoteMap = new Map(bundle.entries.map((entry) => [entry.id, entry]));
  const localTombMap = new Map(input.tombstones.map((tomb) => [tomb.entryId, tomb]));

  const fieldConflicts: FieldConflict[] = [];
  const deleteConflicts: DeleteConflict[] = [];
  const previewStats = emptyStats();
  /** 预先合并好的双方共有词条（字段冲突处先用本地值占位，apply 时按裁决替换）。 */
  const merged = new Map<string, DictionaryEntry>();
  /** 远程独有、本地也未撤下的新词条。 */
  const remoteAdded = new Map<string, DictionaryEntry>();
  /** 远程撤下严格新于本地词条 → 自动撤下的本地词条。 */
  const autoDeletedLocal = new Set<string>();
  /** 本地撤下严格新于远程旧副本 → 自动丢弃的远程词条（撤下不能悄悄恢复）。 */
  const autoSuppressedRemote = new Set<string>();
  /** 需要编辑显式裁决的删除冲突（复活保护）。 */
  const blocked = new Map<string, KeptDeletion['direction']>();

  // 合并双方墓碑：取因果更新的一座，并发时保留评论更全的一座。
  const allTombstones = new Map<string, EntryTombstone>();
  [...input.tombstones, ...bundle.tombstones].forEach((tomb) => {
    const existing = allTombstones.get(tomb.entryId);
    allTombstones.set(tomb.entryId, existing ? chooseTombstone(existing, clone(tomb)) : clone(tomb));
  });

  const addDeleteConflict = (entry: DictionaryEntry, tomb: EntryTombstone, direction: KeptDeletion['direction']) => {
    const key = `del:${entry.id}`;
    if (blocked.has(entry.id)) return;
    blocked.set(entry.id, direction);
    const edited = latestFieldRev(entry);
    deleteConflicts.push({
      key, entryId: entry.id, headword: entry.headword || '未命名词条', direction,
      deletedByName: tomb.deletedByName, deletedAt: tomb.deletedAt,
      editedByName: edited?.byName ?? null, editedAt: entry.updatedAt ?? null,
      defaultChoice: direction === 'remote-deletes-local-edited' ? 'keep' : 'remove'
    });
    previewStats.resurrectionsBlocked += 1;
  };

  /* 远程墓碑：撤下严格新于本地 → 生效；本地在分叉后继续编辑 → 冲突，默认保留本地。 */
  bundle.tombstones.forEach((tomb) => {
    const localEntry = localMap.get(tomb.entryId);
    const mergedTomb = allTombstones.get(tomb.entryId)!;
    if (!localEntry || localTombMap.has(tomb.entryId)) {
      // 本地也已撤下：把可能更新的评论并入墓碑。
      if (localEntry) mergedTomb.reviewerComments = mergeComments(mergedTomb.reviewerComments, localEntry.reviewerComments, peer.name, previewStats);
      return;
    }
    if (vvConcurrent(tomb.vv, localEntry.vv)) {
      addDeleteConflict(localEntry, tomb, 'remote-deletes-local-edited');
      return;
    }
    if (vvDominates(tomb.vv, localEntry.vv)) {
      autoDeletedLocal.add(localEntry.id);
      mergedTomb.reviewerComments = mergeComments(mergedTomb.reviewerComments, localEntry.reviewerComments, peer.name, previewStats);
    }
    // 本地反而更新时：撤下被忽略（复活保护由字段修订保证，词条保留），不做留痕。
  });

  /* 本地墓碑：远程带回词条时，撤下严格更新则丢弃旧副本；远程分叉后编辑过则冲突。 */
  input.tombstones.forEach((tomb) => {
    const remoteEntry = remoteMap.get(tomb.entryId);
    const mergedTomb = allTombstones.get(tomb.entryId)!;
    if (!remoteEntry || bundle.tombstones.some((item) => item.entryId === tomb.entryId)) return;
    if (vvConcurrent(tomb.vv, remoteEntry.vv)) {
      addDeleteConflict(remoteEntry, tomb, 'local-deleted-remote-edited');
      return;
    }
    if (vvDominates(tomb.vv, remoteEntry.vv)) {
      autoSuppressedRemote.add(remoteEntry.id);
      mergedTomb.reviewerComments = mergeComments(mergedTomb.reviewerComments, remoteEntry.reviewerComments, peer.name, previewStats);
    }
  });

  const mergeEntryPair = (local: DictionaryEntry, remote: DictionaryEntry) => {
    const result = clone(local);
    let touched = false;

    SCALAR_FIELDS.forEach((field) => {
      const lRev = local.fieldRevisions[field] ?? null;
      const rRev = remote.fieldRevisions[field] ?? null;
      if (isSameValue(local, remote, field)) {
        if (rRev && (!lRev || vvStrictlyDominates(rRev.vv, lRev.vv))) result.fieldRevisions[field] = clone(rRev);
        return;
      }

      const localKnowsRemote = !rRev || vvDominates(local.vv, rRev.vv);
      const remoteKnowsLocal = !lRev || vvDominates(remote.vv, lRev.vv);

      if (lRev && !rRev && localKnowsRemote) {
        // 只有本地改过，远程是旧状态：保留本地（审校确认等不被旧副本覆盖）。
        return;
      }
      if (rRev && !lRev && remoteKnowsLocal) {
        // 只有远程改过，本地是旧状态：接收远程。
        (result as unknown as Record<string, unknown>)[field] = clone(remote[field]);
        result.fieldRevisions[field] = clone(rRev);
        previewStats.fieldsAutoRemote += 1;
        touched = true;
        return;
      }
      if (lRev && rRev) {
        if (vvDominates(lRev.vv, rRev.vv)) return; // 本地修订因果更新：旧副本无法覆盖
        if (vvDominates(rRev.vv, lRev.vv)) {
          (result as unknown as Record<string, unknown>)[field] = clone(remote[field]);
          result.fieldRevisions[field] = clone(rRev);
          previewStats.fieldsAutoRemote += 1;
          touched = true;
          return;
        }
      }
      // 两边都在分叉后改过同一字段：逐字段保留两版，标明来源与时间，交编辑裁决。
      fieldConflicts.push({
        key: `${local.id}:${field}`,
        entryId: local.id,
        headword: local.headword || '未命名词条',
        field,
        canCombine: !NO_COMBINE.has(field),
        localValue: fieldText(local, field),
        remoteValue: fieldText(remote, field),
        localRev: lRev,
        remoteRev: rRev
      });
    });

    // 数组类内容：按 id 并集，双方内容都保留，对方带来的条目标注来源副本。
    const variants = unionItems(result.dialectVariants, remote.dialectVariants, peer.name);
    const examples = unionItems(result.examples, remote.examples, peer.name);
    const sources = unionItems(result.sources, remote.sources, peer.name);
    if (variants.length !== result.dialectVariants.length || examples.length !== result.examples.length || sources.length !== result.sources.length) touched = true;
    result.dialectVariants = variants;
    result.examples = examples;
    result.sources = sources;
    const commentCount = result.reviewerComments.length;
    result.reviewerComments = mergeComments(result.reviewerComments, remote.reviewerComments, peer.name, previewStats);
    if (result.reviewerComments.length !== commentCount) touched = true;

    result.vv = vvMax(local.vv, remote.vv);
    if (remote.updatedAt > result.updatedAt) result.updatedAt = remote.updatedAt;
    if (touched) previewStats.updated += 1;
    merged.set(local.id, result);
  };

  // 双方都有的词条逐字段合并（自动撤下与删除冲突的除外）。
  localMap.forEach((local, id) => {
    const remote = remoteMap.get(id);
    if (remote && !autoDeletedLocal.has(id)) mergeEntryPair(local, remote);
  });

  // 远程独有词条：本地撤下过的情况已在上面处理，其余作为新词条收入。
  remoteMap.forEach((remote, id) => {
    if (localMap.has(id)) return;
    if (localTombMap.has(id)) {
      if (!autoSuppressedRemote.has(id) && blocked.has(id)) {
        // 并发：本地撤下、远程继续编辑。复活候选条目带齐墓碑中的旧评论。
        const candidate = clone(remote);
        const tomb = allTombstones.get(id);
        if (tomb) candidate.reviewerComments = mergeComments(candidate.reviewerComments, tomb.reviewerComments, peer.name, previewStats);
        remoteAdded.set(id, candidate);
      }
      return;
    }
    const brought = clone(remote);
    brought.dialectVariants.forEach((item) => { item.origin = item.origin ?? peer.name; });
    brought.examples.forEach((item) => { item.origin = item.origin ?? peer.name; });
    brought.sources.forEach((item) => { item.origin = item.origin ?? peer.name; });
    brought.reviewerComments.forEach((item) => { item.origin = item.origin ?? peer.name; });
    remoteAdded.set(id, brought);
    previewStats.added += 1;
  });

  previewStats.tombstonesApplied =
    autoDeletedLocal.size + autoSuppressedRemote.size
    + bundle.tombstones.filter((tomb) => !localMap.has(tomb.entryId) && !blocked.has(tomb.entryId)).length;

  const plan: MergePlan = { bundle, fieldConflicts, deleteConflicts, previewStats: { ...previewStats } };

  const apply = (
    decisions: Record<string, 'local' | 'remote' | 'combine'>,
    deleteDecisions: Record<string, 'keep' | 'remove'>,
    nowIso: string
  ): MergeOutcome => {
    const stats: MergeReportStats = { ...previewStats };
    const entries: DictionaryEntry[] = [];
    // 本次重新裁决过的留痕先清掉，其余历史留痕保留。
    const keptDeletions = input.keptDeletions.filter((item) => !blocked.has(item.entryId));
    const pushKept = (entryId: string, direction: KeptDeletion['direction']) => {
      const tomb = allTombstones.get(entryId)!;
      keptDeletions.push({
        id: `kept-${entryId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        entryId, headword: localMap.get(entryId)?.headword ?? remoteMap.get(entryId)?.headword ?? '未命名词条',
        deletedAt: tomb.deletedAt, deletedByName: tomb.deletedByName,
        keptAt: nowIso, keptBy: replica.name, direction
      });
      stats.deletionsKept += 1;
    };

    localMap.forEach((local, id) => {
      if (autoDeletedLocal.has(id)) return;

      // 删除冲突（远程撤下、本地分叉编辑）优先处理，即使远程包里已无此词条。
      if (blocked.get(id) === 'remote-deletes-local-edited') {
        const choice = deleteDecisions[`del:${id}`] ?? 'keep';
        if (choice === 'remove') { stats.tombstonesApplied += 1; return; }
        pushKept(id, 'remote-deletes-local-edited');
        entries.push(clone(local));
        return;
      }

      const remote = remoteMap.get(id);
      if (!remote) { entries.push(clone(local)); return; }

      let base = merged.get(id) ?? clone(local);
      // 字段冲突裁决（删除冲突选“保留”后，字段冲突仍需裁决）。
      let resolvedHere = 0;
      fieldConflicts.filter((conflict) => conflict.entryId === id).forEach((conflict) => {
        const choice = decisions[conflict.key];
        if (!choice) return;
        if (choice === 'remote') (base as unknown as Record<string, unknown>)[conflict.field] = clone(remote![conflict.field]);
        if (choice === 'combine') {
          if (conflict.field === 'synonyms') base.synonyms = [...new Set([...local.synonyms, ...remote!.synonyms])];
          else (base as unknown as Record<string, unknown>)[conflict.field] = `${fieldText(local, conflict.field)}；${fieldText(remote!, conflict.field)}`;
        }
        const adopted = choice === 'local'
          ? `本副本·${conflict.localRev?.byName ?? '原始记录'}`
          : choice === 'remote'
            ? `${peer.name}·${conflict.remoteRev?.byName ?? '原始记录'}`
            : '两版拼接';
        base.fieldRevisions[conflict.field] = {
          vv: vvMax(conflict.localRev?.vv ?? {}, conflict.remoteRev?.vv ?? {}),
          by: replica.id, byName: `${replica.name}（合并裁决，采用${adopted}）`, at: nowIso
        };
        resolvedHere += 1;
        base.updatedAt = nowIso;
      });
      stats.conflictsResolved += resolvedHere;
      entries.push(base);
    });

    remoteAdded.forEach((candidate, id) => {
      if (blocked.has(id)) {
        const choice = deleteDecisions[`del:${id}`] ?? 'remove';
        if (choice === 'remove') { stats.tombstonesApplied += 1; return; }
        pushKept(id, blocked.get(id)!);
      }
      entries.push(clone(candidate));
    });

    const removedViaDeleteChoice = new Set<string>();
    deleteConflicts.forEach((conflict) => {
      const choice = deleteDecisions[conflict.key];
      // 默认选择：远程撤下本地有编辑 → 保留；本地撤下远程带回 → 撤下。
      if (choice === 'remove' || (!choice && conflict.defaultChoice === 'remove')) removedViaDeleteChoice.add(conflict.entryId);
    });
    const unresolvedFields = fieldConflicts
      .filter((conflict) => !removedViaDeleteChoice.has(conflict.entryId))
      .filter((conflict) => !decisions[conflict.key])
      .map((conflict) => conflict.key);
    const unresolvableDeletes = deleteConflicts.filter((conflict) => !deleteDecisions[conflict.key]).map((conflict) => conflict.key);

    return { entries, tombstones: [...allTombstones.values()], keptDeletions, stats, unresolvedFields, unresolvableDeletes };
  };

  return { plan, apply };
};

export const isBundleObject = (value: unknown): value is SyncBundle =>
  !!value && typeof value === 'object' && (value as SyncBundle).kind === 'sologsb-dictionary-sync';
