const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const hljs = require('highlight.js');

// --- marked: highlight.js for fenced code blocks ---
const renderer = new marked.Renderer();
renderer.code = function (code, lang) {
  lang = (lang || '').split(/\s/)[0];
  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(code, { language: lang }).value;
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }
  return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
};
marked.use({ renderer });

// --- site config ---
const SITE_TITLE = 'Haziq Zikry';
const SITE_DESCRIPTION = 'Notes from a data platform engineer.';
const SITE_URL = 'https://haziqzikry.github.io';

const ROOT = __dirname;
const CONTENT_DIR = path.join(ROOT, 'content');
const POSTS_DIR = path.join(CONTENT_DIR, 'posts');
const STATIC_DIR = path.join(ROOT, 'static');
const PUBLIC_DIR = path.join(ROOT, 'public');

// --- helpers ---
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dest, { skipMd = false } = {}) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipMd && entry.isFile() && entry.name.endsWith('.md')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath, { skipMd });
    else fs.copyFileSync(srcPath, destPath);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function formatDateShort(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function readMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return matter(raw);
}

// --- content loaders ---
function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];

  const entries = fs.readdirSync(POSTS_DIR, { withFileTypes: true });
  const posts = [];

  for (const entry of entries) {
    let slug, filePath, isBundle;

    if (entry.isFile() && entry.name.endsWith('.md')) {
      // flat file: content/posts/my-post.md → slug = my-post
      slug = entry.name.slice(0, -3);
      filePath = path.join(POSTS_DIR, entry.name);
      isBundle = false;
    } else if (entry.isDirectory()) {
      // page bundle: content/posts/my-post/index.md
      const indexPath = path.join(POSTS_DIR, entry.name, 'index.md');
      if (!fs.existsSync(indexPath)) continue;
      slug = entry.name;
      filePath = indexPath;
      isBundle = true;
    } else {
      continue;
    }

    const { data, content } = readMarkdown(filePath);
    if (data.draft === true) continue;
    posts.push({
      slug,
      title: data.title || slug,
      date: data.date ? new Date(data.date) : new Date(0),
      summary: data.summary || '',
      tags: data.tags || [],
      isBundle,
      html: marked.parse(content),
    });
  }

  posts.sort((a, b) => b.date - a.date);
  return posts;
}

// --- templates ---
function baseLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="en"
  x-data="{ dark: localStorage.getItem('dark') === 'true' }"
  x-init="$watch('dark', v => { localStorage.setItem('dark', v); document.getElementById('hljs-light').disabled = v; document.getElementById('hljs-dark').disabled = !v; }); document.getElementById('hljs-light').disabled = dark; document.getElementById('hljs-dark').disabled = !dark;"
  :class="{ 'dark': dark }">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}">
  <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
  <script>
    tailwind.config = { darkMode: 'class', theme: { extend: {} } };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script defer src="https://instant.page/5.2.0" type="module"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" id="hljs-light">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" id="hljs-dark" disabled>
  <style>
    .prose pre { @apply rounded-lg overflow-x-auto; max-width: 100%; }
    .prose pre code { font-size: 0.875em; white-space: pre; word-wrap: normal; overflow-wrap: normal; }
    .prose pre { padding: 0 !important; background-color: transparent !important; }
    .prose pre code.hljs { color: #24292e; background: #f6f8fa; display: block; padding: 1em; border-radius: 0.5rem; }
    .dark .prose pre code.hljs { color: #c9d1d9; background: #0d1117; }
    .prose img { @apply rounded-lg mx-auto; }
    .prose a { @apply underline decoration-gray-400 dark:decoration-gray-500 underline-offset-2 hover:decoration-gray-800 dark:hover:decoration-gray-200 transition-colors; }
  </style>
</head>
<body class="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors duration-200 min-h-screen flex flex-col text-base lg:text-lg">
  <header class="sticky top-0 z-10 backdrop-blur-sm bg-white/90 dark:bg-gray-900/90 border-b border-gray-100 dark:border-gray-800">
  <div class="max-w-2xl mx-auto w-full px-6 py-6 flex items-center justify-between">
    <a href="/" class="text-lg font-semibold hover:opacity-75 transition-opacity">${escapeHtml(SITE_TITLE)}</a>
    <nav class="flex items-center gap-6">
      <a href="/about/" class="hover:opacity-75 transition-opacity">About</a>
      <a href="/posts/" class="hover:opacity-75 transition-opacity">Posts</a>
      <button @click="dark = !dark" class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors" aria-label="Toggle dark mode">
        <svg x-show="!dark" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
        <svg x-show="dark" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
      </button>
    </nav>
  </div>
  </header>

  <main class="max-w-2xl mx-auto w-full px-6 flex-1 mt-10">
    ${content}
  </main>

  <footer class="max-w-2xl mx-auto w-full px-6 py-8 text-sm text-gray-500 dark:text-gray-400">
    <span>&copy; ${new Date().getFullYear()} ${escapeHtml(SITE_TITLE)}</span>
  </footer>
</body>
</html>`;
}

function postListItem(post) {
  return `<li class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
      <time class="text-sm text-gray-500 dark:text-gray-400 shrink-0" datetime="${post.date.toISOString()}">${formatDateShort(post.date)}</time>
      <a href="/posts/${post.slug}/" class="hover:opacity-75 transition-opacity">${escapeHtml(post.title)}</a>
    </li>`;
}

function homePage(homeHtml, posts) {
  const latest = posts.slice(0, 5);
  const latestSection = latest.length === 0 ? '' : `
    <section class="mt-12">
      <h2 class="text-xl font-semibold mb-6">Latest posts</h2>
      <ul class="space-y-3 mb-6">
        ${latest.map(postListItem).join('\n        ')}
      </ul>
      <a href="/posts/" class="text-sm hover:opacity-75 transition-opacity">View all &rarr;</a>
    </section>`;

  const body = `
    <div class="prose prose-gray dark:prose-invert max-w-none">
      ${homeHtml}
    </div>
    ${latestSection}
  `;
  return baseLayout(SITE_TITLE, body);
}

function aboutPage(aboutHtml, title) {
  const body = `
    <div class="prose prose-gray dark:prose-invert max-w-none">
      ${aboutHtml}
    </div>
  `;
  return baseLayout(title, body);
}

function postsListPage(posts) {
  const body = `
    <h1 class="text-2xl font-semibold mb-8">Posts</h1>
    <ul class="space-y-3">
      ${posts.map(postListItem).join('\n      ')}
    </ul>
  `;
  return baseLayout('Posts', body);
}

function postPage(post) {
  const tags = post.tags.length
    ? `<div class="flex flex-wrap gap-2 mb-8">${post.tags.map(t => `<span class="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const body = `
    <article>
      <header class="mb-8">
        <h1 class="text-2xl font-semibold mb-2">${escapeHtml(post.title)}</h1>
        <time class="text-sm text-gray-500 dark:text-gray-400" datetime="${post.date.toISOString()}">${formatDate(post.date)}</time>
      </header>
      ${tags}
      <div class="prose prose-gray dark:prose-invert max-w-none
        prose-headings:font-semibold
        prose-code:before:content-none prose-code:after:content-none
        prose-code:bg-gray-100 prose-code:dark:bg-gray-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
        prose-img:rounded-lg">
        ${post.html}
      </div>
    </article>
  `;
  return baseLayout(post.title, body);
}

// --- build ---
function build() {
  console.log('Building site...');

  // Clean public/
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  ensureDir(PUBLIC_DIR);

  // Copy site-wide static assets (favicon, /images/*, etc.)
  copyDirSync(STATIC_DIR, PUBLIC_DIR);

  // Load posts
  const posts = loadPosts();
  console.log(`Found ${posts.length} post(s).`);

  // Home page (from content/home.md)
  const home = readMarkdown(path.join(CONTENT_DIR, 'home.md'));
  fs.writeFileSync(
    path.join(PUBLIC_DIR, 'index.html'),
    homePage(marked.parse(home.content), posts),
  );

  // About page (from content/about.md)
  const about = readMarkdown(path.join(CONTENT_DIR, 'about.md'));
  ensureDir(path.join(PUBLIC_DIR, 'about'));
  fs.writeFileSync(
    path.join(PUBLIC_DIR, 'about', 'index.html'),
    aboutPage(marked.parse(about.content), about.data.title || 'About'),
  );

  // Posts list page
  ensureDir(path.join(PUBLIC_DIR, 'posts'));
  fs.writeFileSync(
    path.join(PUBLIC_DIR, 'posts', 'index.html'),
    postsListPage(posts),
  );

  // Individual posts
  for (const post of posts) {
    const destDir = path.join(PUBLIC_DIR, 'posts', post.slug);
    ensureDir(destDir);
    if (post.isBundle) {
      // copy images and other assets from the post folder
      copyDirSync(path.join(POSTS_DIR, post.slug), destDir, { skipMd: true });
    }
    fs.writeFileSync(path.join(destDir, 'index.html'), postPage(post));
  }

  console.log('Build complete -> public/');
}

build();
