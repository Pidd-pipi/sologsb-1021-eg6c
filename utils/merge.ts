import type {
  DictionaryEntry, DictionarySnapshot, FieldConflict, MergeReport, ReviewComment, Tombstone
} from '~/types/dictionary';

export class MergeError extends Error {
  position: string;
  constructor(message: string, position: string) {
    super(message);
    this.name = 'MergeError';
    this.position = position;
  }
}

export const MERGE_FIELD_LABELS: Record<string, string> = {
  headword: '词形',
  pronunciation: '发音',
  partOfSpeech: '词性',
  definition: '释义',
  notes: '编者备注',
  status: '状态',
  synonyms: '同义词',
  dialectVariants: '方言变体',
  examples: '例句',
  sources: '来源'
};

const STATUS_LABELS: Record<string, string> = { draft: '草稿', review: '待审', disputed: '争议', confirmed: '已确认' };

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newer = (left: string, right: string) => (left >= right ? left : right);

const SCALAR_FIELDS = ['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes'] as const;
const LIST_FIELDS = ['dialectVariants', 'examples', 'sources'] as const;

const displayValue = (field: string, value: unknown): string => {
  if (field === 'status') return STATUS_LABELS[value as string] ?? String(value ?? '—');
  if (typeof value === 'string') return value.trim() ? value : '（空）';
  return JSON.stringify(value, null, 2);
};

const locateJsonError = (text: string, message: string): string => {
  const match = /position\s+(\d+)/i.exec(message);
  const offset = match ? Number(match[1]) : 0;
  const lines = text.slice(0, offset).split('\n');
  return `第 ${lines.length} 行第 ${(lines.at(-1)?.length ?? 0) + 1} 列`;
};

export function parsePackage(text: string): DictionarySnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MergeError(`JSON 解析失败：${message}`, locateJsonError(text, message));
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MergeError('副本文件不是有效的词典备份对象', '根节点');
  }
  const snapshot = raw as Partial<DictionarySnapshot>;
  if (!Array.isArray(snapshot.entries)) {
    throw new MergeError('副本文件缺少 entries 词条数组', '根节点.entries');
  }
  snapshot.entries.forEach((entry, index) => {
    const where = `entries[${index}]${entry?.headword ? `（${entry.headword}）` : ''}`;
    if (typeof entry !== 'object' || entry === null) throw new MergeError('词条记录不是对象', where);
    if (typeof entry.id !== 'string' || !entry.id) throw new MergeError('词条缺少 id', where);
    if (typeof entry.headword !== 'string') throw new MergeError('词条缺少词形 headword', where);
    (['dialectVariants', 'examples', 'sources', 'synonyms', 'reviewerComments'] as const).forEach((key) => {
      if (!Array.isArray(entry[key])) throw new MergeError(`词条字段 ${key} 不是数组`, `${where}.${key}`);
    });
  });
  return snapshot as DictionarySnapshot;
}

const mergeComments = (
  local: ReviewComment[],
  remote: ReviewComment[],
  protectedNotes: string[],
  headword: string
): ReviewComment[] => {
  const merged = clone(local);
  remote.forEach((remoteComment) => {
    const existing = merged.find((comment) => comment.id === remoteComment.id);
    if (!existing) {
      merged.push(clone(remoteComment));
      return;
    }
    remoteComment.replies.forEach((reply) => {
      if (!existing.replies.some((item) => item.id === reply.id)) existing.replies.push(clone(reply));
    });
    if (existing.status !== remoteComment.status && remoteComment.status === 'resolved') {
      existing.status = 'resolved';
    }
    if (existing.status !== remoteComment.status && existing.status === 'resolved') {
      protectedNotes.push(`“${headword}”已解决的审校意见未被旧副本重新打开`);
    }
  });
  return merged;
};

export interface MergeOutcome {
  entries: DictionaryEntry[];
  tombstones: Tombstone[];
  conflicts: FieldConflict[];
  report: MergeReport;
}

export function mergeSnapshot(
  local: { entries: DictionaryEntry[]; tombstones: Tombstone[] },
  remote: DictionarySnapshot,
  sourceName: string
): MergeOutcome {
  const mergedAt = new Date().toISOString();
  const entries = clone(local.entries);
  const tombstones = clone(local.tombstones);
  const conflicts: FieldConflict[] = [];
  const protectedNotes: string[] = [];
  const withdrawnNotes: string[] = [];
  let added = 0;
  let mergedCount = 0;

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const tombstoneById = new Map(tombstones.map((stone) => [stone.id, stone]));

  const pushConflict = (partial: Omit<FieldConflict, 'id' | 'sourceName' | 'mergedAt'>) => {
    conflicts.push({ ...partial, id: uid('conflict'), sourceName, mergedAt });
  };

  (remote.entries ?? []).forEach((remoteEntry) => {
    const stone = tombstoneById.get(remoteEntry.id);
    if (stone) {
      if (remoteEntry.updatedAt <= stone.deletedAt) {
        withdrawnNotes.push(`“${remoteEntry.headword}”已在本地撤下，旧副本中的版本未恢复`);
      } else {
        pushConflict({
          kind: 'restore',
          entryId: remoteEntry.id,
          entryHeadword: remoteEntry.headword,
          field: 'entry',
          fieldLabel: '词条撤下',
          localRaw: null,
          remoteRaw: clone(remoteEntry),
          localText: `本地已于 ${new Date(stone.deletedAt).toLocaleString('zh-CN')} 撤下`,
          remoteText: `副本中仍有更新：${remoteEntry.headword}`,
          localAt: stone.deletedAt,
          remoteAt: remoteEntry.updatedAt,
          remoteEntry: clone(remoteEntry)
        });
      }
      return;
    }

    const localEntry = byId.get(remoteEntry.id);
    if (!localEntry) {
      const fresh = clone(remoteEntry);
      entries.push(fresh);
      byId.set(fresh.id, fresh);
      added += 1;
      return;
    }

    mergedCount += 1;
    const localConfirmed = localEntry.status === 'confirmed';
    const remoteIsOlder = remoteEntry.updatedAt <= localEntry.updatedAt;

    SCALAR_FIELDS.forEach((field) => {
      if (localEntry[field] === remoteEntry[field]) return;
      if (localConfirmed && remoteIsOlder) {
        protectedNotes.push(`“${localEntry.headword}”的${MERGE_FIELD_LABELS[field]}已确认，未被旧副本覆盖`);
        return;
      }
      pushConflict({
        kind: 'field',
        entryId: localEntry.id,
        entryHeadword: localEntry.headword,
        field,
        fieldLabel: MERGE_FIELD_LABELS[field] ?? field,
        localRaw: localEntry[field],
        remoteRaw: remoteEntry[field],
        localText: displayValue(field, localEntry[field]),
        remoteText: displayValue(field, remoteEntry[field]),
        localAt: localEntry.updatedAt,
        remoteAt: remoteEntry.updatedAt
      });
    });

    if (localEntry.status !== remoteEntry.status) {
      if (localConfirmed && remoteIsOlder) {
        protectedNotes.push(`“${localEntry.headword}”的已确认状态未被旧副本改为${STATUS_LABELS[remoteEntry.status] ?? remoteEntry.status}`);
      } else if (remoteEntry.status === 'confirmed' && !remoteIsOlder) {
        localEntry.status = 'confirmed';
      } else {
        pushConflict({
          kind: 'field',
          entryId: localEntry.id,
          entryHeadword: localEntry.headword,
          field: 'status',
          fieldLabel: MERGE_FIELD_LABELS.status ?? '状态',
          localRaw: localEntry.status,
          remoteRaw: remoteEntry.status,
          localText: displayValue('status', localEntry.status),
          remoteText: displayValue('status', remoteEntry.status),
          localAt: localEntry.updatedAt,
          remoteAt: remoteEntry.updatedAt
        });
      }
    }

    const synonymSet = new Set(localEntry.synonyms);
    remoteEntry.synonyms.forEach((word) => {
      if (!synonymSet.has(word)) {
        localEntry.synonyms.push(word);
        synonymSet.add(word);
      }
    });

    LIST_FIELDS.forEach((field) => {
      const localList = localEntry[field] as Array<{ id: string }>;
      (remoteEntry[field] as Array<{ id: string }>).forEach((remoteItem) => {
        const localItem = localList.find((item) => item.id === remoteItem.id);
        if (!localItem) {
          localList.push(clone(remoteItem));
          return;
        }
        if (JSON.stringify(localItem) === JSON.stringify(remoteItem)) return;
        if (localConfirmed && remoteIsOlder) {
          protectedNotes.push(`“${localEntry.headword}”的${MERGE_FIELD_LABELS[field]}已确认，未被旧副本覆盖`);
          return;
        }
        pushConflict({
          kind: 'field',
          entryId: localEntry.id,
          entryHeadword: localEntry.headword,
          field,
          fieldLabel: MERGE_FIELD_LABELS[field] ?? field,
          itemId: remoteItem.id,
          localRaw: clone(localItem),
          remoteRaw: clone(remoteItem),
          localText: displayValue(field, localItem),
          remoteText: displayValue(field, remoteItem),
          localAt: localEntry.updatedAt,
          remoteAt: remoteEntry.updatedAt
        });
      });
    });

    localEntry.reviewerComments = mergeComments(localEntry.reviewerComments, remoteEntry.reviewerComments, protectedNotes, localEntry.headword);
    localEntry.updatedAt = newer(localEntry.updatedAt, remoteEntry.updatedAt);
  });

  (remote.tombstones ?? []).forEach((remoteStone) => {
    if (tombstoneById.has(remoteStone.id)) return;
    const localEntry = byId.get(remoteStone.id);
    if (!localEntry) {
      tombstones.push(clone(remoteStone));
      tombstoneById.set(remoteStone.id, remoteStone);
      return;
    }
    if (localEntry.updatedAt <= remoteStone.deletedAt) {
      entries.splice(entries.findIndex((entry) => entry.id === localEntry.id), 1);
      byId.delete(localEntry.id);
      tombstones.push(clone(remoteStone));
      tombstoneById.set(remoteStone.id, remoteStone);
      withdrawnNotes.push(`“${remoteStone.headword}”按副本「${sourceName}」的撤下记录移除`);
    } else {
      protectedNotes.push(`“${localEntry.headword}”在对方撤下后仍有本地修改，未按副本撤下`);
    }
  });

  const report: MergeReport = {
    id: uid('merge'),
    at: mergedAt,
    sourceName,
    added,
    merged: mergedCount,
    conflicts: conflicts.length,
    protectedNotes,
    withdrawnNotes
  };
  return { entries, tombstones, conflicts, report };
}
