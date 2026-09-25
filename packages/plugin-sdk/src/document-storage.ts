/** Generic document storage contract shared with the SDK 0.3 compatibility line. */
export type DocumentStorageLocationKind = "data" | "program" | "custom";

export interface ResolvedDocumentStorageLocation {
  kind: DocumentStorageLocationKind;
  path: string;
}

export interface DocumentReadResult {
  content: string;
  /** Opaque CAS token, passed back unchanged. */
  version: string;
}

export interface DocumentWriteResult {
  version: string;
}

export interface DocumentStorage {
  getLocation(): Promise<ResolvedDocumentStorageLocation>;
  /** Custom selection opens the host picker; no arbitrary caller path. */
  selectLocation(kind: DocumentStorageLocationKind): Promise<ResolvedDocumentStorageLocation>;
  readText(relativePath: string): Promise<DocumentReadResult | null>;
  /** null only creates a document that does not yet exist. */
  writeTextAtomic(relativePath: string, content: string, expectedVersion: string | null): Promise<DocumentWriteResult>;
  remove(relativePath: string, expectedVersion?: string | null): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
