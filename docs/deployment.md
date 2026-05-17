# Deployment

## How it works

Pushing to `main` triggers a GitHub Actions workflow (`.github/workflows/pages.yml`) that:
1. Runs `node build.js` to generate `public/`
2. Uploads `public/` to GitHub Pages via `actions/deploy-pages`

Live at **https://haziqzikry.xyz** (~30s after push).

## Day-to-day: adding a post

```bash
# scaffold a new post
make new-post SLUG=my-post-name

# edit it
$EDITOR content/posts/my-post-name.md

# preview locally
make serve          # http://localhost:8000

# push — deploys automatically
git add content/posts/my-post-name.md
git commit -m "post: my post name"
git push
```

For posts with images, use a folder instead of a flat file:

```
content/posts/my-post-name/
  index.md
  screenshot.png    # reference in markdown as ![](screenshot.png)
```

## Custom domain setup (haziqzikry.xyz)

Domain bought on **Porkbun**, DNS powered by Cloudflare.

### DNS records (set in Porkbun)

| Type  | Host | Value                  |
|-------|------|------------------------|
| A     | @    | 185.199.108.153        |
| A     | @    | 185.199.109.153        |
| A     | @    | 185.199.110.153        |
| A     | @    | 185.199.111.153        |
| CNAME | www  | haziqzikry.github.io  |

### GitHub Pages settings

- Repo **Settings → Pages → Custom domain**: `haziqzikry.xyz`
- **Enforce HTTPS**: enabled (Let's Encrypt cert, auto-renewed)

`static/CNAME` contains `haziqzikry.xyz` so the build always includes it in `public/`.

## Re-deploying manually

If the workflow fails or you need to force a redeploy:

```bash
gh workflow run pages.yml
# or just make an empty commit:
git commit --allow-empty -m "chore: redeploy" && git push
```

## Local build only (no server)

```bash
make build          # outputs to public/
```
