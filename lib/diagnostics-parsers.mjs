// Fixed package parsers only: no project config, imports, plugins or evaluation.
// Invoked in a disposable subprocess so parsing shares the checker time budget.
export async function parseText(mode, text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const position = offset => {
    offset = Math.max(0, Math.min(text.length, offset));
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle; else high = middle - 1;
    }
    return { line: low + 1, column: Array.from(text.slice(starts[low], offset)).length + 1 };
  };
  const item = (start, end, code, message, severity = 'error') => {
    const from = position(start), to = position(Math.max(start, end));
    return { ...from, end_line: to.line, end_column: to.column, severity,
      code, message: message.slice(0, 1000) };
  };
  if (mode === 'json') {
    const { visit, printParseErrorCode } = await import('jsonc-parser');
    const errors = [];
    // Visitor validates without constructing JS objects, including __proto__.
    visit(text, { onError: (code, offset, length) => {
      if (errors.length < 200) errors.push(item(offset, offset + length, printParseErrorCode(code), printParseErrorCode(code)));
    } }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
    return errors;
  }
  if (mode === 'yaml') {
    const { parseAllDocuments } = await import('yaml');
    // Keep ASTs; never call toJS/toJSON (which resolves aliases). Unknown tags
    // stay warnings, with no custom resolvers or project schema loaded.
    const docs = parseAllDocuments(text, { prettyErrors: false, strict: true, uniqueKeys: true, customTags: [] });
    const errors = [];
    for (const doc of docs) for (const [values, severity] of [[doc.errors, 'error'], [doc.warnings, 'warning']]) {
      for (const value of values) {
        if (errors.length === 200) return errors;
        errors.push(item(value.pos[0], value.pos[1], value.code, value.message, severity));
      }
    }
    return errors;
  }
  const { parse } = await import('@babel/parser');
  const typescript = ['.ts', '.tsx', '.d.ts'].includes(mode);
  const plugins = [];
  if (typescript) plugins.push(['typescript', { dts: mode === '.d.ts' }]);
  if (['.jsx', '.tsx'].includes(mode)) plugins.push('jsx');
  const options = { sourceType: mode === '.mjs' ? 'module' : mode === '.cjs' ? 'commonjs' : 'unambiguous',
    plugins, errorRecovery: true, attachComment: false, tokens: false };
  let errors;
  try { errors = parse(text, options).errors; }
  catch (error) {
    if (!Number.isSafeInteger(error.pos)) throw error;
    errors = [error];
  }
  return errors.slice(0, 200).map(error => item(error.pos,
    error.pos + (text.codePointAt(error.pos) > 0xffff ? 2 : error.pos < text.length ? 1 : 0),
    error.reasonCode || error.code, error.message.replace(/\s*\(\d+:\d+\)$/, '')));
}
