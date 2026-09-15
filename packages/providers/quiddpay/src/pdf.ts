/**
 * A minimal, valid PDF.
 *
 * Quid's payout receipt and evidence endpoints return a real file
 * (`application/pdf`, or PNG/JPEG for evidence), not JSON. An integration that
 * downloads one usually does something with the bytes — writes it to object
 * storage, checks the content type, attaches it to a ticket — and handing back
 * JSON where the contract says PDF would break exactly that code here while it
 * worked in production.
 *
 * So this emits a genuine one-page PDF: a hand-assembled document with a
 * correct cross-reference table, which every reader accepts. It is deliberately
 * tiny and carries no layout engine — paybox has no business growing a PDF
 * dependency to render a test receipt.
 *
 * Deterministic by construction: same input, same bytes. Nothing here reads a
 * clock or a random source.
 */

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function renderPdf(title: string, lines: readonly string[]): Buffer {
  const content = [
    'BT',
    '/F1 16 Tf',
    '72 720 Td',
    `(${escapePdfText(title)}) Tj`,
    '/F1 11 Tf',
    ...lines.flatMap((line) => ['0 -22 Td', `(${escapePdfText(line)}) Tj`]),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
