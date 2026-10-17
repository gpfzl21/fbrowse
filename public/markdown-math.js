/* Math is tokenized before Markdown escaping/emphasis, then rendered only after
 * the surrounding Markdown HTML has been sanitized. Code spans/fences stay code.
 */
(() => {
  'use strict';
  const environments = /^(\\begin\{((?:equation|align|alignat|gather)\*?)\})/;
  const starts = /\$|\\[([]|\\begin\{(?:equation|align|alignat|gather)\*?\}/;
  function formula(source, budget) {
    if (budget.remaining <= 0) return;
    let left, right, display = false, environment = false;
    const match = environments.exec(source);
    if (match) { left = match[1]; right = `\\end{${match[2]}}`; display = environment = true; }
    else if (source.startsWith('$$')) { left = right = '$$'; display = true; }
    else if (source.startsWith('\\[')) { left = '\\['; right = '\\]'; display = true; }
    else if (source.startsWith('\\(')) { left = '\\('; right = '\\)'; }
    else if (source.startsWith('$') && !/^\$\s/.test(source)) left = right = '$';
    else return;
    let depth = 0, backslashes = 0;
    for (let end = left.length; end < source.length; end++) {
      if (--budget.remaining < 0) { budget.limited = true; return; }
      if (left === '$' && source[end] === '\n') return;
      const escaped = backslashes % 2 === 1;
      backslashes = source[end] === '\\' ? backslashes + 1 : 0;
      if (escaped) continue;
      if (depth === 0 && source.startsWith(right, end)) {
        // Avoid interpreting '$5 and $10' or '$ x $' as inline mathematics.
        if (left === '$' && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] || ''))) continue;
        const raw = source.slice(0, end + right.length);
        return { raw, tex: environment ? raw : source.slice(left.length, end), display };
      }
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && depth) depth--;
    }
  }
  window.fbrowseMath = {
    parse(source, marked) {
      const formulas = [];
      // Malformed repeated openers must not cause quadratic rescanning.
      const budget = { remaining: 2_000_000, limited: false };
      const marker = 'data-fbrowse-math-' + crypto.randomUUID();
      function placeholder(token) {
        const index = formulas.push(token) - 1;
        const tag = token.display ? 'div' : 'span';
        return `<${tag} ${marker}="${index}" class="math-${token.display ? 'display' : 'inline'}"></${tag}>`;
      }
      const parser = new marked.Marked({ gfm: true });
      parser.use({ extensions: [
        {
          name: 'fbrowseMathBlock', level: 'block',
          start(text) { return /(?:^|\n)[ \t]{0,3}(?:\$\$|\\\[|\\begin\{(?:equation|align|alignat|gather)\*?\})/.exec(text)?.index; },
          tokenizer(text) {
            const indent = /^[ \t]{0,3}/.exec(text)[0];
            const token = formula(text.slice(indent.length), budget);
            if (!token?.display || !/^[ \t]*(?:\n|$)/.test(text.slice(indent.length + token.raw.length))) return;
            return { ...token, type: 'fbrowseMathBlock', raw: indent + token.raw };
          },
          renderer: placeholder,
        },
        {
          name: 'fbrowseMathInline', level: 'inline',
          start(text) { const index = text.search(starts); return index < 0 ? undefined : index; },
          tokenizer(text) {
            const token = formula(text, budget);
            if (token) return { ...token, type: 'fbrowseMathInline' };
          },
          // A display delimiter embedded in a paragraph must still produce valid HTML.
          renderer(token) { return placeholder({ ...token, display: false, mathDisplay: token.display }); },
        },
      ], renderer: {
        code(token) {
          if (token.lang?.trim() !== 'math') return false;
          return placeholder({ raw: token.raw, tex: token.text, display: true });
        },
      } });
      const html = parser.parse(source);
      return { html, formulas, marker, limited: budget.limited };
    },
    render(article, parsed, katex) {
      let failed = parsed.limited ? 1 : 0;
      for (const element of article.querySelectorAll(`[${parsed.marker}]`)) {
        const index = Number(element.getAttribute(parsed.marker));
        const token = parsed.formulas[index];
        element.removeAttribute(parsed.marker);
        if (element.closest('pre,code,kbd,samp,script,style,textarea')) {
          element.replaceWith(document.createTextNode(token.raw));
          continue;
        }
        try {
          if (index >= 1000 || token.tex.length > 20000) throw Error('Math rendering size limit exceeded.');
          katex.render(token.tex, element, { displayMode: token.display || token.mathDisplay,
            throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20,
            output: 'htmlAndMathml', macros: {} });
        } catch (error) {
          failed++;
          element.classList.add('math-error');
          element.textContent = token.raw;
          element.title = 'Math source: ' + error.message;
        }
      }
      return failed;
    },
  };
})();
