/**
 * Generates an HTML page that renders delegate JSONL logs as a chat-like view.
 * Styled to closely match the Bobbit chat window.
 */

export function generateLogViewerHtml(logId: string, rawUrl: string): string {
	const script = [
		"(function() {",
		"  var container = document.getElementById('messages');",
		"  var meta = document.getElementById('meta');",
		"  var rawUrl = " + JSON.stringify(rawUrl) + ";",
		"  var msgCount = 0;",
		"",
		"  document.addEventListener('click', function(e) {",
		"    var el = e.target.closest('.collapsible-hdr');",
		"    if (!el) return;",
		"    var content = el.nextElementSibling;",
		"    var chevron = el.querySelector('.chevron');",
		"    if (content) {",
		"      var open = content.classList.toggle('expanded');",
		"      if (chevron) chevron.textContent = open ? '\\u25BC' : '\\u25B6';",
		"    }",
		"  });",
		"",
		"  function esc(s) {",
		"    var d = document.createElement('div');",
		"    d.appendChild(document.createTextNode(s));",
		"    return d.innerHTML;",
		"  }",
		"",
		"  function truncate(s, max) {",
		"    if (s.length <= max) return s;",
		"    return s.slice(0, max) + '\\n...(' + (s.length - max) + ' chars truncated)';",
		"  }",
		"",
		"  function textFromContent(content) {",
		"    if (!content) return '';",
		"    if (typeof content === 'string') return content;",
		"    if (Array.isArray(content)) {",
		"      return content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text || ''; }).join('\\n');",
		"    }",
		"    return JSON.stringify(content);",
		"  }",
		"",
		"  function fmtCost(u) {",
		"    if (!u || !u.cost || u.cost.total === 0) return '';",
		"    return '<div class=\"cost\">$' + u.cost.total.toFixed(4) +",
		"      ' \\u00b7 ' + (u.input||0) + ' in \\u00b7 ' + (u.output||0) +",
		"      ' out \\u00b7 ' + (u.cacheRead||0) + ' cache</div>';",
		"  }",
		"",
		"  function addAssistantText(text, usage) {",
		"    var div = document.createElement('div');",
		"    div.className = 'msg assistant-msg';",
		"    div.innerHTML = '<div class=\"msg-body\">' + esc(text) + '</div>' + fmtCost(usage);",
		"    container.appendChild(div);",
		"    msgCount++;",
		"  }",
		"",
		"  function addToolCall(name, args, defaultOpen) {",
		"    var div = document.createElement('div');",
		"    div.className = 'msg tool-msg';",
		"    var argsStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);",
		"    var truncArgs = truncate(argsStr, 3000);",
		"    var chevronChar = defaultOpen ? '\\u25BC' : '\\u25B6';",
		"    var expandedClass = defaultOpen ? ' expanded' : '';",
		"    div.innerHTML =",
		"      '<div class=\"collapsible-hdr\">' +",
		"        '<span class=\"tool-icon\">\\u2699</span>' +",
		"        '<span class=\"tool-name\">' + esc(name) + '</span>' +",
		"        '<span class=\"tool-summary\">' + esc(summarize(argsStr)) + '</span>' +",
		"        '<span class=\"chevron\">' + chevronChar + '</span>' +",
		"      '</div>' +",
		"      '<div class=\"collapsible-body' + expandedClass + '\">' +",
		"        '<pre class=\"tool-pre\">' + esc(truncArgs) + '</pre>' +",
		"      '</div>';",
		"    container.appendChild(div);",
		"    msgCount++;",
		"  }",
		"",
		"  function summarize(s) {",
		"    var line = s.split('\\n')[0].trim();",
		"    if (line.length > 80) return line.slice(0, 80) + '\\u2026';",
		"    return line;",
		"  }",
		"",
		"  function addToolResult(content, isError, toolName) {",
		"    var div = document.createElement('div');",
		"    div.className = 'msg tool-result-msg';",
		"    var text = textFromContent(content);",
		"    var truncText = truncate(text, 5000);",
		"    var statusCls = isError ? 'status-err' : 'status-ok';",
		"    var statusIcon = isError ? '\\u2717' : '\\u2713';",
		"    var chevronChar = '\\u25BC';",
		"    div.innerHTML =",
		"      '<div class=\"collapsible-hdr\">' +",
		"        '<span class=\"' + statusCls + '\">' + statusIcon + '</span>' +",
		"        '<span class=\"tool-result-label\">' + (toolName || 'Result') + '</span>' +",
		"        '<span class=\"chevron\">' + chevronChar + '</span>' +",
		"      '</div>' +",
		"      '<div class=\"collapsible-body expanded\">' +",
		"        '<pre class=\"tool-pre\">' + esc(truncText) + '</pre>' +",
		"      '</div>';",
		"    container.appendChild(div);",
		"    msgCount++;",
		"  }",
		"",
		"  function addEvent(label) {",
		"    var div = document.createElement('div');",
		"    div.className = 'event-divider';",
		"    div.innerHTML = '<span>' + esc(label) + '</span>';",
		"    container.appendChild(div);",
		"  }",
		"",
		"  var lastToolName = '';",
		"  function processLine(line) {",
		"    line = line.trim();",
		"    if (!line) return;",
		"    var ev;",
		"    try { ev = JSON.parse(line); } catch(e) { return; }",
		"",
		"    switch (ev.type) {",
		"      case 'agent_start': addEvent('Agent started'); break;",
		"      case 'agent_end': addEvent('Agent finished'); break;",
		"",
		"      case 'message_end':",
		"        if (ev.message && ev.message.role === 'assistant') {",
		"          var text = textFromContent(ev.message.content);",
		"          if (text) addAssistantText(text, ev.message.usage);",
		"          if (Array.isArray(ev.message.content)) {",
		"            ev.message.content.forEach(function(c) {",
		"              if (c.type === 'toolCall') {",
		"                lastToolName = c.name;",
		"                var shouldExpand = (c.name === 'bash' || c.name === 'edit' || c.name === 'write');",
		"                addToolCall(c.name, c.arguments, shouldExpand);",
		"              }",
		"            });",
		"          }",
		"        }",
		"        if (ev.message && ev.message.role === 'tool') {",
		"          if (Array.isArray(ev.message.content)) {",
		"            ev.message.content.forEach(function(c) {",
		"              if (c.type === 'toolResult') addToolResult(c.content, c.isError, lastToolName);",
		"            });",
		"          }",
		"        }",
		"        break;",
		"",
		"      default: break;",
		"    }",
		"  }",
		"",
		"  fetch(rawUrl).then(function(resp) {",
		"    if (!resp.ok) { container.innerHTML = '<div class=\"empty\">Failed to load: ' + resp.status + '</div>'; return; }",
		"    return resp.text();",
		"  }).then(function(text) {",
		"    if (!text) return;",
		"    container.innerHTML = '';",
		"    var lines = text.split('\\n');",
		"    lines.forEach(processLine);",
		"    if (msgCount === 0) container.innerHTML = '<div class=\"empty\">No renderable events.</div>';",
		"    meta.textContent = lines.filter(function(l) { return l.trim(); }).length + ' events';",
		"    window.scrollTo(0, document.body.scrollHeight);",
		"  }).catch(function(e) {",
		"    container.innerHTML = '<div class=\"empty error\">Error: ' + esc(e.message) + '</div>';",
		"  });",
		"})();",
	].join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delegate Log — ${logId}</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: oklch(0.21 0.008 145); color: oklch(0.96 0.008 140);
    line-height: 1.6; min-height: 100vh;
  }

  /* Header — sticky top bar */
  .header {
    position: sticky; top: 0; z-index: 10;
    background: oklch(0.24 0.008 145); border-bottom: 1px solid oklch(0.30 0.012 145);
    padding: 8px 16px; display: flex; align-items: center; gap: 12px;
    backdrop-filter: blur(8px);
  }
  .header h1 { font-size: 14px; font-weight: 600; }
  .header .meta { font-size: 11px; color: oklch(0.55 0.012 140); margin-left: auto; }
  .header a {
    font-size: 11px; color: oklch(0.55 0.012 140); text-decoration: none;
    padding: 2px 8px; border: 1px solid oklch(0.30 0.012 145); border-radius: 4px;
  }
  .header a:hover { color: oklch(0.75 0.012 140); border-color: oklch(0.40 0.012 145); }

  /* Message container */
  .messages { padding: 16px 16px 48px; max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 2px; }

  /* Assistant text messages */
  .assistant-msg {
    padding: 8px 0;
  }
  .msg-body {
    white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.6;
  }
  .cost {
    font-size: 11px; color: oklch(0.50 0.01 140); margin-top: 4px;
  }

  /* Tool call — collapsible with icon header */
  .tool-msg, .tool-result-msg {
    margin: 2px 0;
  }
  .collapsible-hdr {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    padding: 6px 8px; border-radius: 6px; font-size: 13px;
    color: oklch(0.65 0.012 140);
    user-select: none; transition: background 0.15s;
  }
  .collapsible-hdr:hover { background: oklch(0.25 0.008 145); }
  .tool-icon { font-size: 14px; color: oklch(0.60 0.10 85); }
  .tool-name {
    font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
    font-weight: 600; font-size: 13px; color: oklch(0.65 0.012 140);
  }
  .tool-summary {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
    font-size: 12px; color: oklch(0.50 0.012 140);
  }
  .chevron {
    font-size: 10px; color: oklch(0.45 0.01 140); margin-left: auto; flex-shrink: 0;
  }
  .collapsible-body {
    display: none; overflow: hidden;
  }
  .collapsible-body.expanded { display: block; }
  .tool-pre {
    font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
    font-size: 12px; line-height: 1.5; color: oklch(0.80 0.008 140);
    background: oklch(0.18 0.006 145); border-radius: 6px;
    padding: 10px 12px; margin: 4px 8px 8px 30px;
    white-space: pre-wrap; word-break: break-all;
    max-height: 500px; overflow-y: auto;
    border: 1px solid oklch(0.27 0.010 145);
  }

  /* Tool result status */
  .tool-result-label {
    font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
    font-size: 13px; color: oklch(0.65 0.012 140);
  }
  .status-ok { color: oklch(0.72 0.19 145); font-weight: 600; }
  .status-err { color: oklch(0.63 0.24 25); font-weight: 600; }

  /* Event dividers */
  .event-divider {
    display: flex; align-items: center; gap: 12px; padding: 12px 0; color: oklch(0.40 0.01 140); font-size: 11px;
  }
  .event-divider::before, .event-divider::after {
    content: ''; flex: 1; height: 1px; background: oklch(0.28 0.010 145);
  }

  /* Empty / loading states */
  .empty { padding: 48px; text-align: center; color: oklch(0.50 0.012 140); font-size: 14px; }
  .error { color: oklch(0.63 0.24 25); }

  /* Light mode */
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; }
    body { background: oklch(0.99 0.004 140); color: oklch(0.16 0.01 140); }
    .header { background: oklch(0.97 0.004 140); border-bottom-color: oklch(0.91 0.008 140); }
    .header .meta, .header a { color: oklch(0.55 0.01 140); }
    .header a { border-color: oklch(0.91 0.008 140); }
    .collapsible-hdr { color: oklch(0.45 0.01 140); }
    .collapsible-hdr:hover { background: oklch(0.96 0.006 140); }
    .tool-name { color: oklch(0.45 0.01 140); }
    .tool-summary { color: oklch(0.60 0.01 140); }
    .tool-pre { background: oklch(0.97 0.004 140); border-color: oklch(0.91 0.008 140); color: oklch(0.25 0.01 140); }
    .cost { color: oklch(0.55 0.01 140); }
    .event-divider { color: oklch(0.70 0.01 140); }
    .event-divider::before, .event-divider::after { background: oklch(0.91 0.008 140); }
  }
</style>
</head>
<body>
<div class="header">
  <h1>Delegate Log</h1>
  <span class="meta" id="meta"></span>
  <a href="${rawUrl}" target="_blank">raw</a>
</div>
<div class="messages" id="messages">
  <div class="empty">Loading log…</div>
</div>
<script>
${script}
</script>
</body>
</html>`;
}
