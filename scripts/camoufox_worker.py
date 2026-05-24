#!/usr/bin/env python3
"""
KAI web browsing worker — renders a URL and extracts text.

Usage:
  python camoufox_worker.py browse <url>
  python camoufox_worker.py search <query>

Output: JSON on stdout with { "ok": true, "text": "..." } or { "ok": false, "error": "..." }

Requires: pip install camoufox playwright
          playwright install firefox
"""

import json
import sys
import re

def clean_html_to_text(html: str) -> str:
    """Extract readable text from HTML, stripping tags and excess whitespace."""
    # Remove script/style blocks
    html = re.sub(r'<(script|style|noscript)[^>]*>.*?</\1>', '', html, flags=re.DOTALL | re.IGNORECASE)
    # Remove HTML tags
    text = re.sub(r'<[^>]+>', ' ', html)
    # Decode common entities
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&nbsp;', ' ').replace('&quot;', '"')
    # Collapse whitespace
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n\s*\n', '\n\n', text)
    return text.strip()


def browse(url: str) -> dict:
    """Render a URL with Camoufox and extract text."""
    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        # Fallback: try basic HTTP fetch without browser rendering
        try:
            import urllib.request
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
            text = clean_html_to_text(html)
            return {"ok": True, "text": text[:50000], "method": "http"}
        except Exception as e:
            return {"ok": False, "error": f"camoufox not installed and HTTP fallback failed: {e}"}

    try:
        with Camoufox(headless=True) as browser:
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            # Wait a bit for JS to render
            page.wait_for_timeout(2000)
            text = page.inner_text("body")
            page.close()
        return {"ok": True, "text": text[:50000], "method": "camoufox"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def search(query: str) -> dict:
    """Search DuckDuckGo and return results."""
    try:
        import urllib.request
        import urllib.parse
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # Extract result blocks
        results = []
        # DuckDuckGo HTML results are in <a class="result__a"> tags
        for match in re.finditer(r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', html, re.DOTALL):
            link = match.group(1)
            title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
            if title and link:
                results.append({"title": title, "url": link})

        # Extract snippets
        snippets = re.findall(r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', html, re.DOTALL)
        for i, snip in enumerate(snippets):
            if i < len(results):
                results[i]["snippet"] = re.sub(r'<[^>]+>', '', snip).strip()

        return {"ok": True, "results": results[:10], "query": query}
    except Exception as e:
        return {"ok": False, "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: camoufox_worker.py <browse|search> <url|query>"}))
        sys.exit(1)

    action = sys.argv[1]
    arg = " ".join(sys.argv[2:])

    if action == "browse":
        result = browse(arg)
    elif action == "search":
        result = search(arg)
    else:
        result = {"ok": False, "error": f"Unknown action: {action}"}

    print(json.dumps(result, ensure_ascii=False))
