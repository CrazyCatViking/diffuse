import type { DiffAnalysis, DiffAnalysisRow, DiffRow } from './protocol';

export const applyDiffAnalysis = (rows: DiffRow[], analysis: DiffAnalysis | undefined): DiffRow[] => {
  if (!analysis || analysis.rows.length === 0) return rows;

  const overlays = new Map(analysis.rows.map((row) => [analysisRowKey(row), row]));
  return rows.map((row) => {
    const overlay = overlays.get(diffRowKey(row));
    if (!overlay) return row;

    return {
      ...row,
      oldDiffSpans: overlay.oldDiffSpans,
      newDiffSpans: overlay.newDiffSpans,
      changeGroupId: overlay.changeGroupId,
      changeRole: overlay.changeRole,
      changeConfidence: overlay.changeConfidence,
      symbol: overlay.symbol ?? row.symbol,
      semanticSummary: overlay.semanticSummary,
    };
  });
};

const diffRowKey = (row: DiffRow) => `${row.kind}:${row.oldLine ?? ''}:${row.newLine ?? ''}`;

const analysisRowKey = (row: DiffAnalysisRow) => `${row.kind}:${row.oldLine ?? ''}:${row.newLine ?? ''}`;
