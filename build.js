const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const hljs = require('highlight.js');

// --- marked: highlight.js for fenced code blocks + heading IDs ---
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
renderer.heading = function (text, level) {
  const id = text.replace(/<[^>]*>/g, '').toLowerCase()
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  return `<h${level} id="${id}">${text}</h${level}>`;
};
marked.use({ renderer });

// --- site config ---
const SITE_TITLE = 'Haziq Zikry';
const SITE_DESCRIPTION = 'Notes from a data platform engineer.';
const SITE_URL = 'https://haziqzikry.xyz';

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

function readTime(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

function extractHeadings(html) {
  const headings = [];
  const re = /<h([23]) id="([^"]+)">(.*?)<\/h[23]>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    headings.push({
      level: parseInt(m[1]),
      id: m[2],
      text: m[3].replace(/<[^>]*>/g, ''),
    });
  }
  return headings;
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
      readTime: readTime(content),
      isBundle,
      html: marked.parse(content),
    });
  }

  posts.sort((a, b) => b.date - a.date);
  return posts;
}

// --- templates ---
function baseLayout(title, content, sidebar = null) {
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
    .prose table { display: block; overflow-x: auto; }
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

  <main class="${sidebar ? 'max-w-6xl' : 'max-w-2xl'} mx-auto w-full px-6 flex-1 mt-10">
    ${sidebar ? `
    <div class="flex gap-16 items-start">
      <div class="flex-1 min-w-0">${content}</div>
      <aside class="w-52 shrink-0 hidden xl:block">
        <div class="sticky top-28">${sidebar}</div>
      </aside>
    </div>` : content}
  </main>

  <footer class="max-w-2xl mx-auto w-full px-6 py-8 text-sm text-gray-500 dark:text-gray-400 flex items-center justify-between">
    <span>&copy; ${new Date().getFullYear()} ${escapeHtml(SITE_TITLE)}</span>
    <div class="flex items-center gap-4">
      <a href="https://github.com/haziqzikry" aria-label="GitHub" class="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
      </a>
      <a href="https://linkedin.com/in/haziqzikry" aria-label="LinkedIn" class="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
      </a>
    </div>
  </footer>
</body>
</html>`;
}

function postListItem(post) {
  return `<li class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
      <time class="text-sm text-gray-500 dark:text-gray-400 shrink-0" datetime="${post.date.toISOString()}">${formatDateShort(post.date)}</time>
      <span class="flex items-baseline gap-2">
        <a href="/posts/${post.slug}/" class="hover:opacity-75 transition-opacity">${escapeHtml(post.title)}</a>
        <span class="text-xs text-gray-400 dark:text-gray-500 shrink-0">${post.readTime} min read</span>
      </span>
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
    <div class="flex flex-col-reverse sm:flex-row sm:items-start gap-8">
      <div class="prose prose-gray dark:prose-invert max-w-none flex-1">
        ${homeHtml}
      </div>
      <div class="w-44 h-44 rounded-full overflow-hidden shrink-0 sm:mt-1 self-center sm:self-auto">
        <img src="/images/haziq-pic.jpg" alt="Haziq Zikry"
             class="w-full h-full object-cover object-top scale-125" />
      </div>
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

function buildMobileToc(headings) {
  const links = headings.map(h => `
    <a href="#${h.id}" @click="open = false"
       class="block text-sm leading-snug py-0.5 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors ${h.level === 3 ? 'pl-3' : ''}"
    >${escapeHtml(h.text)}</a>`).join('');

  return `
    <div class="xl:hidden mb-8 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3"
         x-data="{ open: false }">
      <button @click="open = !open"
              class="flex items-center justify-between w-full text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        <span>On this page</span>
        <svg :class="{ 'rotate-180': open }" class="h-4 w-4 transition-transform duration-200"
             xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <nav x-show="open" x-transition class="mt-3 border-l border-gray-200 dark:border-gray-700 pl-3 space-y-0.5">
        ${links}
      </nav>
    </div>`;
}

function buildToc(headings) {
  const items = JSON.stringify(headings);
  const links = headings.map(h => `
    <a href="#${h.id}"
       :class="active === '${h.id}' ? 'text-gray-900 dark:text-gray-100 font-medium' : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
       class="block text-sm transition-colors leading-snug py-0.5 ${h.level === 3 ? 'pl-3' : ''}"
    >${escapeHtml(h.text)}</a>`).join('');

  return `
    <div x-data='{active: null, items: ${items}}'
         x-init="
           const obs = new IntersectionObserver(es => {
             es.forEach(e => { if (e.isIntersecting) active = e.target.id; });
           }, { rootMargin: '-10% 0px -80% 0px' });
           items.forEach(h => { const el = document.getElementById(h.id); if (el) obs.observe(el); });
         ">
      <p class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">On this page</p>
      <nav class="space-y-0.5 border-l border-gray-200 dark:border-gray-700 pl-3">
        ${links}
      </nav>
    </div>`;
}

function postPage(post) {
  const tags = post.tags.length
    ? `<div class="flex flex-wrap gap-2 mb-8">${post.tags.map(t => `<span class="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const headings = extractHeadings(post.html);
  const mobileToc = headings.length >= 3 ? buildMobileToc(headings) : '';

  const body = `
    <article>
      <header class="mb-8">
        <h1 class="text-2xl font-semibold mb-2">${escapeHtml(post.title)}</h1>
        <div class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <time datetime="${post.date.toISOString()}">${formatDate(post.date)}</time>
          <span>&middot;</span>
          <span>${post.readTime} min read</span>
        </div>
      </header>
      ${tags}
      ${mobileToc}
      <div class="prose prose-gray dark:prose-invert max-w-none
        prose-headings:font-semibold
        prose-code:before:content-none prose-code:after:content-none
        prose-code:bg-gray-100 prose-code:dark:bg-gray-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
        prose-img:rounded-lg">
        ${post.html}
      </div>
    </article>
  `;

  const sidebar = headings.length >= 3 ? buildToc(headings) : null;
  return baseLayout(post.title, body, sidebar);
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
