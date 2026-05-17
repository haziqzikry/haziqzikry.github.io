---
title: "Hello, world"
date: 2026-05-17
summary: "First post — kicking the tires on this site."
tags: [meta]
---

This is the first post on my new site. It's a placeholder to confirm that
markdown renders, code blocks highlight, and images load.

## Markdown works

Paragraphs, **bold**, *italic*, [links](https://example.com), and lists:

- One
- Two
- Three

## Code blocks highlight

```python
def greet(name: str) -> str:
    return f"hello, {name}"

print(greet("world"))
```

```sql
select count(*)
from events
where event_date >= current_date - interval '7' day;
```

## Images render

Drop an image into the same folder as this `index.md` and reference it with
a plain relative path:

```markdown
![alt text](screenshot.png)
```

That's it — no upload step, no CDN.
