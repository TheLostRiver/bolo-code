/** Result contracts shared by retained diff browse and approval overlays. */

export type DiffPaneBrowseResult =
  | { ok: true; reason: 'quit' }
  | { ok: false; reason: 'unsupported' | 'empty'; message: string }

export type DiffPaneApproveResult =
  | { ok: true; decision: 'allow' | 'deny' | 'allow_always' }
  | { ok: false; reason: 'unsupported' | 'empty'; message: string }

/** @deprecated Use DiffPaneBrowseResult. */
export type DiffPaneResult = DiffPaneBrowseResult
