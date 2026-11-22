// A small CSV reader (RFC 4180): commas, "quoted fields", "" for a quote inside quotes, line breaks
// inside quotes, CRLF or LF, and a leading UTF-8 BOM. Completely empty lines are skipped.
// Returns { rows: string[][] } or throws an Error with a fixed message (no file content is echoed).
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // skip empty lines
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        // after a closing quote only a comma or the end of the line may follow
        if (i < src.length && ![',', '\r', '\n'].includes(src[i])) throw new Error('Text after a closing quote');
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field !== '') throw new Error('A quote may only start a field');
      quoted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
    i += 1;
  }
  if (quoted) throw new Error('A quoted field is not closed');
  if (field !== '' || row.length > 0) endRow();
  return { rows };
}
