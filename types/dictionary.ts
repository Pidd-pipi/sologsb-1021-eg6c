export type EntryStatus = 'draft' | 'review' | 'disputed' | 'confirmed';

export interface DialectVariant {
  id: string;
  dialect: string;
  form: string;
  pronunciation: string;
  note: string;
}

export interface ExampleSentence {
  id: string;
  text: string;
  translation: string;
  source: string;
}

export interface DictionarySource {
  id: string;
  title: string;
  citation: string;
  url: string;
}

export interface ReviewComment {
  id: string;
  field: string;
  author: string;
  message: string;
  status: 'open' | 'resolved';
  createdAt: string;
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
}

export interface Tombstone {
  id: string;
  headword: string;
  deletedAt: string;
}

export interface FieldConflict {
  id: string;
  kind: 'field' | 'restore';
  entryId: string;
  entryHeadword: string;
  field: string;
  fieldLabel: string;
  itemId?: string;
  localRaw: unknown;
  remoteRaw: unknown;
  localText: string;
  remoteText: string;
  localAt: string;
  remoteAt: string;
  sourceName: string;
  mergedAt: string;
  remoteEntry?: DictionaryEntry;
}

export interface MergeReport {
  id: string;
  at: string;
  sourceName: string;
  added: number;
  merged: number;
  conflicts: number;
  protectedNotes: string[];
  withdrawnNotes: string[];
}

export interface MergeFailure {
  at: string;
  sourceName: string;
  error: string;
  position: string;
  payload: string;
}

export interface VersionRecord {
  id: string;
  at: string;
  action: string;
  detail: string;
  entryId?: string;
  before: DictionaryEntry[];
}

export interface AuditRecord {
  id: string;
  at: string;
  action: string;
  detail: string;
  entryIds: string[];
}

export interface DictionarySnapshot {
  revision: number;
  entries: DictionaryEntry[];
  versions: VersionRecord[];
  audit: AuditRecord[];
  tombstones?: Tombstone[];
  conflicts?: FieldConflict[];
  mergeReports?: MergeReport[];
}

export interface DuplicatePair {
  leftId: string;
  rightId: string;
  score: number;
  reasons: string[];
}
