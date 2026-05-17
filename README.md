# hz-portfolio

Personal site + blog at [haziqzikry.xyz](https://haziqzikry.xyz).

## Adding a post

Drop a `.md` file into `content/posts/` and push.

```bash
$EDITOR content/posts/my-post.md
make serve              # preview at http://localhost:8000
git add content/posts/my-post.md && git commit -m "post: ..." && git push
```

For posts with images, use a folder instead:

```
content/posts/my-post/
  index.md
  screenshot.png        # reference as ![](screenshot.png)
```

## Frontmatter

```yaml
---
title: "Post title"
date: 2026-05-17
tags: [data, tools]
draft: false
---
```

## Commands

| Command | What it does |
|---|---|
| `make serve` | build + watch + serve at localhost:8000 |
| `make build` | one-off build into `public/` |
| `make new-post SLUG=foo` | scaffold `content/posts/foo.md` |
| `make install` | install npm deps |
