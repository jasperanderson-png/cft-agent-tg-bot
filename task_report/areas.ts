// The area of a task ("Топливо", "Лиды"…) when nobody gave one: guessed from words in it, so the
// reports can group tasks. Unclear tasks go under "Другое" rather than a wrong area.

export const OTHER_AREA = 'Другое';

const RULES: [RegExp, string][] = [
  [/топлив|дизел|заправ|дискаунт|скидк|\bцен[аыуе]?\b|fuel|pilot|love'?s|petro|speedway/i, 'Топливо'],
  [/\bлид|водител|fmcsa|перевозчик|carrier/i, 'Лиды'],
  [/академи|кандидат|\bтест/i, 'Академия'],
  [/агент/i, 'Агенты'],
  [/отчёт|отчет|смен[аыу]\b/i, 'Отчёты'],
  [/мини.?апп|mini.?app|\bбот|ui\/?ux|дизайн|интерфейс|telegram|телеграм/i, 'Бот'],
];

export function areaOf(e: { area: string | null; text: string }): string {
  if (e.area) return e.area;
  for (const [re, area] of RULES) if (re.test(e.text)) return area;
  return OTHER_AREA;
}
