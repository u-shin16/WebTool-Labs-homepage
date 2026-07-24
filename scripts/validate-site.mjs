import { readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const htmlOnly = args.has("--html-only");
const linksOnly = args.has("--links-only");
const checkExternal = args.has("--external");
const siteOrigin = "https://webtool-labs.com";
const adsenseLoaderPages = new Set(["index.html"]);
const errors = [];
const warnings = [];
const execFileAsync = promisify(execFile);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile() && extname(entry.name) === ".html") files.push(fullPath);
  }
  return files;
}

function matches(html, pattern) {
  return [...html.matchAll(pattern)];
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2] ?? "") : null;
}

function plainText(value) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localFileFor(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = posix.normalize(decoded);
  const relativePath = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  return resolve(root, relativePath.endsWith("/") || relativePath === "" ? join(relativePath, "index.html") : relativePath);
}

function report(file, message) {
  errors.push(`${relative(root, file)}: ${message}`);
}

async function fetchStatusWithCurl(url) {
  const { stdout } = await execFileAsync("curl", [
    "-L",
    "-sS",
    "-o", "/dev/null",
    "-w", "%{http_code}",
    "--max-time", "20",
    url
  ]);
  const status = Number(stdout.trim());
  if (!Number.isInteger(status) || status < 100) {
    throw new Error(`HTTPステータスを取得できませんでした: ${stdout.trim() || "empty"}`);
  }
  return status;
}

const htmlFiles = (await walk(root)).sort();
const pages = new Map();
const titles = new Map();
const descriptions = new Map();
const canonicals = new Map();
const externalUrls = new Set();

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  const rel = relative(root, file).split(sep).join("/");
  const ids = new Set(matches(html, /\sid=(?:"([^"]+)"|'([^']+)')/gi).map((match) => match[1] ?? match[2]));
  pages.set(file, { html, ids, rel });

  if (!linksOnly) {
    const hasAdsenseLoader = /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i.test(html);
    if (adsenseLoaderPages.has(rel) && !hasAdsenseLoader) {
      report(file, "トップページにAdSenseローダーがありません");
    }
    if (!adsenseLoaderPages.has(rel) && hasAdsenseLoader) {
      report(file, "AdSenseローダーはトップページ以外に設置しない方針です");
    }

    if (!/^\s*<!doctype html>/i.test(html)) report(file, "DOCTYPEがありません");
    if (!/<html[^>]*\slang=["']ja["']/i.test(html)) report(file, 'html lang="ja" がありません');

    const title = matches(html, /<title>([\s\S]*?)<\/title>/gi);
    if (title.length !== 1 || !plainText(title[0][1])) report(file, "固有のtitleが1件必要です");
    else {
      const value = plainText(title[0][1]);
      if (titles.has(value)) report(file, `titleが ${titles.get(value)} と重複しています`);
      titles.set(value, rel);
    }

    const descriptionTag = matches(html, /<meta\b[^>]*\bname=["']description["'][^>]*>/gi)[0]?.[0];
    const description = descriptionTag ? attr(descriptionTag, "content") : "";
    if (!description) report(file, "meta descriptionがありません");
    else {
      if (descriptions.has(description)) report(file, `descriptionが ${descriptions.get(description)} と重複しています`);
      descriptions.set(description, rel);
    }

    const canonicalTag = matches(html, /<link\b[^>]*\brel=["']canonical["'][^>]*>/gi)[0]?.[0];
    const canonical = canonicalTag ? attr(canonicalTag, "href") : "";
    if (!canonical || !canonical.startsWith(`${siteOrigin}/`)) report(file, "正規ドメインのcanonicalがありません");
    else {
      if (canonicals.has(canonical)) report(file, `canonicalが ${canonicals.get(canonical)} と重複しています`);
      canonicals.set(canonical, rel);
    }

    const h1s = matches(html, /<h1\b[^>]*>[\s\S]*?<\/h1>/gi);
    if (h1s.length !== 1 || !plainText(h1s[0][0])) report(file, "内容のあるh1が1件必要です");
    const headingLevels = matches(html, /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi).map((match) => Number(match[1]));
    for (let index = 1; index < headingLevels.length; index += 1) {
      if (headingLevels[index] - headingLevels[index - 1] > 1) {
        report(file, `見出しレベルがh${headingLevels[index - 1]}からh${headingLevels[index]}へ飛んでいます`);
      }
    }
    if (!/<meta\b[^>]*\bname=["']robots["'][^>]*>/i.test(html)) report(file, "robots metaがありません");
    if (!/<link\b[^>]*\brel=["']icon["'][^>]*>/i.test(html)) report(file, "favicon指定がありません");

    const noindex = /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["'][^"']*noindex/i.test(html);
    if (!noindex) {
      for (const key of ["og:title", "og:description", "og:url", "og:image"]) {
        if (!new RegExp(`<meta\\b[^>]*\\bproperty=["']${key}["'][^>]*\\bcontent=`, "i").test(html)) {
          report(file, `${key} がありません`);
        }
      }
      for (const key of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
        if (!new RegExp(`<meta\\b[^>]*\\bname=["']${key}["'][^>]*\\bcontent=`, "i").test(html)) {
          report(file, `${key} がありません`);
        }
      }
      if (!/<meta\b[^>]*\bname=["']google-adsense-account["'][^>]*>/i.test(html)) {
        report(file, "google-adsense-account metaがありません");
      }
    }

    const seenIds = new Set();
    for (const id of matches(html, /\sid=(?:"([^"]+)"|'([^']+)')/gi).map((match) => match[1] ?? match[2])) {
      if (seenIds.has(id)) report(file, `id="${id}" が重複しています`);
      seenIds.add(id);
    }

    for (const image of matches(html, /<img\b[^>]*>/gi).map((match) => match[0])) {
      if (attr(image, "alt") === null) report(file, `altのない画像があります: ${image}`);
      if (!attr(image, "width") || !attr(image, "height")) report(file, `width/heightのない画像があります: ${image}`);
    }

    for (const anchor of matches(html, /<a\b[^>]*\btarget=["']_blank["'][^>]*>/gi).map((match) => match[0])) {
      const relValue = attr(anchor, "rel") || "";
      if (!relValue.includes("noopener") || !relValue.includes("noreferrer")) {
        report(file, `target="_blank" のリンクにnoopener noreferrerがありません`);
      }
    }

    const structuredTypes = new Set();
    for (const script of matches(html, /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(script[1]);
        if (data?.["@type"]) structuredTypes.add(data["@type"]);
        if (data?.["@type"] === "FAQPage") {
          const visibleFaq = new Map(matches(html, /<details\b[^>]*class=["'][^"']*faq-item[^"']*["'][^>]*>[\s\S]*?<summary\b[^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/summary>[\s\S]*?<p\b[^>]*class=["'][^"']*faq-answer[^"']*["'][^>]*>([\s\S]*?)<\/p>[\s\S]*?<\/details>/gi)
            .map((match) => [plainText(match[1]), plainText(match[2])]));
          for (const entity of data.mainEntity || []) {
            const answer = visibleFaq.get(entity?.name);
            if (!answer) report(file, `FAQ構造化データの質問が本文にありません: ${entity?.name}`);
            else if (answer.replace(/\s/g, "") !== plainText(entity?.acceptedAnswer?.text || "").replace(/\s/g, "")) {
              report(file, `FAQ構造化データの回答が本文と一致しません: ${entity?.name}`);
            }
          }
        }
      } catch (error) {
        report(file, `JSON-LDが不正です: ${error.message}`);
      }
    }
    if (!noindex && rel !== "index.html" && !structuredTypes.has("BreadcrumbList")) {
      report(file, "BreadcrumbList構造化データがありません");
    }
    if (rel.startsWith("services/") && rel !== "services/index.html" && !structuredTypes.has("SoftwareApplication")) {
      report(file, "SoftwareApplication構造化データがありません");
    }
    if (rel === "index.html") {
      for (const type of ["WebSite", "Organization", "FAQPage"]) {
        if (!structuredTypes.has(type)) report(file, `${type}構造化データがありません`);
      }
    }
  }
}

if (!htmlOnly) {
  for (const [file, page] of pages) {
    const references = [
      ...matches(page.html, /<(?:a|link)\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)')[^>]*>/gi)
        .map((match) => ({ value: match[1] ?? match[2], kind: "href" })),
      ...matches(page.html, /<(?:img|script)\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)')[^>]*>/gi)
        .map((match) => ({ value: match[1] ?? match[2], kind: "src" }))
    ];

    for (const reference of references) {
      if (!reference.value || /^(mailto:|tel:|javascript:|data:)/i.test(reference.value)) continue;
      let url;
      try {
        const pageUrl = page.rel === "index.html" ? `${siteOrigin}/` : `${siteOrigin}/${page.rel}`;
        url = new URL(reference.value, pageUrl);
      } catch {
        report(file, `URLが不正です: ${reference.value}`);
        continue;
      }

      if (url.origin !== siteOrigin) {
        if (reference.kind === "href" && /^https?:$/i.test(url.protocol)) externalUrls.add(url.href);
        continue;
      }

      const target = localFileFor(url.pathname);
      try {
        const targetStat = await stat(target);
        if (!targetStat.isFile()) report(file, `リンク先がファイルではありません: ${reference.value}`);
      } catch {
        report(file, `ローカルリンク切れ: ${reference.value}`);
        continue;
      }

      if (url.hash && extname(target) === ".html") {
        const targetPage = pages.get(target);
        const fragment = decodeURIComponent(url.hash.slice(1));
        if (!targetPage?.ids.has(fragment)) report(file, `アンカーがありません: ${reference.value}`);
      }
    }
  }

  if (!linksOnly) {
    const sitemapPath = join(root, "sitemap.xml");
    const sitemap = await readFile(sitemapPath, "utf8");
    const sitemapUrls = new Set(matches(sitemap, /<loc>([^<]+)<\/loc>/gi).map((match) => match[1].trim()));
    for (const [canonical, rel] of canonicals) {
      const html = pages.get(resolve(root, rel))?.html || "";
      const noindex = /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["'][^"']*noindex/i.test(html);
      if (noindex && sitemapUrls.has(canonical)) errors.push(`sitemap.xml: noindexページを含んでいます: ${canonical}`);
      if (!noindex && !sitemapUrls.has(canonical)) errors.push(`sitemap.xml: index対象ページがありません: ${canonical}`);
    }
    for (const url of sitemapUrls) {
      if (!canonicals.has(url)) errors.push(`sitemap.xml: 対応するHTMLがありません: ${url}`);
    }
  }

  const robots = await readFile(join(root, "robots.txt"), "utf8");
  if (!robots.includes(`Sitemap: ${siteOrigin}/sitemap.xml`)) errors.push("robots.txt: sitemap指定がありません");
}

if (checkExternal) {
  for (const url of [...externalUrls].sort()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
      if ([403, 405].includes(response.status)) {
        response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
      }
      if (response.status >= 400) errors.push(`外部リンク ${url}: HTTP ${response.status}`);
      else console.log(`OK ${response.status} ${url}`);
    } catch (error) {
      try {
        const status = await fetchStatusWithCurl(url);
        if (status >= 400) errors.push(`外部リンク ${url}: HTTP ${status}（curl再確認）`);
        else console.log(`OK ${status} ${url}（curl再確認）`);
      } catch (curlError) {
        errors.push(`外部リンク ${url}: fetch=${error.message}; curl=${curlError.message}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  console.error(`\n${errors.length}件の問題が見つかりました。`);
  process.exitCode = 1;
} else {
  console.log(`${htmlFiles.length}ページの${linksOnly ? "リンク" : htmlOnly ? "HTML構造" : "HTML構造・内部リンク・sitemap"}を確認しました。`);
}
