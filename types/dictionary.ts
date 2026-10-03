export type EntryStatus = 'draft' | 'review' | 'disputed' | 'confirmed';

/** 版本向量：记录每个副本对该对象的修改计数，用于离线副本之间判断因果先后。 */
export type VersionVector = Record<string, number>;

/** 字段级修订戳：标明某字段最后一次由哪个副本、在何时修改。 */
export interface FieldRevision {
  vv: VersionVector;
  by: string;
  byName: string;
  at: string;
}

export interface DialectVariant {
  id: string;
  dialect: string;
  form: string;
  pronunciation: string;
  note: string;
  /** 合并自其他副本时标注来源副本，本副本新建时为空。 */
  origin?: string;
}

export interface ExampleSentence {
  id: string;
  text: string;
  translation: string;
  source: string;
  origin?: string;
}

export interface DictionarySource {
  id: string;
  title: string;
  citation: string;
  url: string;
  origin?: string;
}

export interface ReviewComment {
  id: string;
  field: string;
  author: string;
  message: string;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt?: string;
  origin?: string;
  /** 意见状态（解决/重开）的版本向量，旧副本不能把已解决意见改回待处理。 */
  vv?: VersionVector;
  replies: Array<{ id: string; author: string; message: string; createdAt: string }>;
}

export interface DictionaryEntry {
  id: string;
  headword: string;
  pronunciation: string;
  partOfSpeech: string;
  definition: string;
  dialectVariants: DialectVariant[];
  examples: ExampleSentence[];
  sources: DictionarySource[];
  synonyms: string[];
  status: EntryStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
  reviewerComments: ReviewComment[];
  /** 词条级版本向量。 */
  vv: VersionVector;
  /** 每个可合并标量字段（含同义词、状态）最后一次修订的来源与时间。 */
  fieldRevisions: Partial<Record<string, FieldRevision>>;
}

/** 删除墓碑：撤下的词条随同步包传播，防止旧副本把它悄悄带回来。 */
export interface EntryTombstone {
  id: string;
  entryId: string;
  headword: string;
  deletedAt: string;
  deletedBy: string;
  deletedByName: string;
  vv: VersionVector;
  /** 词条被撤下时保留其全部审校意见，审校意见不随删除丢失。 */
  reviewerComments: ReviewComment[];
}

/** 因本地有更新内容而拒绝执行的撤下记录（“撤下没有悄悄生效/复活”的留痕）。 */
export interface KeptDeletion {
  id: string;
  entryId: string;
  headword: string;
  deletedAt: string;
  deletedByName: string;
  keptAt: string;
  keptBy: string;
  direction: 'remote-deletes-local-edited' | 'local-deleted-remote-edited';
}

export interface MergeSourceInfo {
  bundleAt: string;
  peerId: string;
  peerName: string;
}

export interface VersionRecord {
  id: string;
  at: string;
  action: string;
  detail: string;
  entryId?: string;
  before: DictionaryEntry[];
  /** 合并产生的版本记录用它说明“这次合并来自哪个副本”。 */
  beforeTombstones?: EntryTombstone[];
  mergeFrom?: MergeSourceInfo;
}

export interface AuditRecord {
  id: string;
  at: string;
  action: string;
  detail: string;
  entryIds: string[];
}

export interface MergeReportStats {
  added: number;
  updated: number;
  fieldsAutoRemote: number;
  conflictsResolved: number;
  tombstonesApplied: number;
  resurrectionsBlocked: number;
  deletionsKept: number;
  commentsImported: number;
}

/** 每次尝试合并（成功或失败）都留下记录，失败记录包含失败位置。 */
export interface MergeReport {
  id: string;
  at: string;
  ok: boolean;
  stage: string;
  failurePoint?: string;
  peerId: string;
  peerName: string;
  detail: string;
  stats: MergeReportStats;
}

/** 同事副本导出的同步包。 */
export interface SyncBundle {
  kind: 'sologsb-dictionary-sync';
  schema: 1;
  exportedAt: string;
  replicaId: string;
  replicaName: string;
  entries: DictionaryEntry[];
  tombstones: EntryTombstone[];
}

/** 未完成的合并：持久化到浏览器，断网或失败后可恢复并再次合并。 */
export interface PendingMerge {
  id: string;
  savedAt: string;
  failedAt?: string;
  stage: string;
  failurePoint?: string;
  bundle: SyncBundle;
  /** 键为 `${entryId}:${field}` 的冲突裁决。 */
  decisions: Record<string, 'local' | 'remote' | 'combine'>;
  /** 键为 `del:${entryId}` 的删除冲突裁决。 */
  deleteDecisions: Record<string, 'keep' | 'remove'>;
}

export interface DictionarySnapshot {
  revision: number;
  replicaId: string;
  replicaName: string;
  entries: DictionaryEntry[];
  tombstones: EntryTombstone[];
  keptDeletions: KeptDeletion[];
  pendingMerge: PendingMerge | null;
  mergeReports: MergeReport[];
  versions: VersionRecord[];
  audit: AuditRecord[];
}

export interface DuplicatePair {
  leftId: string;
  rightId: string;
  score: number;
  reasons: string[];
}
