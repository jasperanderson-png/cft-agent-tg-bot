import { toCSV, csvFilename, type CsvColumn } from '../../../../../../shared/csv';
import { adminApi } from '../../../lib/api';
import { canTelegramDownload, telegramDownload } from '../../../lib/telegram';

/** Saves a CSV: a normal browser download, or Telegram's download sheet inside the Mini App. */
export async function exportCsv<T>(kind: string, cols: CsvColumn<T>[], rows: T[]): Promise<void> {
  const filename = csvFilename(kind);
  const csv = toCSV(cols, rows);
  if (canTelegramDownload()) {
    const { path } = await adminApi.exportFile(filename, csv);
    telegramDownload(location.origin + path, filename);
    return;
  }
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
