import { describe, expect, it } from 'vitest';
import { sheetHeader, sheetRow, spreadsheetIdFromUrl } from '../sheets.js';

describe('Google Sheets rows', () => {
  it('parses sheet URLs', () => {
    expect(spreadsheetIdFromUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(spreadsheetIdFromUrl('https://evil.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz')).toBeNull();
  });

  it('formats a row with one column per question', () => {
    expect(sheetHeader([1, 2])).toEqual(['Candidate', 'Attempt ID', 'Started (UTC)', 'Submitted (UTC)', 'Score', 'Percentage', 'Result', 'Duration (min)', 'Q1', 'Q2']);
    const row = sheetRow(
      { name: '=cmd', id: 'x', startedAt: new Date('2026-10-01T10:00:00Z'), submittedAt: new Date('2026-10-01T10:21:00Z'), correct: 21, total: 30, pct: 70, passMark: 21, durationSec: 1260, answers: { 1: 'A' } },
      [1, 2],
    );
    expect(row).toEqual(['=cmd', 'x', '2026-10-01 10:00', '2026-10-01 10:21', '21/30', 70, 'Pass', 21, 'A', '']);
  });
});
