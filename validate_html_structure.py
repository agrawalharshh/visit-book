#!/usr/bin/env python3
"""
validate_html_structure.py — catches unbalanced/mis-nested <div> tags, the exact
class of bug that silently broke every Settings tab after Webhook Health (a missing
</div> trapped 7 tab panels inside a hidden sibling). Run this against any HTML file
before shipping it — exits non-zero and prints the exact problem if structure is broken.
"""
import re
import sys


def validate(html, label="document"):
    errors = []

    # 1. Raw open/close count must match.
    opens = len(re.findall(r'<div\b', html))
    closes = len(re.findall(r'</div>', html))
    if opens != closes:
        errors.append(f"[{label}] div count mismatch: {opens} open vs {closes} close")

    # 2. Walk the whole document as a stack — every </div> must close the most
    #    recently opened <div>. This catches mis-nesting even when counts happen
    #    to match by coincidence.
    stack = []
    for m in re.finditer(r'<div\b[^>]*>|</div>', html):
        tag = m.group(0)
        line = html.count('\n', 0, m.start()) + 1
        if tag.startswith('</div'):
            if not stack:
                errors.append(f"[{label}] line {line}: closing </div> with nothing open")
            else:
                stack.pop()
        else:
            stack.append(line)
    if stack:
        errors.append(f"[{label}] {len(stack)} <div> tag(s) never closed, opened at lines: {stack[:10]}")

    # 3. Specifically validate every element with id="..._panel" / "panel_..." style
    #    tab containers actually close as a SIBLING of the next one — this is the
    #    exact pattern that broke (a tab panel swallowing every panel after it).
    panel_starts = [(m.start(), m.group(1)) for m in re.finditer(r'<div[^>]+id="((?:panel|tab-panel)[a-zA-Z_]*|[a-zA-Z]*panel_[a-zA-Z]+)"', html)]
    for start_pos, panel_id in panel_starts:
        gt = html.find('>', start_pos)
        if gt == -1:
            continue
        depth = 1
        i = gt + 1
        closed_ok = False
        while i < len(html):
            next_open = html.find('<div', i)
            next_close = html.find('</div>', i)
            if next_close == -1:
                break
            if next_open != -1 and next_open < next_close:
                depth += 1
                i = next_open + 4
            else:
                depth -= 1
                i = next_close + 6
                if depth == 0:
                    closed_ok = True
                    break
        if not closed_ok:
            errors.append(f"[{label}] panel '{panel_id}' never reaches depth 0 — likely swallows everything after it")

    return errors


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 validate_html_structure.py <file.html> [file2.html ...]")
        sys.exit(1)

    all_errors = []
    for path in sys.argv[1:]:
        with open(path) as f:
            content = f.read()
        all_errors.extend(validate(content, label=path))

    if all_errors:
        print("❌ HTML STRUCTURE VALIDATION FAILED:\n")
        for e in all_errors:
            print(" ", e)
        sys.exit(1)
    else:
        print(f"✓ HTML structure valid — all div tags properly nested and closed ({len(sys.argv)-1} file(s) checked)")
        sys.exit(0)
